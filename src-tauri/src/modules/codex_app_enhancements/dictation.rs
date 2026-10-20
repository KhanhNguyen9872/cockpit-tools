//! Instance-scoped API dictation. Credentials never enter the renderer.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const BINDING: &str = "__cockpitDictationBridge";
const MAX_AUDIO_BYTES: usize = 12 * 1024 * 1024;
const MAX_ENCODED_BYTES: usize = MAX_AUDIO_BYTES.div_ceil(3) * 4;
const MAX_BINDING_BYTES: usize = MAX_ENCODED_BYTES + 2048;
const MAX_CDP_BYTES: usize = MAX_BINDING_BYTES + 8192;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const CDP_TIMEOUT: Duration = Duration::from_secs(3);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(90);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone)]
pub(super) struct DictationConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub labels: Value,
    /// The caller applies the instance/provider's proxy policy and disables redirects.
    pub client: reqwest::Client,
}

/// The owner should evaluate this before disabling a live target. A renderer
/// heartbeat also disables the transport when the CDP connection disappears.
pub(super) const CLEANUP_SCRIPT: &str = "globalThis.__cockpitApiDictation?.dispose?.();";

const SCRIPT: &str = include_str!("dictation.js");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingPayload {
    session: String,
    action: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    audio: String,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    language: Option<String>,
}

fn script(config: &DictationConfig, session: &str) -> String {
    SCRIPT.replace(
        "__COCKPIT_DICTATION_CONFIG__",
        &json!({"session": session, "binding": binding_name(session), "labels": config.labels,
            "maxBytes": MAX_AUDIO_BYTES, "timeoutMs": TRANSCRIBE_TIMEOUT.as_millis() + 5000})
        .to_string(),
    )
}

fn binding_name(session: &str) -> String {
    format!("{BINDING}_{}", session.replace('-', ""))
}

fn parse_payload(raw: &str, session: &str) -> Result<BindingPayload, &'static str> {
    if raw.len() > MAX_BINDING_BYTES {
        return Err("tooLarge");
    }
    let payload: BindingPayload = serde_json::from_str(raw).map_err(|_| "failed")?;
    if payload.session != session
        || !matches!(
            payload.action.as_str(),
            "ready" | "alive" | "transcribe" | "cancel"
        )
        || payload.request_id.len() > 80
        || !payload
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("failed");
    }
    if matches!(payload.action.as_str(), "transcribe" | "cancel") && payload.request_id.is_empty() {
        return Err("failed");
    }
    if payload.language.as_ref().is_some_and(|language| {
        language.is_empty()
            || language.len() > 32
            || !language
                .bytes()
                .all(|b| b.is_ascii_alphabetic() || b == b'-')
    }) {
        return Err("failed");
    }
    Ok(payload)
}

fn decode_audio(
    payload: &BindingPayload,
) -> Result<(Vec<u8>, &'static str, &'static str), &'static str> {
    if payload.audio.is_empty() || payload.audio.len() > MAX_ENCODED_BYTES {
        return Err("tooLarge");
    }
    let (mime, filename) = match payload.mime.split(';').next().unwrap_or("").trim() {
        "audio/webm" => ("audio/webm", "dictation.webm"),
        "audio/mp4" => ("audio/mp4", "dictation.m4a"),
        "audio/ogg" => ("audio/ogg", "dictation.ogg"),
        "audio/wav" | "audio/x-wav" => ("audio/wav", "dictation.wav"),
        "audio/mpeg" => ("audio/mpeg", "dictation.mp3"),
        _ => return Err("unsupported"),
    };
    let audio = base64::engine::general_purpose::STANDARD
        .decode(&payload.audio)
        .map_err(|_| "failed")?;
    if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES {
        return Err("tooLarge");
    }
    Ok((audio, mime, filename))
}

async fn transcribe(
    config: DictationConfig,
    payload: BindingPayload,
) -> Result<String, &'static str> {
    let (audio, mime, filename) = decode_audio(&payload)?;
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(filename)
        .mime_str(mime)
        .map_err(|_| "failed")?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", config.model)
        .text("response_format", "json")
        .part("file", part);
    if let Some(language) = payload.language {
        form = form.text("language", language);
    }
    // Do not follow provider redirects with the credential or audio attached.
    let response = config
        .client
        .post(config.endpoint)
        .bearer_auth(config.api_key)
        .multipart(form)
        .timeout(TRANSCRIBE_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "timedOut"
            } else {
                "failed"
            }
        })?;
    if !response.status().is_success() {
        return Err("failed");
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_TEXT_BYTES as u64)
    {
        return Err("tooLarge");
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| "failed")?;
        if bytes.len() + chunk.len() > MAX_TEXT_BYTES {
            return Err("tooLarge");
        }
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| "failed")?;
    let text = result
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or("failed")?;
    Ok(text.to_owned())
}

async fn send(socket: &mut Socket, id: u64, method: &str, params: Value) -> Result<(), String> {
    timeout(
        CDP_TIMEOUT,
        socket.send(Message::Text(
            json!({"id": id, "method": method, "params": params})
                .to_string()
                .into(),
        )),
    )
    .await
    .map_err(|_| "DICTATION_CDP_TIMEOUT")?
    .map_err(|_| "DICTATION_CDP_DISCONNECTED".into())
}

async fn command(
    socket: &mut Socket,
    queued: &mut VecDeque<Value>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    send(socket, id, method, params).await?;
    timeout(CDP_TIMEOUT, async {
        while let Some(message) = socket.next().await {
            let Ok(Message::Text(text)) = message else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if value.get("error").is_some()
                    || value.pointer("/result/exceptionDetails").is_some()
                {
                    return Err("DICTATION_CDP_SETUP_FAILED".to_string());
                }
                return Ok(value);
            }
            if value.get("method").is_some() {
                if queued.len() >= 1024 {
                    return Err("DICTATION_CDP_EVENT_OVERFLOW".into());
                }
                queued.push_back(value);
            }
        }
        Err("DICTATION_CDP_DISCONNECTED".to_string())
    })
    .await
    .map_err(|_| "DICTATION_CDP_TIMEOUT")?
}

async fn deliver(
    socket: &mut Socket,
    command_id: &mut u64,
    context: i64,
    value: Value,
) -> Result<(), String> {
    *command_id += 1;
    send(
        socket,
        *command_id,
        "Runtime.evaluate",
        json!({
            "contextId": context,
            "expression": format!("globalThis.__cockpitApiDictation?.receive({value})"),
            "returnByValue": true
        }),
    )
    .await
}

/// One task/connection per renderer target. Its caller owns reconnection and
/// shuts it down on profile/config changes. A JoinSet drops pending HTTP work.
pub(super) async fn run(
    websocket_url: String,
    config: DictationConfig,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    if *stop.borrow() {
        return Ok(());
    }
    let url = url::Url::parse(&websocket_url).map_err(|_| "DICTATION_CDP_INVALID_URL")?;
    if url.scheme() != "ws"
        || !matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        )
    {
        return Err("DICTATION_CDP_INVALID_URL".into());
    }
    let socket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_CDP_BYTES))
        .max_frame_size(Some(MAX_CDP_BYTES));
    let (mut socket, _) = timeout(
        CDP_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(websocket_url, Some(socket_config), false),
    )
    .await
    .map_err(|_| "DICTATION_CDP_TIMEOUT")?
    .map_err(|_| "DICTATION_CDP_DISCONNECTED")?;
    let mut queued = VecDeque::new();
    command(&mut socket, &mut queued, 1, "Page.enable", json!({})).await?;
    let tree = command(&mut socket, &mut queued, 2, "Page.getFrameTree", json!({})).await?;
    let top_frame = tree
        .pointer("/result/frameTree/frame/id")
        .and_then(Value::as_str)
        .ok_or("DICTATION_CDP_NO_FRAME")?
        .to_owned();
    let session = uuid::Uuid::new_v4().to_string();
    let binding = binding_name(&session);
    command(&mut socket, &mut queued, 3, "Runtime.enable", json!({})).await?;
    command(
        &mut socket,
        &mut queued,
        4,
        "Runtime.addBinding",
        json!({"name": binding}),
    )
    .await?;
    let source = script(&config, &session);
    command(
        &mut socket,
        &mut queued,
        5,
        "Runtime.evaluate",
        json!({"expression": source, "returnByValue": true}),
    )
    .await?;
    let mut command_id = 5;
    let mut contexts = HashSet::new();
    let mut pending: Option<(String, i64)> = None;
    let mut requests: JoinSet<(String, i64, Result<String, &'static str>)> = JoinSet::new();
    loop {
        if *stop.borrow() {
            requests.abort_all();
            command_id += 1;
            let expression = format!(
                "if(globalThis.__cockpitApiDictation?.session==={}){{{CLEANUP_SCRIPT}}}",
                json!(session)
            );
            let _ = command(
                &mut socket,
                &mut queued,
                command_id,
                "Runtime.evaluate",
                json!({"expression": expression}),
            )
            .await;
            return Ok(());
        }
        let next = if let Some(value) = queued.pop_front() {
            Some(Ok(value))
        } else {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_ok() && !*stop.borrow() { continue; }
                    requests.abort_all();
                    command_id += 1;
                    let expression = format!("if(globalThis.__cockpitApiDictation?.session==={}){{{CLEANUP_SCRIPT}}}", json!(session));
                    let _ = command(&mut socket, &mut queued, command_id, "Runtime.evaluate", json!({"expression": expression})).await;
                    return Ok(());
                }
                message = socket.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => Some(serde_json::from_str(&text).map_err(|_| "DICTATION_CDP_INVALID_MESSAGE")),
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Err(_)) => return Err("DICTATION_CDP_DISCONNECTED".into()),
                        _ => continue,
                    }
                }
                result = requests.join_next(), if !requests.is_empty() => {
                    if let Some(Ok((request_id, context, result))) = result {
                        if pending.as_ref() == Some(&(request_id.clone(), context)) && contexts.contains(&context) {
                            pending = None;
                            let value = match result {
                                Ok(text) => json!({"session": session, "requestId": request_id, "text": text}),
                                Err(error) => json!({"session": session, "requestId": request_id, "error": error}),
                            };
                            deliver(&mut socket, &mut command_id, context, value).await?;
                        }
                    }
                    continue;
                }
            }
        };
        let Some(Ok(value)) = next else { continue };
        match value.get("method").and_then(Value::as_str).unwrap_or("") {
            "Runtime.executionContextCreated" => {
                let context = &value["params"]["context"];
                if context
                    .pointer("/auxData/isDefault")
                    .and_then(Value::as_bool)
                    == Some(true)
                    && context.pointer("/auxData/frameId").and_then(Value::as_str)
                        == Some(top_frame.as_str())
                {
                    if let Some(id) = context["id"].as_i64() {
                        contexts.insert(id);
                        command_id += 1;
                        send(
                            &mut socket,
                            command_id,
                            "Runtime.evaluate",
                            json!({"contextId": id, "expression": source, "returnByValue": true}),
                        )
                        .await?;
                    }
                }
            }
            "Runtime.executionContextDestroyed" | "Runtime.executionContextsCleared" => {
                let id = value
                    .pointer("/params/executionContextId")
                    .and_then(Value::as_i64);
                if let Some(id) = id {
                    contexts.remove(&id);
                } else {
                    contexts.clear();
                }
                if pending
                    .as_ref()
                    .is_some_and(|(_, context)| !contexts.contains(context))
                {
                    requests.abort_all();
                    pending = None;
                }
            }
            "Runtime.bindingCalled" => {
                let params = &value["params"];
                if params["name"].as_str() != Some(binding.as_str()) {
                    continue;
                }
                let Some(context) = params["executionContextId"]
                    .as_i64()
                    .filter(|id| contexts.contains(id))
                else {
                    continue;
                };
                let Some(raw) = params["payload"].as_str() else {
                    continue;
                };
                let Ok(payload) = parse_payload(raw, &session) else {
                    continue;
                };
                match payload.action.as_str() {
                    "ready" | "alive" => {
                        deliver(
                            &mut socket,
                            &mut command_id,
                            context,
                            json!({"session": session, "alive": true}),
                        )
                        .await?;
                    }
                    "cancel" => {
                        if pending.as_ref() == Some(&(payload.request_id, context)) {
                            requests.abort_all();
                            pending = None;
                        }
                    }
                    "transcribe" => {
                        if pending.is_some() {
                            continue;
                        }
                        let request_id = payload.request_id.clone();
                        pending = Some((request_id.clone(), context));
                        let config = config.clone();
                        requests.spawn(async move {
                            let result = timeout(TRANSCRIBE_TIMEOUT, transcribe(config, payload))
                                .await
                                .unwrap_or(Err("timedOut"));
                            (request_id, context, result)
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
