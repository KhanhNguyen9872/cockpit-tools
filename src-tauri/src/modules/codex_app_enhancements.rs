//! Optional desktop enhancements, scoped to a launched Codex profile and its CDP port.
//! Slow credential reads and all network work stay outside the launch transaction.

mod dictation;
mod fast;

use crate::modules::{app_lifecycle, codex_account, config, i18n, logger};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::task::JoinHandle;

const POLL: Duration = Duration::from_secs(3);
const RETRY: Duration = Duration::from_secs(30);

fn runtimes() -> &'static Mutex<HashMap<PathBuf, watch::Sender<bool>>> {
    static RUNTIMES: OnceLock<Mutex<HashMap<PathBuf, watch::Sender<bool>>>> = OnceLock::new();
    RUNTIMES.get_or_init(Default::default)
}

pub fn enabled() -> bool {
    let cfg = config::get_user_config();
    cfg.codex_app_native_fast_enabled
        || cfg.codex_app_api_quota_compat_enabled
        || cfg.codex_app_api_dictation_enabled
}

pub fn start_for_profile(profile: PathBuf, instance: String, port: u16, fresh_launch: bool) {
    stop_for_profile(&profile);
    if !enabled() {
        return;
    }
    let (stop, receiver) = watch::channel(false);
    if let Ok(mut active) = runtimes().lock() {
        active.insert(profile.clone(), stop);
    }
    let startup = fresh_launch.then(|| Arc::new(fast::StartupReload::new()));
    tauri::async_runtime::spawn(run_profile(profile, instance, port, startup, receiver));
}

pub fn stop_for_profile(profile: &Path) {
    if let Ok(mut active) = runtimes().lock() {
        if let Some(stop) = active.remove(profile) {
            let _ = stop.send(true);
        }
    }
}

pub fn stop_all() {
    if let Ok(mut active) = runtimes().lock() {
        for (_, stop) in active.drain() {
            let _ = stop.send(true);
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Profile {
    native_fast: bool,
    api_key_auth_verified: bool,
    quota_compat: bool,
    dictation: Option<Transport>,
    model: String,
    locale: String,
}

#[derive(Clone, PartialEq, Eq)]
struct Transport {
    endpoint: String,
    api_key: String,
}

impl Profile {
    fn active(&self) -> bool {
        self.native_fast || self.quota_compat || self.dictation.is_some()
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn profile_from_values(
    doc: &toml_edit::Document,
    auth: &Value,
    cfg: &config::UserConfig,
) -> Profile {
    let selected = doc
        .get("profile")
        .and_then(|item| item.as_str())
        .and_then(|name| doc.get("profiles")?.get(name));
    let provider_id = selected
        .and_then(|profile| profile.get("model_provider"))
        .or_else(|| doc.get("model_provider"))
        .and_then(|item| item.as_str())
        .unwrap_or("openai");
    let provider = doc
        .get("model_providers")
        .and_then(|providers| providers.get(provider_id));
    let requires_auth = provider
        .and_then(|provider| provider.get("requires_openai_auth"))
        .and_then(|item| item.as_bool());
    let oauth = nonempty(auth.pointer("/tokens/id_token").and_then(Value::as_str)).is_some()
        && nonempty(auth.pointer("/tokens/access_token").and_then(Value::as_str)).is_some();
    let api_auth = nonempty(auth.get("OPENAI_API_KEY").and_then(Value::as_str));
    let bearer = provider
        .and_then(|provider| provider.get("experimental_bearer_token"))
        .and_then(|item| nonempty(item.as_str()));
    let api_key_auth_verified =
        !oauth && (requires_auth == Some(false) || api_auth.is_some() || bearer.is_some());
    let base = provider
        .and_then(|provider| provider.get("base_url"))
        .and_then(|item| item.as_str())
        .or_else(|| doc.get("openai_base_url").and_then(|item| item.as_str()))
        .or_else(|| (provider_id == "openai").then_some("https://api.openai.com/v1"));
    let custom_api = provider_id != "openai"
        && bearer.is_some()
        && bearer != auth.pointer("/tokens/access_token").and_then(Value::as_str);
    let transport = base.zip(bearer.or(api_auth)).and_then(|(base, key)| {
        let mut url = url::Url::parse(base).ok()?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        url.set_path(&format!(
            "{}/audio/transcriptions",
            url.path().trim_end_matches('/')
        ));
        Some(Transport {
            endpoint: url.to_string(),
            api_key: key.to_owned(),
        })
    });
    Profile {
        native_fast: cfg.codex_app_native_fast_enabled && api_key_auth_verified,
        api_key_auth_verified,
        quota_compat: cfg.codex_app_api_quota_compat_enabled
            && requires_auth == Some(true)
            && oauth
            && custom_api
            && transport.is_some(),
        dictation: cfg
            .codex_app_api_dictation_enabled
            .then_some(transport)
            .flatten(),
        model: cfg.codex_app_api_dictation_model.clone(),
        locale: cfg.language.clone(),
    }
}

fn read_profile(profile: &Path) -> Result<Profile, ()> {
    let cfg = config::get_user_config();
    let text = std::fs::read_to_string(profile.join("config.toml")).map_err(|_| ())?;
    let doc = crate::modules::codex_config_format::read_codex_config_doc_from_str(&text)
        .map_err(|_| ())?;
    // Respect file/keyring/auto selection on both macOS and Windows.
    let auth = codex_account::read_configured_codex_auth_value(profile)
        .map_err(|_| ())?
        .unwrap_or(Value::Null);
    Ok(profile_from_values(&doc, &auth, &cfg))
}

#[derive(Deserialize)]
struct Target {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    socket: Option<String>,
}

fn safe_socket(value: &str, port: u16) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "ws"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with("/devtools/page/")
}

async fn targets(client: &reqwest::Client, port: u16) -> Option<HashSet<String>> {
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .ok()?;
    let values = response
        .error_for_status()
        .ok()?
        .json::<Vec<Target>>()
        .await
        .ok()?;
    Some(
        values
            .into_iter()
            .filter(|target| {
                matches!(target.kind.as_str(), "page" | "webview")
                    && target.url.starts_with("app://-/")
            })
            .filter_map(|target| target.socket.filter(|socket| safe_socket(socket, port)))
            .collect(),
    )
}

struct Child {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Child {
    fn stop(self) {
        let _ = self.stop.send(true);
    }
}

fn labels(locale: &str) -> Value {
    let mut labels = serde_json::Map::new();
    for key in [
        "start",
        "stop",
        "cancel",
        "requesting",
        "recording",
        "transcribing",
        "failed",
        "unsupported",
        "microphoneDenied",
        "microphoneMissing",
        "textReady",
        "tooLarge",
        "insertFailed",
        "timedOut",
    ] {
        let suffix = format!("{}{}", key[..1].to_uppercase(), &key[1..]);
        labels.insert(
            key.to_owned(),
            Value::String(i18n::translate(
                locale,
                &format!("settings.general.codexEnhancements.dictation{suffix}"),
                &[],
            )),
        );
    }
    Value::Object(labels)
}

fn dictation_client(endpoint: &str) -> Option<reqwest::Client> {
    let url = url::Url::parse(endpoint).ok()?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none());
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if loopback {
        builder = builder.no_proxy();
    } else {
        // API transports use the application's global proxy, never an OAuth account's egress binding.
        let cfg = config::get_user_config();
        if cfg.global_proxy_enabled {
            let proxy = reqwest::Proxy::all(&cfg.global_proxy_url)
                .ok()?
                .no_proxy(reqwest::NoProxy::from_string(&cfg.global_proxy_no_proxy));
            builder = builder.proxy(proxy);
        }
    }
    builder.build().ok()
}

async fn run_profile(
    profile_dir: PathBuf,
    instance: String,
    port: u16,
    startup: Option<Arc<fast::StartupReload>>,
    mut stop: watch::Receiver<bool>,
) {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let mut children: HashMap<String, Child> = HashMap::new();
    let mut retry_at: HashMap<String, Instant> = HashMap::new();
    let mut current: Option<Profile> = None;
    let mut read: Option<JoinHandle<Result<Profile, ()>>> = None;
    let mut read_started = Instant::now();
    // New launches discover the first completed credential read promptly, before
    // the user starts editing. Later refreshes retain the ordinary polling rate.
    let mut initial_polling = startup.is_some();
    let mut tick = tokio::time::interval(if initial_polling {
        Duration::from_millis(100)
    } else {
        POLL
    });
    loop {
        tokio::select! { biased;
            _ = stop.changed() => break,
            _ = tick.tick() => {}
        }
        if *stop.borrow() || app_lifecycle::is_shutdown_started() {
            break;
        }
        if read.as_ref().is_some_and(JoinHandle::is_finished) {
            let next = read.take().unwrap().await.ok().and_then(Result::ok);
            if initial_polling {
                initial_polling = false;
                tick = tokio::time::interval(POLL);
                tick.reset();
            }
            if next != current {
                for (_, child) in children.drain() {
                    child.stop();
                }
                retry_at.clear();
                current = next;
            }
        } else if read.is_some() && read_started.elapsed() > Duration::from_secs(10) {
            // A stalled keyring probe remains single-flight; revoke active adapters
            // while waiting rather than launching more blocking credential reads.
            for (_, child) in children.drain() {
                child.stop();
            }
            current = None;
        }
        if read.is_none() {
            let path = profile_dir.clone();
            read_started = Instant::now();
            read = Some(tokio::task::spawn_blocking(move || read_profile(&path)));
        }
        let Some(profile) = current.as_ref().filter(|profile| profile.active()) else {
            continue;
        };
        let Some(available) = targets(&client, port).await else {
            continue;
        };
        let ended: Vec<_> = children
            .iter()
            .filter(|(key, child)| {
                child.task.is_finished() || !available.iter().any(|socket| key.ends_with(socket))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in ended {
            if let Some(child) = children.remove(&key) {
                child.stop();
            }
            retry_at.insert(key, Instant::now() + RETRY);
        }
        for socket in available {
            for kind in ["controls", "dictation"] {
                if kind == "controls"
                    && !profile.native_fast
                    && !profile.quota_compat
                    && profile.dictation.is_none()
                {
                    continue;
                }
                if kind == "dictation" && profile.dictation.is_none() {
                    continue;
                }
                let key = format!("{kind}:{socket}");
                if children.contains_key(&key)
                    || retry_at.get(&key).is_some_and(|at| *at > Instant::now())
                {
                    continue;
                }
                let (child_stop, receiver) = watch::channel(false);
                let socket = socket.clone();
                let profile = profile.clone();
                let instance = instance.clone();
                let startup = startup.clone();
                let task = tokio::spawn(async move {
                    let result = if kind == "controls" {
                        fast::run(
                            socket,
                            profile.native_fast,
                            profile.quota_compat,
                            profile.dictation.is_some(),
                            profile.api_key_auth_verified,
                            startup,
                            receiver,
                        )
                        .await
                    } else if let Some(transport) = profile.dictation {
                        match dictation_client(&transport.endpoint) {
                            Some(client) => {
                                dictation::run(
                                    socket,
                                    dictation::DictationConfig {
                                        endpoint: transport.endpoint,
                                        api_key: transport.api_key,
                                        model: profile.model,
                                        labels: labels(&profile.locale),
                                        client,
                                    },
                                    receiver,
                                )
                                .await
                            }
                            None => Err("dictation transport unavailable".into()),
                        }
                    } else {
                        Ok(())
                    };
                    if result.is_err() {
                        logger::log_warn(&format!("[Codex enhancements] setup_failed: instance={instance}, component={kind}"));
                    }
                });
                children.insert(
                    key,
                    Child {
                        stop: child_stop,
                        task,
                    },
                );
            }
        }
    }
    for (_, child) in children {
        child.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn enhancement_scope_requires_actual_auth_and_separate_api_transport() {
        let mut cfg = config::UserConfig::default();
        cfg.codex_app_native_fast_enabled = true;
        cfg.codex_app_api_quota_compat_enabled = true;
        cfg.codex_app_api_dictation_enabled = true;
        let doc: toml_edit::Document = "model_provider='relay'\n[model_providers.relay]\nbase_url='http://127.0.0.1:8000/v1'\nexperimental_bearer_token='local-key'\nrequires_openai_auth=true\n".parse().unwrap();
        let oauth = json!({"tokens":{"id_token":"id", "access_token":"access"}});
        let profile = profile_from_values(&doc, &oauth, &cfg);
        assert!(!profile.native_fast);
        assert!(!profile.api_key_auth_verified);
        assert!(profile.quota_compat);
        assert_eq!(
            profile.dictation.unwrap().endpoint,
            "http://127.0.0.1:8000/v1/audio/transcriptions"
        );
        let api = json!({"auth_mode":"apikey","OPENAI_API_KEY":"api-key"});
        let profile = profile_from_values(&doc, &api, &cfg);
        assert!(profile.native_fast);
        assert!(profile.api_key_auth_verified);
        assert!(!profile.quota_compat);
        assert!(!profile_from_values(&toml_edit::Document::new(), &oauth, &cfg).quota_compat);
        let same_token: toml_edit::Document = doc
            .to_string()
            .replace("local-key", "access")
            .parse()
            .unwrap();
        assert!(!profile_from_values(&same_token, &oauth, &cfg).quota_compat);
    }

    #[test]
    fn pure_api_verification_uses_profile_evidence_and_oauth_takes_precedence() {
        let cfg = config::UserConfig::default();
        let blank = toml_edit::Document::new();
        assert!(!profile_from_values(&blank, &Value::Null, &cfg).api_key_auth_verified);
        assert!(
            !profile_from_values(&blank, &json!({"OPENAI_API_KEY":"  "}), &cfg)
                .api_key_auth_verified
        );
        assert!(
            profile_from_values(&blank, &json!({"OPENAI_API_KEY":"api-key"}), &cfg)
                .api_key_auth_verified
        );
        let no_oauth: toml_edit::Document =
            "model_provider='local'\n[model_providers.local]\nrequires_openai_auth=false\n"
                .parse()
                .unwrap();
        assert!(profile_from_values(&no_oauth, &Value::Null, &cfg).api_key_auth_verified);
        let bearer: toml_edit::Document = "model_provider='relay'\n[model_providers.relay]\nexperimental_bearer_token='provider-key'\n".parse().unwrap();
        let profile = profile_from_values(&bearer, &Value::Null, &cfg);
        assert!(profile.api_key_auth_verified);
        assert!(profile.native_fast);
        let oauth =
            json!({"OPENAI_API_KEY":"api-key","tokens":{"id_token":"id","access_token":"access"}});
        let profile = profile_from_values(&bearer, &oauth, &cfg);
        assert!(!profile.api_key_auth_verified);
        assert!(!profile.native_fast);
    }

    #[test]
    fn cdp_target_must_stay_on_the_launched_instances_loopback_port() {
        assert!(safe_socket("ws://127.0.0.1:9333/devtools/page/one", 9333));
        for url in [
            "ws://127.0.0.1:9334/devtools/page/one",
            "ws://evil.test:9333/devtools/page/one",
            "ws://user@127.0.0.1:9333/devtools/page/one",
            "ws://127.0.0.1:9333/devtools/browser/one",
        ] {
            assert!(!safe_socket(url, 9333));
        }
    }

    #[test]
    fn dictation_does_not_accept_embedded_credentials_or_url_queries() {
        let mut cfg = config::UserConfig::default();
        cfg.codex_app_api_dictation_enabled = true;
        for base in [
            "https://user:secret@example.test/v1",
            "https://example.test/v1?key=secret",
            "file:///tmp/audio",
        ] {
            let doc: toml_edit::Document = format!("model_provider='relay'\n[model_providers.relay]\nbase_url='{base}'\nexperimental_bearer_token='api-key'\n").parse().unwrap();
            assert!(profile_from_values(&doc, &Value::Null, &cfg)
                .dictation
                .is_none());
        }
    }
}
