//! Capacity recovery has its own small budget, shared by all transports in a turn.
use std::time::Duration;

use serde_json::Value;

use super::{
    contract::{ServiceError, WireApi},
    deadline::{self, Deadline},
    lifecycle::{stopping_error, RequestTracker},
    mapping::{self, Prepared},
    server::AppState,
};

pub(super) const MAX_RETRIES: u8 = 2;
pub(super) const RECOVERY_WINDOW: Duration = Duration::from_secs(15);

pub(super) fn capacity_code(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "server_is_overloaded"
            | "server_overloaded"
            | "service_unavailable_error"
            | "flex_unavailable"
            | "queue_full"
            | "model_at_capacity"
            | "model_is_at_capacity"
    )
}

pub(super) fn event(event: &Value) -> bool {
    let error = super::diagnostics::error_object(event);
    // Explicit quota/auth failures outrank a contradictory generic busy type.
    if [error.get("code"), error.get("type"), event.get("code")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|code| {
            matches!(
                code,
                "usage_limit_reached"
                    | "insufficient_quota"
                    | "quota_exceeded"
                    | "rate_limit_exceeded"
                    | "rate_limit_error"
                    | "subscription_sharing_usage_limit_exceeded"
                    | "account_deactivated"
                    | "account_disabled"
                    | "account_suspended"
                    | "organization_deactivated"
                    | "invalid_api_key"
                    | "invalid_token"
            )
        })
    {
        return false;
    }
    [error.get("code"), error.get("type"), event.get("code")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(capacity_code)
        || error
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| {
                message
                    .to_ascii_lowercase()
                    .contains("model is at capacity")
            })
}

pub(super) fn failure(error: &ServiceError) -> bool {
    capacity_code(error.code) || error.response_error.as_ref().is_some_and(event)
}

#[derive(Default)]
pub(super) struct Budget {
    pub retries: u8,
    pub started: Option<tokio::time::Instant>,
}

impl Budget {
    pub(super) fn deadline(&self, deadline: Deadline) -> Deadline {
        self.started
            .map_or(deadline, |start| deadline.min(start + RECOVERY_WINDOW))
    }
}

/// Caller must prove an explicit rejection before any model/tool execution.
/// Reselect the same owner through the host so revocations and concurrency still apply.
pub(super) async fn retry_same(
    state: &AppState,
    prepared: &mut Prepared,
    tracker: &mut RequestTracker,
    wait: Option<Duration>,
    deadline: Deadline,
    maximum_wait: Duration,
) -> Result<bool, ServiceError> {
    if prepared.compact
        || prepared.raw_chat.is_some()
        || prepared.image_route_request.is_some()
        || prepared.route.chatgpt_plan
        || prepared.route.wire_api != WireApi::Responses
        || prepared.request.capability_fallback_from.is_some()
        || tracker.overload.retries >= MAX_RETRIES
    {
        return Ok(false);
    }
    let start = *tracker
        .overload
        .started
        .get_or_insert_with(tokio::time::Instant::now);
    let deadline = tracker.overload.deadline(deadline);
    let backoff = Duration::from_millis(300 * (1u64 << tracker.overload.retries));
    let jitter = Duration::from_millis(u64::from(rand::random::<u8>()) % 151);
    if maximum_wait.is_zero() || wait.is_some_and(|hint| hint > maximum_wait) {
        return Ok(false);
    }
    let wait = wait
        .unwrap_or_default()
        .max((backoff + jitter).min(maximum_wait));
    if wait
        >= deadline
            .cap(start + RECOVERY_WINDOW)
            .saturating_duration_since(tokio::time::Instant::now())
    {
        return Ok(false);
    }
    tracker.release_route();
    prepared.route.permit = None;
    let mut stop = state.stop.clone();
    let result = tokio::select! {
        _ = stop.wait() => return Err(stopping_error()),
        result = deadline::timeout_at(deadline, async {
            tokio::time::sleep(wait).await;
            mapping::refresh_transport(state, prepared).await
        }) => result,
    };
    match result {
        Ok(Ok(())) => {
            tracker.overload.retries += 1;
            tracker.routed(&prepared.caller, &prepared.route, &prepared.request.model);
            tracker.routing_identity(&prepared.request);
            tracker.track_rebuild(prepared.binding.rebuild_abort_handle());
            tracker.prepared_metadata(prepared);
            tracker.overload_retry(wait, start.elapsed());
            Ok(true)
        }
        // Keep the original upstream error when local preparation cannot recover.
        Ok(Err(_)) | Err(_) if !state.stop.stopped() => Ok(false),
        _ => Err(stopping_error()),
    }
}
