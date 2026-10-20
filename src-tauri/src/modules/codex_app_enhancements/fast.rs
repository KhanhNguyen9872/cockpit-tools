//! Adapt native controls before their module loads. A newly launched profile
//! may reload one clean document; restored sessions only prepare future pages.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant as StdInstant};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
use tokio_tungstenite::{connect_async_with_config, MaybeTlsStream, WebSocketStream};

const GUARD_SCRIPT: &str = include_str!("startup_guard.js");
const SCRIPT: &str = include_str!("fast.js");
const QUOTA_SCRIPT: &str = include_str!("quota.js");
const DICTATION_SCRIPT: &str = include_str!("native_dictation.js");
const STATE_SCRIPT: &str = r#";(() => {
  const previous = window.__cockpitEnhancements;
  const next = __COCKPIT_STATE_OPTIONS__;
  const features = [next.nativeFast, next.quotaCompat, next.apiDictation, next.apiKeyAuthVerified].map(Number).join('');
  const active = previous?.nativePatchState === 'active'
    && previous.nativePatchFeatures === features;
  const sameOwnerAndConfig = previous?.owner === next.owner
    && previous.nativeFast === next.nativeFast
    && previous.quotaCompat === next.quotaCompat
    && previous.apiDictation === next.apiDictation
    && previous.apiKeyAuthVerified === next.apiKeyAuthVerified;
  const preserveLoadingState = sameOwnerAndConfig
    && ['preloading', 'unsupported'].includes(previous.nativePatchState);
  window.__cockpitEnhancements = {
    ...previous, ...next,
    nativePatchState: active ? 'active' : preserveLoadingState ? previous.nativePatchState : 'pending',
    nativePatchReason: preserveLoadingState ? previous.nativePatchReason : undefined,
  };
})();"#;
const SOURCE_LIMIT: usize = 24 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const PREPARE_TIMEOUT: Duration = Duration::from_secs(20);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(3);
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(35);
const RETRY_DELAYS: [u64; 5] = [1, 2, 5, 10, 15];
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type ContextKey = (u64, i64);

/// Shared by every target/worker of one explicit profile launch. Reconnection
/// and configuration changes must not create another startup permission.
pub(super) struct StartupReload {
    deadline: StdInstant,
    claimed: AtomicBool,
}

impl StartupReload {
    pub(super) fn new() -> Self {
        Self {
            deadline: StdInstant::now() + Duration::from_secs(45),
            claimed: AtomicBool::new(false),
        }
    }

    fn available(&self) -> bool {
        StdInstant::now() <= self.deadline && !self.claimed.load(Ordering::Acquire)
    }

    fn claim(&self) -> bool {
        self.available()
            && self
                .claimed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    /// Only an explicit transient rejection from the atomic renderer guard
    /// proves no navigation was initiated. An unknown result must stay spent.
    fn release_rejected(&self) {
        let _ = self
            .claimed
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire);
    }
}

struct Session {
    socket: Socket,
    command_id: u64,
    contexts: HashMap<i64, String>,
    main_frame: Option<String>,
    generation: u64,
    registrations: HashSet<String>,
    pending_additions: HashSet<u64>,
    pending_removals: HashMap<u64, String>,
}

impl Session {
    async fn receive(&mut self) -> Result<Option<Value>, String> {
        while let Some(message) = self.socket.next().await {
            match message.map_err(|_| "native enhancement transport failed".to_string())? {
                Message::Ping(bytes) => self
                    .socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| "native enhancement transport failed".to_string())?,
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text)
                        .map_err(|_| "native enhancement invalid response".to_string())?;
                    self.observe_registration_reply(&value);
                    self.observe(&value)?;
                    return Ok(Some(value));
                }
                Message::Close(_) => return Ok(None),
                _ => {}
            }
        }
        Ok(None)
    }

    async fn send(&mut self, method: &str, params: Value) -> Result<u64, String> {
        self.command_id += 1;
        let id = self.command_id;
        if method == "Page.addScriptToEvaluateOnNewDocument" {
            self.pending_additions.insert(id);
        } else if method == "Page.removeScriptToEvaluateOnNewDocument" {
            if let Some(identifier) = params.get("identifier").and_then(Value::as_str) {
                self.pending_removals.insert(id, identifier.to_string());
            }
        }
        self.socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|_| "native enhancement transport failed".to_string())?;
        Ok(id)
    }

    async fn command(
        &mut self,
        method: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value, String> {
        timeout(limit, async {
            let id = self.send(method, params).await?;
            while let Some(reply) = self.receive().await? {
                if reply.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if reply.get("error").is_some() {
                    return Err(format!("native enhancement command rejected: {method}"));
                }
                return Ok(reply);
            }
            Err("native enhancement connection closed".to_string())
        })
        .await
        .map_err(|_| format!("native enhancement command timed out: {method}"))?
    }

    fn observe_registration_reply(&mut self, reply: &Value) {
        let Some(id) = reply.get("id").and_then(Value::as_u64) else {
            return;
        };
        if self.pending_additions.remove(&id) {
            if let Some(identifier) = reply
                .pointer("/result/identifier")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                self.registrations.insert(identifier.to_string());
            }
        }
        if let Some(identifier) = self.pending_removals.remove(&id) {
            if reply.get("error").is_none() {
                self.registrations.remove(&identifier);
            }
        }
    }

    fn observe(&mut self, event: &Value) -> Result<(), String> {
        match event.get("method").and_then(Value::as_str) {
            Some("Inspector.detached") => {
                return Err("native enhancement target detached".to_string())
            }
            Some("Runtime.executionContextsCleared") => {
                self.contexts.clear();
                self.generation += 1;
            }
            Some("Runtime.executionContextDestroyed") => {
                if let Some(id) = event
                    .pointer("/params/executionContextId")
                    .and_then(Value::as_i64)
                {
                    self.contexts.remove(&id);
                }
            }
            Some("Runtime.executionContextCreated") => {
                let context = &event["params"]["context"];
                if context
                    .pointer("/auxData/isDefault")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    if let (Some(id), Some(frame)) = (
                        context.get("id").and_then(Value::as_i64),
                        context.pointer("/auxData/frameId").and_then(Value::as_str),
                    ) {
                        self.contexts.insert(id, frame.to_string());
                    }
                }
            }
            Some("Page.frameNavigated") => {
                let frame = &event["params"]["frame"];
                if frame.get("parentId").is_none() {
                    if let Some(id) = frame.get("id").and_then(Value::as_str) {
                        self.main_frame = Some(id.to_string());
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn context(&self) -> Option<ContextKey> {
        let frame = self.main_frame.as_deref()?;
        let mut contexts = self
            .contexts
            .iter()
            .filter(|(_, candidate)| candidate.as_str() == frame);
        let id = *contexts.next()?.0;
        // Never guess between two default worlds during navigation.
        contexts.next().is_none().then_some((self.generation, id))
    }

    async fn evaluate(
        &mut self,
        expression: String,
        context: ContextKey,
        limit: Duration,
    ) -> Result<Value, String> {
        let reply = self
            .command(
                "Runtime.evaluate",
                json!({"expression":expression,"contextId":context.1,"returnByValue":true,"awaitPromise":true}),
                limit,
            )
            .await?;
        if reply.pointer("/result/exceptionDetails").is_some() {
            return Err("native enhancement evaluation rejected".to_string());
        }
        reply
            .pointer("/result/result/value")
            .cloned()
            .ok_or_else(|| "native enhancement returned no value".to_string())
    }
}

#[derive(Default)]
struct Attempt {
    count: usize,
    next: Option<Instant>,
    done: bool,
}

impl Attempt {
    fn due(&self) -> bool {
        !self.done && self.next.is_none_or(|time| Instant::now() >= time)
    }
    fn failed(&mut self, retryable: bool) {
        self.count += 1;
        self.next = RETRY_DELAYS
            .get(self.count - 1)
            .map(|seconds| Instant::now() + Duration::from_secs(*seconds));
        self.done = !retryable || self.next.is_none();
    }
}

/// Retains the websocket in Drop so cancellation still removes registrations,
/// including a registration whose reply arrives after its command was canceled.
struct Registration {
    session: Option<Session>,
    script_id: Option<String>,
    owner: String,
    runtime: String,
    nonce: String,
    startup: Option<Arc<StartupReload>>,
    context: Option<ContextKey>,
    document: Attempt,
    bootstrapped: bool,
    active: bool,
    activation_until: Option<Instant>,
    next_state_read: Option<Instant>,
    next_startup_check: Option<Instant>,
    last_diagnostic: Option<Value>,
}

impl Registration {
    fn session(&mut self) -> &mut Session {
        self.session
            .as_mut()
            .expect("registration owns its session")
    }

    async fn cleanup(&mut self) {
        if let Some(mut session) = self.session.take() {
            cleanup(
                &mut session,
                self.script_id.take(),
                &self.owner,
                &self.nonce,
            )
            .await;
        }
    }

    async fn report(&mut self, phase: &str, reason: &str) {
        let state = if self.active {
            "active"
        } else if self.script_id.is_some() {
            "next-document"
        } else {
            "pending"
        };
        let diagnostic = json!({"state":state,"phase":phase,"reason":reason});
        if self.last_diagnostic.as_ref() == Some(&diagnostic) {
            return;
        }
        self.last_diagnostic = Some(diagnostic.clone());
        let message =
            format!("[CodexEnhancements] Native compatibility {phase}: {reason}; state={state}");
        if self.active {
            crate::modules::logger::log_info(&message);
        } else {
            crate::modules::logger::log_warn(&message);
        }
        // Only the actually evaluated native module may set nativePatchState to
        // active. A successful CDP registration is not activation evidence.
        let Some(context) = self
            .context
            .filter(|value| self.session.as_ref().and_then(Session::context) == Some(*value))
        else {
            return;
        };
        let expression = format!("(()=>{{const s=window.__cockpitEnhancements;if(s?.owner==={})s.nativePatchDiagnostic={};return true;}})()", json!(self.owner), diagnostic);
        let _ = self
            .session()
            .evaluate(expression, context, COMMAND_TIMEOUT)
            .await;
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let Some(mut session) = self.session.take() else {
            return;
        };
        let script_id = self.script_id.take();
        let owner = self.owner.clone();
        let nonce = self.nonce.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                cleanup(&mut session, script_id, &owner, &nonce).await;
            });
        }
    }
}

async fn cleanup(session: &mut Session, script_id: Option<String>, owner: &str, nonce: &str) {
    let _ = timeout(CLEANUP_TIMEOUT, async {
        if let Some(context) = session.context() {
            let expression = format!("(()=>{{const s=window.__cockpitEnhancements;if(s?.owner==={}){{window.__cockpitNativeFast?.cancelHandoff?.({});s.nativeFast=false;s.quotaCompat=false;s.apiDictation=false;window.__cockpitNativeFastDispose?.();}}return true;}})()", json!(owner), json!(nonce));
            let _ = session.evaluate(expression, context, Duration::from_millis(500)).await;
        }
        if let Some(identifier) = script_id { session.registrations.insert(identifier); }
        loop {
            let identifiers: Vec<_> = session.registrations.iter().cloned().collect();
            for identifier in identifiers {
                let _ = session.command("Page.removeScriptToEvaluateOnNewDocument", json!({"identifier":identifier}), Duration::from_millis(500)).await;
            }
            if session.pending_additions.is_empty() { break; }
            // Replies can arrive out of order; do not rely on an evaluate reply
            // being a barrier for an earlier addScript command.
            if !matches!(session.receive().await, Ok(Some(_))) { break; }
        }
        let _ = session.socket.close(None).await;
    }).await;
}

fn safe_reason(value: &Value, fallback: &str) -> String {
    value
        .pointer("/diagnostics/reason")
        .or_else(|| value.get("reason"))
        .and_then(Value::as_str)
        .filter(|reason| {
            !reason.is_empty()
                && reason.len() <= 64
                && reason
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .unwrap_or(fallback)
        .to_string()
}

fn command_reason(error: &str) -> String {
    let operation = if error.ends_with("Page.addScriptToEvaluateOnNewDocument") {
        "registration"
    } else if error.ends_with("Runtime.evaluate") || error.contains("evaluation") {
        "evaluation"
    } else {
        "transport"
    };
    format!(
        "{operation}-{}",
        if error.contains("timed out") {
            "timeout"
        } else {
            "failed"
        }
    )
}

fn bootstrap(
    native_fast: bool,
    quota_compat: bool,
    api_dictation: bool,
    api_key_auth_verified: bool,
    owner: &str,
) -> String {
    let options = json!({"nativeFast":native_fast,"quotaCompat":quota_compat,"apiDictation":api_dictation,"apiKeyAuthVerified":api_key_auth_verified,"owner":owner});
    let state = STATE_SCRIPT.replace("__COCKPIT_STATE_OPTIONS__", &options.to_string());
    format!("{state}\n{GUARD_SCRIPT}\n{SCRIPT}\n{QUOTA_SCRIPT}\n{DICTATION_SCRIPT}\n;true;")
}

async fn rollback_preparation(registration: &mut Registration) {
    if let Some(context) = registration.session().context() {
        let expression = format!(
            "window.__cockpitNativeFast?.cancelHandoff?.({})",
            json!(registration.nonce)
        );
        let _ = registration
            .session()
            .evaluate(expression, context, COMMAND_TIMEOUT)
            .await;
    }
    let identifiers = registration.session().registrations.clone();
    for identifier in identifiers {
        let _ = registration
            .session()
            .command(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier":identifier}),
                COMMAND_TIMEOUT,
            )
            .await;
    }
    registration.script_id = None;
}

async fn prepare_future_document(
    registration: &mut Registration,
    context: ContextKey,
) -> Result<(), String> {
    // The renderer retains the large prepared module in its private closure.
    // Only bounded metadata crosses CDP; polling never copies the source again.
    let expression = format!(
        "window.__cockpitNativeFast.prepareHandoff({})",
        json!(registration.nonce)
    );
    let result = registration
        .session()
        .evaluate(expression, context, PREPARE_TIMEOUT)
        .await
        .map_err(|error| command_reason(&error))?;
    if registration.session().context() != Some(context) {
        return Err("context-changed".to_string());
    }
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = safe_reason(&result, "unsupported-document");
        rollback_preparation(registration).await;
        return Err(reason);
    }
    let invalid = if !result
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(local_initial)
    {
        Some("invalid-module-url")
    } else if !result
        .get("sourceLength")
        .and_then(Value::as_u64)
        .is_some_and(|length| length > 0 && length <= SOURCE_LIMIT as u64)
    {
        Some("invalid-module-source-length")
    } else {
        None
    };
    if let Some(reason) = invalid {
        rollback_preparation(registration).await;
        return Err(reason.to_string());
    }
    // This script stays small enough to execute before the app's document CSP.
    // The nonce-scoped handoff is only staged by the final guarded reload or a
    // subsequent local user navigation, and consume immediately restores name.
    let script = format!(
        "{}\n;window.__cockpitNativeFast.consumeHandoff({});",
        registration.runtime,
        json!(registration.nonce)
    );
    let reply = registration
        .session()
        .command(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source":script}),
            COMMAND_TIMEOUT,
        )
        .await;
    let setup = match reply {
        Ok(reply) => {
            registration.script_id = reply
                .pointer("/result/identifier")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
            registration
                .script_id
                .as_ref()
                .map(|_| ())
                .ok_or_else(|| "registration-failed".to_string())
        }
        Err(error) => Err(command_reason(&error)),
    };
    if setup.is_err() {
        rollback_preparation(registration).await;
    }
    setup
}

/// These are snapshots of a changing local page, not permanent failures.
/// Remain pending only within the original launch deadline and reload only
/// after the final atomic guard observes a clean page. Protocol/unsupported
/// failures are deliberately outside this set.
fn startup_transient(reason: &str) -> bool {
    matches!(
        reason,
        "document-loading"
            | "composer-unavailable"
            | "interaction-settling"
            | "ui-busy"
            | "draft-present"
            | "conversation-busy"
    )
}

async fn try_startup_reload(registration: &mut Registration, context: ContextKey) {
    let Some(startup) = registration.startup.as_ref() else {
        registration.report("document", "restart-required").await;
        return;
    };
    if !startup.available() {
        registration.startup = None;
        registration
            .report("document", "startup-permission-expired")
            .await;
        return;
    }
    if registration
        .next_startup_check
        .is_some_and(|next| Instant::now() < next)
    {
        return;
    }
    registration.next_startup_check = Some(Instant::now() + Duration::from_millis(500));
    let readiness = registration
        .session()
        .evaluate(
            "window.__cockpitNativeFast.inspectStartupReload()".to_string(),
            context,
            COMMAND_TIMEOUT,
        )
        .await;
    if registration.session().context() != Some(context) {
        return;
    }
    match readiness {
        Ok(value) if value.get("ok").and_then(Value::as_bool) == Some(true) => {}
        Ok(value) => {
            let reason = safe_reason(&value, "startup-inspection-failed");
            if !startup_transient(&reason) {
                registration.startup = None;
            }
            registration.report("document", &reason).await;
            return;
        }
        Err(_) => {
            registration.startup = None;
            registration
                .report("document", "startup-inspection-failed")
                .await;
            return;
        }
    }
    let startup = registration
        .startup
        .take()
        .expect("startup permission was inspected");
    if !startup.claim() {
        registration
            .report("document", "startup-permission-expired")
            .await;
        return;
    }
    // Claim is consumed before sending. A lost response can mean navigation
    // already started, so only a known explicit rejection may restore it.
    // The final JS helper checks and reloads in the same turn.
    let expression = format!(
        "window.__cockpitNativeFast.reloadPreparedDocument({})",
        json!(registration.nonce)
    );
    let result = registration
        .session()
        .evaluate(expression, context, COMMAND_TIMEOUT)
        .await;
    match result {
        Ok(value) if value.get("ok").and_then(Value::as_bool) == Some(true) => {
            registration.activation_until = Some(Instant::now() + ACTIVATION_TIMEOUT);
            registration.report("document", "reload-requested").await;
        }
        Ok(value) => {
            let reason = safe_reason(&value, "startup-page-not-clean");
            if value.get("ok").and_then(Value::as_bool) == Some(false)
                && startup_transient(&reason)
                && registration.session().context() == Some(context)
            {
                startup.release_rejected();
                registration.startup = Some(startup);
            }
            registration.report("document", &reason).await;
        }
        Err(_) => {
            registration.activation_until = Some(Instant::now() + ACTIVATION_TIMEOUT);
            registration
                .report("document", "reload-response-unavailable")
                .await;
        }
    }
}

async fn read_activation(
    registration: &mut Registration,
    context: ContextKey,
) -> Result<(), String> {
    if registration.active
        || registration
            .next_state_read
            .is_some_and(|next| Instant::now() < next)
    {
        return Ok(());
    }
    registration.next_state_read = Some(Instant::now() + Duration::from_millis(500));
    let expression = format!("(()=>{{const s=window.__cockpitEnhancements;return s?.owner==={} ? {{state:s.nativePatchState,reason:s.nativePatchReason}} : {{state:'pending'}};}})()", json!(registration.owner));
    let result = match registration
        .session()
        .evaluate(expression, context, COMMAND_TIMEOUT)
        .await
    {
        Ok(value) => value,
        Err(_) if registration.session().context() != Some(context) => return Ok(()),
        Err(error) => return Err(error),
    };
    if registration.session().context() != Some(context) {
        return Ok(());
    }
    match result.get("state").and_then(Value::as_str) {
        Some("active") => {
            registration.active = true;
            registration.activation_until = None;
            registration.report("activation", "module-evaluated").await;
        }
        Some("unsupported") => {
            registration.activation_until = None;
            registration
                .report(
                    "activation",
                    &safe_reason(&result, "module-load-unsupported"),
                )
                .await;
        }
        _ if registration
            .activation_until
            .is_some_and(|deadline| Instant::now() >= deadline) =>
        {
            registration.activation_until = None;
            registration
                .report("activation", "module-load-timeout")
                .await;
        }
        _ => {}
    }
    Ok(())
}

async fn maintain(registration: &mut Registration) -> Result<(), String> {
    let Some(context) = registration.session().context() else {
        return Ok(());
    };
    if registration.context != Some(context) {
        // A context replacement before our reload may be user navigation.
        // Do not turn its new page into another automatic startup reload.
        if registration.context.is_some() {
            registration.startup = None;
        }
        registration.context = Some(context);
        registration.document = Attempt::default();
        registration.bootstrapped = false;
        registration.active = false;
        registration.next_state_read = None;
        registration.last_diagnostic = None;
        registration.activation_until = registration
            .script_id
            .as_ref()
            .map(|_| Instant::now() + ACTIVATION_TIMEOUT);
    }
    if !registration.bootstrapped {
        let location = registration
            .session()
            .evaluate("location.href".to_string(), context, COMMAND_TIMEOUT)
            .await?;
        if !location.as_str().is_some_and(local_document) {
            return Err("native enhancement requires a local application target".to_string());
        }
        let expression = format!("(()=>{{const p=window.__cockpitNativeFast;return window.__cockpitEnhancements?.owner==={}&&typeof p?.prepareHandoff==='function'&&typeof p?.consumeHandoff==='function'&&typeof p?.cancelHandoff==='function';}})()", json!(registration.owner));
        let installed = registration
            .session()
            .evaluate(expression, context, COMMAND_TIMEOUT)
            .await?
            .as_bool()
            == Some(true);
        if !installed {
            let runtime = registration.runtime.clone();
            registration
                .session()
                .evaluate(runtime, context, COMMAND_TIMEOUT)
                .await?;
        }
        if registration.session().context() != Some(context) {
            return Ok(());
        }
        registration.bootstrapped = true;
        read_activation(registration, context).await?;
    }
    if registration.script_id.is_none()
        && registration.document.due()
        && registration.session().pending_additions.is_empty()
    {
        match prepare_future_document(registration, context).await {
            Ok(()) => {
                registration.document.done = true;
                registration.report("document", "registered").await;
                if !registration.active && registration.session().context() == Some(context) {
                    try_startup_reload(registration, context).await;
                }
            }
            Err(reason) => {
                let retryable = matches!(
                    reason.as_str(),
                    "unsupported-entry"
                        | "asset-unavailable"
                        | "context-changed"
                        | "evaluation-timeout"
                        | "transport-failed"
                );
                registration.document.failed(retryable);
                registration.report("document", &reason).await;
            }
        }
    }
    if registration.activation_until.is_some() && registration.session().context() == Some(context)
    {
        read_activation(registration, context).await?;
    }
    if registration.script_id.is_some()
        && !registration.active
        && registration.startup.is_some()
        && registration.session().context() == Some(context)
    {
        try_startup_reload(registration, context).await;
    }
    Ok(())
}

async fn initialize(registration: &mut Registration) -> Result<(), String> {
    registration
        .session()
        .command("Page.enable", json!({}), COMMAND_TIMEOUT)
        .await?;
    let tree = registration
        .session()
        .command("Page.getFrameTree", json!({}), COMMAND_TIMEOUT)
        .await?;
    registration.session().main_frame = tree
        .pointer("/result/frameTree/frame/id")
        .and_then(Value::as_str)
        .map(str::to_string);
    registration
        .session()
        .command("Runtime.enable", json!({}), COMMAND_TIMEOUT)
        .await?;
    maintain(registration).await
}

/// The parent verifies profile credentials and distinguishes a fresh process
/// launch from restoring an already-running target before supplying startup.
pub(super) async fn run(
    websocket_url: String,
    native_fast: bool,
    quota_compat: bool,
    api_dictation: bool,
    api_key_auth_verified: bool,
    startup: Option<Arc<StartupReload>>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    if !native_fast && !quota_compat && !api_dictation || *stop.borrow() {
        return Ok(());
    }
    if !local_websocket(&websocket_url) {
        return Err("native enhancement requires a loopback page target".to_string());
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024 * 1024))
        .max_frame_size(Some(64 * 1024 * 1024));
    let (socket, _) = timeout(
        COMMAND_TIMEOUT,
        connect_async_with_config(websocket_url, Some(config), false),
    )
    .await
    .map_err(|_| "native enhancement connection timed out".to_string())?
    .map_err(|_| "native enhancement connection failed".to_string())?;
    static GENERATION: AtomicU64 = AtomicU64::new(1);
    let owner = format!(
        "{}-{}",
        std::process::id(),
        GENERATION.fetch_add(1, Ordering::Relaxed)
    );
    let runtime = bootstrap(
        native_fast,
        quota_compat,
        api_dictation,
        api_key_auth_verified,
        &owner,
    );
    let mut registration = Registration {
        session: Some(Session {
            socket,
            command_id: 0,
            contexts: HashMap::new(),
            main_frame: None,
            generation: 0,
            registrations: HashSet::new(),
            pending_additions: HashSet::new(),
            pending_removals: HashMap::new(),
        }),
        script_id: None,
        owner,
        runtime,
        nonce: uuid::Uuid::new_v4().to_string(),
        startup,
        context: None,
        document: Attempt::default(),
        bootstrapped: false,
        active: false,
        activation_until: None,
        next_state_read: None,
        next_startup_check: None,
        last_diagnostic: None,
    };
    let initialized = tokio::select! { biased; _ = stop.changed() => Ok(()), result = initialize(&mut registration) => result };
    if initialized.is_err() || *stop.borrow() || stop.has_changed().is_err() {
        registration.cleanup().await;
        return initialized;
    }
    let mut retry = tokio::time::interval(Duration::from_millis(250));
    retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result = loop {
        if *stop.borrow() {
            break Ok(());
        }
        tokio::select! {
            biased;
            changed = stop.changed() => { if changed.is_err() || *stop.borrow() { break Ok(()); } }
            _ = retry.tick() => {
                let result = tokio::select! { biased; _ = stop.changed() => break Ok(()), result = maintain(&mut registration) => result };
                if let Err(error) = result { break Err(error); }
            }
            incoming = registration.session().receive() => {
                match incoming { Ok(Some(_)) => {}, Ok(None) => break Ok(()), Err(error) => break Err(error) }
            }
        }
    };
    registration.cleanup().await;
    result
}

fn local_websocket(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"));
    url.scheme() == "ws"
        && loopback
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with("/devtools/page/")
        && url.path().len() > "/devtools/page/".len()
}

fn local_document(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    (url.scheme() == "app" && url.host_str() == Some("-")
        || url.scheme() == "file" && url.host_str().is_none())
        && url.username().is_empty()
        && url.password().is_none()
}

fn local_initial(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let name = url.path().rsplit('/').next().unwrap_or_default();
    local_document(value)
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().contains("/assets/")
        && name.starts_with("app-initial-")
        && name.ends_with(".js")
        && name.len() > "app-initial-.js".len()
}

#[cfg(test)]
#[path = "fast_tests.rs"]
mod tests;
