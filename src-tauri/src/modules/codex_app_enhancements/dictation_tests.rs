use super::*;
use axum::extract::Multipart;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use std::sync::{Arc, Mutex};

fn config(endpoint: String) -> DictationConfig {
    DictationConfig {
        endpoint,
        api_key: "private-provider-key".into(),
        model: "test-transcriber".into(),
        labels: json!({"start": "localized-start"}),
        client: reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
    }
}

fn payload() -> BindingPayload {
    BindingPayload {
        session: "test-session".into(),
        action: "transcribe".into(),
        request_id: "request-1".into(),
        audio: base64::engine::general_purpose::STANDARD.encode(b"test audio"),
        mime: "audio/webm;codecs=opus".into(),
        language: Some("zh".into()),
    }
}

#[test]
fn renderer_source_contains_labels_and_session_but_never_credentials_or_endpoint() {
    let source = script(
        &config("https://private-host.example/audio/transcriptions".into()),
        "session-1",
    );
    assert!(source.contains("localized-start"));
    assert!(source.contains("session-1"));
    assert!(!source.contains("private-provider-key"));
    assert!(!source.contains("private-host.example"));
    assert!(!source.contains("__COCKPIT_DICTATION_CONFIG__"));
}

#[test]
fn binding_limits_and_session_are_enforced_before_audio_decoding() {
    let valid = json!({"session":"right", "action":"cancel", "requestId":"id-1"}).to_string();
    assert!(parse_payload(&valid, "right").is_ok());
    assert!(parse_payload(&valid, "wrong").is_err());
    for invalid in [
        json!({"session":"right", "action":"transcribe", "requestId":""}),
        json!({"session":"right", "action":"transcribe", "requestId":"bad/path"}),
        json!({"session":"right", "action":"exec", "requestId":"id"}),
        json!({"session":"right", "action":"transcribe", "requestId":"id", "language":"bad\r\nheader"}),
        json!({"session":"right", "action":"cancel", "requestId":"id", "endpoint":"https://other.test"}),
    ] {
        assert!(parse_payload(&invalid.to_string(), "right").is_err());
    }
    assert_eq!(
        parse_payload(&" ".repeat(MAX_BINDING_BYTES + 1), "right").err(),
        Some("tooLarge")
    );
}

#[test]
fn audio_is_bounded_and_accepts_only_recorder_formats() {
    let mut value = payload();
    let (bytes, mime, filename) = decode_audio(&value).unwrap();
    assert_eq!(bytes, b"test audio");
    assert_eq!((mime, filename), ("audio/webm", "dictation.webm"));
    for (format, expected) in [
        ("audio/wav", "dictation.wav"),
        ("audio/x-wav", "dictation.wav"),
        ("audio/mpeg", "dictation.mp3"),
    ] {
        value.mime = format.into();
        assert_eq!(decode_audio(&value).unwrap().2, expected);
    }
    value.mime = "text/html".into();
    assert_eq!(decode_audio(&value).err(), Some("unsupported"));
    value.mime = "audio/mp4".into();
    value.audio = "?not-base64".into();
    assert_eq!(decode_audio(&value).err(), Some("failed"));
    value.audio = "A".repeat(MAX_ENCODED_BYTES + 1);
    assert_eq!(decode_audio(&value).err(), Some("tooLarge"));
}

#[tokio::test]
async fn multipart_transcription_uses_only_the_configured_instance_provider() {
    let observed = Arc::new(Mutex::new(None));
    let captured = observed.clone();
    let app = Router::new().route(
        "/audio/transcriptions",
        post(move |headers: HeaderMap, mut multipart: Multipart| {
            let captured = captured.clone();
            async move {
                let mut fields = Vec::new();
                while let Some(field) = multipart.next_field().await.unwrap() {
                    let name = field.name().unwrap().to_owned();
                    let filename = field.file_name().map(str::to_owned);
                    let content_type = field.content_type().map(str::to_owned);
                    let value = field.bytes().await.unwrap().to_vec();
                    fields.push((name, filename, content_type, value));
                }
                *captured.lock().unwrap() = Some((headers, fields));
                axum::Json(json!({"text":"  识别结果  "}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/audio/transcriptions",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    assert_eq!(
        transcribe(config(endpoint), payload()).await.unwrap(),
        "识别结果"
    );
    let (headers, fields) = observed.lock().unwrap().take().unwrap();
    assert_eq!(headers["authorization"], "Bearer private-provider-key");
    assert_eq!(fields.len(), 4);
    assert!(fields
        .iter()
        .any(|(name, _, _, bytes)| name == "language" && bytes == b"zh"));
    assert!(fields
        .iter()
        .any(|(name, _, _, bytes)| name == "model" && bytes == b"test-transcriber"));
    assert!(fields
        .iter()
        .any(|(name, _, _, bytes)| name == "response_format" && bytes == b"json"));
    assert!(fields
        .iter()
        .any(|(name, filename, mime, bytes)| name == "file"
            && filename.as_deref() == Some("dictation.webm")
            && mime.as_deref() == Some("audio/webm")
            && bytes == b"test audio"));
    server.abort();
}

#[tokio::test]
async fn upstream_errors_and_oversized_text_do_not_reach_the_renderer() {
    let app = Router::new()
        .route(
            "/error",
            post(|| async { (StatusCode::UNAUTHORIZED, "sensitive upstream detail") }),
        )
        .route(
            "/oversized",
            post(|| async { "x".repeat(MAX_TEXT_BYTES + 1) }),
        )
        .route("/empty", post(|| async { axum::Json(json!({"text":" "})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    assert_eq!(
        transcribe(config(format!("{base}/error")), payload()).await,
        Err("failed")
    );
    assert_eq!(
        transcribe(config(format!("{base}/oversized")), payload()).await,
        Err("tooLarge")
    );
    assert_eq!(
        transcribe(config(format!("{base}/empty")), payload()).await,
        Err("failed")
    );
    server.abort();
}

#[tokio::test]
async fn remote_debug_endpoints_are_rejected_before_connecting() {
    let (_sender, receiver) = watch::channel(false);
    assert_eq!(
        run(
            "ws://remote.example:9222/devtools/page/1".into(),
            config("http://127.0.0.1:1".into()),
            receiver
        )
        .await,
        Err("DICTATION_CDP_INVALID_URL".into())
    );
}

#[tokio::test]
async fn cdp_bridge_isolates_frame_and_session_and_disposes_on_stop() {
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let captured = bodies.clone();
    let app = Router::new().route(
        "/audio/transcriptions",
        post(move |mut multipart: Multipart| {
            let captured = captured.clone();
            async move {
                while let Some(field) = multipart.next_field().await.unwrap() {
                    if field.name() == Some("file") {
                        let bytes = field.bytes().await.unwrap().to_vec();
                        captured.lock().unwrap().push(bytes);
                    }
                }
                axum::Json(json!({"text":"recognized"}))
            }
        }),
    );
    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/audio/transcriptions",
        http_listener.local_addr().unwrap()
    );
    let http_server = tokio::spawn(async move { axum::serve(http_listener, app).await.unwrap() });
    let cdp_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let websocket_url = format!(
        "ws://{}/devtools/page/test",
        cdp_listener.local_addr().unwrap()
    );
    let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
    let (disposed_sender, disposed_receiver) = tokio::sync::oneshot::channel();
    let cdp_server = tokio::spawn(async move {
        let (tcp, _) = cdp_listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let mut injected = false;
        let mut result_sender = Some(result_sender);
        let mut disposed_sender = Some(disposed_sender);
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let value: Value = serde_json::from_str(&text).unwrap();
            let method = value["method"].as_str().unwrap();
            let result = if method == "Page.getFrameTree" {
                json!({"frameTree":{"frame":{"id":"main"}}})
            } else {
                json!({})
            };
            if socket
                .send(Message::Text(
                    json!({"id":value["id"],"result":result}).to_string().into(),
                ))
                .await
                .is_err()
            {
                break;
            }
            if method == "Runtime.enable" {
                for (id, frame) in [(7, "main"), (99, "iframe")] {
                    socket
                        .send(Message::Text(
                            json!({"method":"Runtime.executionContextCreated","params":{"context":{
                        "id":id,"auxData":{"isDefault":true,"frameId":frame}}}})
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                }
            }
            if method != "Runtime.evaluate" {
                continue;
            }
            let expression = value["params"]["expression"].as_str().unwrap();
            if expression.starts_with("(function installCockpitDictation") && !injected {
                injected = true;
                assert!(!expression.contains("private-provider-key"));
                let start = expression.rfind("})(").unwrap() + 3;
                let configuration: Value =
                    serde_json::from_str(expression[start..].trim().strip_suffix(");").unwrap())
                        .unwrap();
                let session = configuration["session"].as_str().unwrap();
                let binding = configuration["binding"].as_str().unwrap();
                for (context, token, text) in [
                    (99, session, "wrong frame"),
                    (7, "wrong-session", "wrong session"),
                    (7, session, "valid audio"),
                ] {
                    let request = json!({"session":token,"action":"transcribe","requestId":"request-1",
                        "audio":base64::engine::general_purpose::STANDARD.encode(text),"mime":"audio/webm"});
                    socket
                        .send(Message::Text(
                            json!({"method":"Runtime.bindingCalled","params":{
                        "name":binding,"executionContextId":context,"payload":request.to_string()}})
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                }
            } else if expression.contains("__cockpitApiDictation?.receive(")
                && expression.contains("recognized")
            {
                if let Some(sender) = result_sender.take() {
                    let _ = sender.send(());
                }
            } else if expression.contains(".dispose?.()") && expression.starts_with("if(") {
                if let Some(sender) = disposed_sender.take() {
                    let _ = sender.send(());
                }
            }
        }
    });
    let (stop, receiver) = watch::channel(false);
    let run_task = tokio::spawn(run(websocket_url, config(endpoint), receiver));
    timeout(Duration::from_secs(3), result_receiver)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*bodies.lock().unwrap(), vec![b"valid audio".to_vec()]);
    stop.send(true).unwrap();
    timeout(Duration::from_secs(3), run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(3), disposed_receiver)
        .await
        .unwrap()
        .unwrap();
    cdp_server.abort();
    http_server.abort();
}
