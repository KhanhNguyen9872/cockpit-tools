//! Inspect only the bounded pre-output handshake. Never replay generated output.
use super::{
    contract::ExecutionPolicy, contract::ServiceError, events::SseDecoder,
    lifecycle::stopping_error, server::AppState,
};
use axum::http::{header, StatusCode};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) const MAX_EVENTS: usize = 16;
pub(super) const MAX_BYTES: usize = 64 << 10;
// A peer may wait for an interrupt after response.created. Never hide its ID
// indefinitely while waiting for a second event.
pub(super) const MAX_HOLD: std::time::Duration = std::time::Duration::from_millis(250);

pub(super) fn handshake(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some(
            "response.created"
                | "response.in_progress"
                | "codex.rate_limits"
                | "codex.response.metadata"
        )
    )
}

/// Structured input faults take precedence over contradictory capacity hints.
pub(super) fn rejection(event: &Value) -> Option<(u16, Value)> {
    if event["type"] == "response.incomplete"
        && event
            .pointer("/response/incomplete_details/reason")
            .and_then(Value::as_str)
            != Some("interrupted")
        && event
            .pointer("/response/output")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        && event
            .pointer("/response/usage/output_tokens")
            .and_then(Value::as_u64)
            == Some(0)
    {
        return Some((
            502,
            json!({"error":{"code":"empty_incomplete_stream",
            "message":"Upstream terminated with an incomplete empty response (0 tokens)"}}),
        ));
    }
    if !matches!(
        event.get("type").and_then(Value::as_str),
        Some("error" | "response.error" | "response.failed")
    ) {
        return None;
    }
    // A generic invalid_request_error may carry a contradictory capacity hint.
    // Classify its real status/body before synthesizing a retryable HTTP status.
    if super::upstream_errors::chat_failure(event, 502)
        .is_some_and(|error| super::upstream_errors::request_fault(error.status, event))
    {
        return None;
    }
    if event
        .pointer("/response/output")
        .and_then(Value::as_array)
        .is_some_and(|output| !output.is_empty())
    {
        return None;
    }
    let top_level = json!({"code":event.get("code"), "type":event.get("error_type"), "message":event.get("message")});
    let extracted = super::diagnostics::error_object(event);
    let error = if std::ptr::eq(extracted, event) {
        &top_level
    } else {
        extracted
    };
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let kind = error
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if [&*code, &*kind].iter().any(|value| {
        matches!(
            *value,
            "context_length_exceeded"
                | "context_too_large"
                | "invalid_value"
                | "invalid_argument"
                | "invalid_encrypted_content"
                | "thinking_signature_invalid"
                | "content_policy_violation"
                | "cyber_policy"
                | "invalid_prompt"
                | "unsupported_value"
                | "message_too_big"
                | "string_above_max_length"
                | "previous_response_not_found"
        )
    }) {
        return None;
    }
    let message = error
        .get("message")
        .or_else(|| event.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["context window", "context length", "too many tokens"]
        .iter()
        .any(|text| message.contains(text))
    {
        return None;
    }
    let status = if super::upstream_errors::model_unavailable(400, event, "") {
        404
    } else if [&*code, &*kind].iter().any(|v| {
        matches!(
            *v,
            "usage_limit_reached" | "insufficient_quota" | "quota_exceeded"
        )
    }) {
        429
    } else if [&*code, &*kind].iter().any(|v| {
        matches!(
            *v,
            "account_deactivated"
                | "account_disabled"
                | "account_suspended"
                | "organization_deactivated"
        )
    }) {
        403
    } else {
        let capacity = message.contains("model is at capacity")
            || code.contains("model_at_capacity")
            || code.contains("model_is_at_capacity")
            || (message.contains("model") && message.contains("at capacity"));
        if !(capacity
            || kind == "service_unavailable_error"
            || code == "server_is_overloaded"
            || kind == "rate_limit_error"
            || code == "rate_limit_exceeded"
            || ((kind == "server_error" || code == "server_error")
                && message.contains("you can retry your request")))
        {
            return None;
        }
        if capacity {
            429
        } else {
            503
        }
    };
    let mut body = json!({"error": error});
    // Preserve Retry-After/reset hints, including wrapped event headers.
    for key in [
        "headers",
        "retry_after",
        "retry_after_seconds",
        "resets_at",
        "resets_in_seconds",
    ] {
        if let Some(value) = event.get(key) {
            body[key] = value.clone();
        }
    }
    Some((status, body))
}

/// Return a synthetic HTTP rejection only before any non-handshake event.
/// This feeds the same status retry/cooldown path as a real non-2xx response.
pub(super) async fn probe(
    state: &Arc<AppState>,
    response: reqwest::Response,
    policy: &ExecutionPolicy,
    deadline: tokio::time::Instant,
) -> Result<reqwest::Response, ServiceError> {
    probe_inner(state, response, policy, deadline, false, false, false).await
}

pub(super) async fn probe_chat(
    state: &Arc<AppState>,
    response: reqwest::Response,
    policy: &ExecutionPolicy,
    deadline: tokio::time::Instant,
) -> Result<reqwest::Response, ServiceError> {
    probe_inner(state, response, policy, deadline, true, false, false).await
}

pub(super) async fn probe_provider(
    state: &Arc<AppState>,
    response: reqwest::Response,
    policy: &ExecutionPolicy,
    deadline: tokio::time::Instant,
    grok: bool,
    capability_fallback: bool,
) -> Result<reqwest::Response, ServiceError> {
    probe_inner(state, response, policy, deadline, false, grok, capability_fallback).await
}

async fn probe_inner(
    state: &Arc<AppState>,
    response: reqwest::Response,
    policy: &ExecutionPolicy,
    deadline: tokio::time::Instant,
    chat: bool,
    grok: bool,
    capability_fallback: bool,
) -> Result<reqwest::Response, ServiceError> {
    let status = response.status();
    let version = response.version();
    let mut headers = response.headers().clone();
    let mut source = tokio::time::timeout_at(
        deadline,
        super::upstream::raw_stream(state, response, policy.idle_timeout),
    )
    .await
    .map_err(|_| super::retry::total_timeout())??;
    let mut buffered = Vec::new();
    let mut size = 0;
    let mut count = 0;
    let mut decoder = SseDecoder::new(state.options.max_event_bytes);
    let mut reject = None;
    let mut hold_deadline = None;
    let mut json_prefix = Vec::new();
    if source.is_sse || chat {
        'read: loop {
            let mut stop = state.stop.clone();
            let next = tokio::select! {
                _ = stop.wait() => return Err(stopping_error()),
                _ = tokio::time::sleep_until(hold_deadline.unwrap_or(deadline)), if hold_deadline.is_some() => break 'read,
                next = tokio::time::timeout_at((tokio::time::Instant::now() + policy.idle_timeout).min(deadline), source.bytes.next()) =>
                    next.map_err(|_| if tokio::time::Instant::now() >= deadline { super::retry::total_timeout() }
                    else { ServiceError::new(504, "upstream_idle_timeout", "Upstream stream stopped responding") })?,
            };
            let events = match next {
                Some(Ok(bytes)) => {
                    let remaining = MAX_BYTES.saturating_sub(size);
                    let prefix = &bytes[..bytes.len().min(remaining)];
                    let events = if source.is_sse {
                        decoder.push_frames(prefix)?
                    } else {
                        json_prefix.extend_from_slice(prefix);
                        match serde_json::from_slice::<Value>(&json_prefix) {
                            Ok(value) => vec![super::events::SseFrame {
                                value: Some(value),
                                identity_event: None,
                                bytes: json_prefix.clone().into(),
                            }],
                            Err(_) => vec![],
                        }
                    };
                    size = size.saturating_add(bytes.len());
                    buffered.push(Ok(bytes));
                    events
                }
                Some(Err(error)) => {
                    return Err(super::diagnostics::transport_failure(
                        502,
                        "upstream_stream_error",
                        "Upstream stream disconnected before output",
                        &error,
                    ))
                }
                None => {
                    let events = if source.is_sse {
                        decoder.finish_frames()?
                    } else {
                        vec![]
                    };
                    if events.is_empty() {
                        return Err(ServiceError::new(
                            502,
                            "incomplete_upstream_stream",
                            "Upstream stream ended before output",
                        ));
                    }
                    events
                }
            };
            for frame in events {
                // Comments and incomplete JSON do not expose a response ID.
                // Start the bounded hold only once a complete semantic event
                // can actually be forwarded; otherwise a slow first error can
                // escape the retry path before any response was published.
                if frame.value.is_some() && hold_deadline.is_none() {
                    hold_deadline = Some(tokio::time::Instant::now() + MAX_HOLD);
                }
                if chat {
                    if let Some(error) = super::upstream_errors::chat_frame_failure(&frame) {
                        reject = Some((
                            error.status,
                            super::upstream_errors::canonical_chat_failure(&frame, &error),
                        ));
                        break 'read;
                    }
                    // Go's stream bootstrap stops at the first payload. Keep
                    // every choice, role delta, tool delta and usage payload;
                    // replaying any of them could duplicate output or billing.
                    if frame.value.is_some() || decoder.done {
                        break 'read;
                    }
                    count += 1;
                    if count > MAX_EVENTS {
                        break 'read;
                    }
                    continue;
                }
                let Some(event) = frame.value else { continue };
                // Only buffered pre-output events reach this point. Reuse the
                // same strict schema-rejection gate as HTTP errors and sockets;
                // normal parameter faults and generated output stay untouched.
                if capability_fallback
                    && super::capabilities::pre_execution_rejection(400, &event)
                {
                    reject = Some((400, event));
                    break 'read;
                }
                if let Some(failure) = grok
                    .then(|| super::grok_errors::rejection(&event))
                    .flatten()
                    .or_else(|| rejection(&event))
                {
                    reject = Some(failure);
                    break 'read;
                }
                if !handshake(&event) {
                    break 'read;
                }
                count += 1;
                if count > MAX_EVENTS {
                    break 'read;
                }
            }
            if size >= MAX_BYTES {
                break;
            }
        }
    }
    headers.remove(header::CONTENT_LENGTH);
    headers.remove(header::CONTENT_ENCODING);
    let (status, body) = if let Some((status, error)) = reject {
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        (
            StatusCode::from_u16(status).unwrap(),
            reqwest::Body::from(error.to_string()),
        )
    } else {
        if source.is_sse {
            headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        }
        (
            status,
            reqwest::Body::wrap_stream(stream::iter(buffered).chain(source.bytes)),
        )
    };
    let mut response = axum::http::Response::new(body);
    *response.status_mut() = status;
    *response.version_mut() = version;
    *response.headers_mut() = headers;
    Ok(reqwest::Response::from(response))
}

#[cfg(test)]
#[path = "bootstrap_tests.rs"]
mod tests;
