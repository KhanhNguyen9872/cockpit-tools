//! Keep the native CLI's speed capabilities aligned with the desktop picker.
//! A renderer-only model patch cannot affect the CLI's request validation.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub(crate) const FILE_NAME: &str = "cockpit-native-speed-models.json";

pub(crate) fn is_reference(base_dir: &Path, reference: &str) -> bool {
    reference == FILE_NAME || Path::new(reference) == base_dir.join(FILE_NAME)
}

fn read_doc(base_dir: &Path) -> Result<toml_edit::Document, String> {
    let text = std::fs::read_to_string(base_dir.join("config.toml")).map_err(|e| e.to_string())?;
    crate::modules::codex_config_format::read_codex_config_doc_from_str(&text)
        .map_err(|e| e.to_string())
}

pub(crate) fn clear_reference(base_dir: &Path) -> Result<(), String> {
    if !base_dir.join("config.toml").is_file() {
        return Ok(());
    }
    let mut doc = read_doc(base_dir)?;
    if doc
        .get("model_catalog_json")
        .and_then(|v| v.as_str())
        .is_some_and(|reference| is_reference(base_dir, reference))
    {
        doc.remove("model_catalog_json");
        let text = crate::modules::codex_config_format::codex_config_doc_to_string(&mut doc);
        crate::modules::codex_config_format::write_codex_config_toml_atomic(
            &base_dir.join("config.toml"),
            &text,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Preserve the exact native model set, order and other capabilities.
fn supplement(catalog: &mut Value) -> Result<bool, String> {
    let templates = crate::modules::codex_protocol::build_codex_client_models_response(
        &crate::modules::codex_protocol::managed_codex_model_ids(),
    );
    let models = catalog
        .get_mut("models")
        .and_then(Value::as_array_mut)
        .ok_or("原生模型目录缺少 models")?;
    let mut changed = false;
    for model in models {
        let Some(slug) = model.get("slug").and_then(Value::as_str) else {
            continue;
        };
        let template = templates["models"].as_array().and_then(|models| {
            models
                .iter()
                .find(|model| model["slug"].as_str() == Some(slug))
        });
        let Some(tier) = template
            .and_then(|model| model["service_tiers"].as_array())
            .and_then(|tiers| tiers.iter().find(|tier| tier["id"] == "ultrafast"))
        else {
            continue;
        };
        let Some(object) = model.as_object_mut() else {
            continue;
        };
        let tiers = object
            .entry("additional_speed_tiers")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or("原生 additional_speed_tiers 格式错误")?;
        if !tiers.iter().any(|v| v == "ultrafast") {
            tiers.push(Value::String("ultrafast".into()));
            changed = true;
        }
        let tiers = object
            .entry("service_tiers")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or("原生 service_tiers 格式错误")?;
        if !tiers.iter().any(|v| v["id"] == "ultrafast") {
            tiers.push(tier.clone());
            changed = true;
        }
    }
    Ok(changed)
}

fn install(base_dir: &Path, mut catalog: Value) -> Result<(), String> {
    let mut doc = read_doc(base_dir)?;
    // A configured catalog already owns the CLI's capabilities. Never replace it.
    let reference = doc.get("model_catalog_json").and_then(|v| v.as_str());
    if reference.is_some_and(|v| !v.trim().is_empty() && !is_reference(base_dir, v)) {
        return Ok(());
    }
    if doc
        .get("profile")
        .and_then(|v| v.as_str())
        .and_then(|profile| doc.get("profiles")?.get(profile)?.get("model_catalog_json"))
        .and_then(|v| v.as_str())
        .is_some_and(|v| !v.trim().is_empty())
    {
        return Ok(());
    }
    if !supplement(&mut catalog)? {
        return clear_reference(base_dir);
    }
    let serialized = serde_json::to_string_pretty(&catalog).map_err(|e| e.to_string())?;
    crate::modules::atomic_write::write_string_atomic(&base_dir.join(FILE_NAME), &serialized)?;
    doc["model_catalog_json"] = toml_edit::value(FILE_NAME);
    let text = crate::modules::codex_config_format::codex_config_doc_to_string(&mut doc);
    crate::modules::codex_config_format::write_codex_config_toml_atomic(
        &base_dir.join("config.toml"),
        &text,
    )
    .map_err(|e| e.to_string())
}

fn enable_native_speed_feature(base_dir: &Path) -> Result<(), String> {
    let mut doc = read_doc(base_dir)?;
    if doc
        .get("features")
        .and_then(|v| v.get("fast_mode"))
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        return Ok(());
    }
    if doc.get("features").is_none() {
        doc["features"] = toml_edit::table();
    }
    doc["features"]["fast_mode"] = toml_edit::value(true);
    let text = crate::modules::codex_config_format::codex_config_doc_to_string(&mut doc);
    crate::modules::codex_config_format::write_codex_config_toml_atomic(
        &base_dir.join("config.toml"),
        &text,
    )
    .map_err(|e| e.to_string())
}

fn bundled_cli_candidates() -> Vec<PathBuf> {
    let configured = crate::modules::config::get_user_config().codex_app_path;
    let gui = if !configured.trim().is_empty() && Path::new(&configured).exists() {
        Some(PathBuf::from(configured))
    } else {
        crate::modules::process::detect_codex_exec_path()
    };
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    if let Some(root) = dirs::data_local_dir().map(|p| p.join("OpenAI/Codex/bin")) {
        let mut runtimes: Vec<_> = std::fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path().join("codex.exe"))
            .filter_map(|path| Some((std::fs::metadata(&path).ok()?.modified().ok()?, path)))
            .collect();
        runtimes.sort_by(|a, b| b.0.cmp(&a.0));
        candidates.extend(runtimes.into_iter().map(|(_, path)| path));
    }
    if let Some(gui) = gui {
        if let Some(bundle) = gui
            .ancestors()
            .find(|p| p.extension().is_some_and(|s| s == "app"))
        {
            candidates.push(
                bundle.join("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
            );
            candidates.push(bundle.join("Contents/Resources/codex"));
        } else if let Some(parent) = gui.parent() {
            candidates.push(parent.join("resources/codex.exe"));
            candidates.push(parent.join("resources/codex"));
        }
    }
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .collect()
}

fn export_bundled_catalog(binary: &Path, scratch: &Path) -> Result<Value, String> {
    std::fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    let output = crate::modules::process_timeout::output_with_timeout(
        Command::new(binary)
            .args(["debug", "models", "--bundled"])
            .env("CODEX_HOME", scratch)
            .current_dir(scratch),
        Duration::from_secs(4),
    )
    .map_err(|e| format!("读取原生模型能力失败: {e}"))?;
    if !output.status.success() {
        return Err("客户端不支持导出原生模型能力".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("原生模型能力格式错误: {e}"))
}

pub(crate) fn prepare_for_profile(base_dir: &Path) -> Result<(), String> {
    if !crate::modules::codex_app_enhancements::native_fast_enabled_for_profile(base_dir) {
        return clear_reference(base_dir);
    }
    // This enables the picker, not an accelerated tier. Standard still omits
    // service_tier; subsequent native picker changes must not hit a disabled gate.
    enable_native_speed_feature(base_dir)?;
    let doc = read_doc(base_dir)?;
    if doc
        .get("model_catalog_json")
        .and_then(|v| v.as_str())
        .is_some_and(|v| !v.trim().is_empty() && !is_reference(base_dir, v))
    {
        return Ok(());
    }
    let scratch = crate::modules::config::get_data_dir()?.join("native-speed-catalog-export");
    let mut last_error = "未找到 Codex 原生 CLI".to_string();
    for binary in bundled_cli_candidates() {
        match export_bundled_catalog(&binary, &scratch) {
            Ok(catalog) => return install(base_dir, catalog),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        json!({"models":[
            {"slug":"gpt-6.1-sol","instructions":"native","hidden":false,"additional_speed_tiers":["fast"],"service_tiers":[{"id":"priority","name":"Native Fast"}]},
            {"slug":"custom-model","hidden":true,"additional_speed_tiers":["fast"],"service_tiers":[{"id":"priority"}]},
            {"slug":"gpt-6-astra","additional_speed_tiers":["fast","ultrafast"],"service_tiers":[{"id":"ultrafast","name":"Native Ultrafast"}]}
        ]})
    }
    #[test]
    fn fills_native_cli_capabilities_without_changing_model_set_or_other_fields() {
        let mut catalog = fixture();
        let original = catalog.clone();
        assert!(supplement(&mut catalog).unwrap());
        assert_eq!(
            catalog["models"][0]["additional_speed_tiers"],
            json!(["fast", "ultrafast"])
        );
        assert_eq!(catalog["models"][0]["instructions"], "native");
        assert_eq!(catalog["models"][1], original["models"][1]);
        assert_eq!(catalog["models"][2], original["models"][2]);
        assert_eq!(catalog["models"].as_array().unwrap().len(), 3);
        assert!(!supplement(&mut catalog).unwrap());
    }
    #[test]
    fn respects_custom_catalog_and_restores_only_our_reference() {
        let dir =
            std::env::temp_dir().join(format!("cockpit-speed-catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.toml");
        std::fs::write(
            &config,
            "model = 'custom-model'\nmodel_catalog_json = 'user-models.json'\n",
        )
        .unwrap();
        let before = std::fs::read(&config).unwrap();
        install(&dir, fixture()).unwrap();
        clear_reference(&dir).unwrap();
        assert_eq!(std::fs::read(&config).unwrap(), before);
        assert!(!dir.join(FILE_NAME).exists());
        std::fs::write(
            &config,
            "model = 'gpt-6.1-sol'\nservice_tier = 'ultrafast'\n",
        )
        .unwrap();
        install(&dir, fixture()).unwrap();
        assert_eq!(
            read_doc(&dir).unwrap()["model_catalog_json"].as_str(),
            Some(FILE_NAME)
        );
        clear_reference(&dir).unwrap();
        let restored = read_doc(&dir).unwrap();
        assert!(restored.get("model_catalog_json").is_none());
        assert_eq!(restored["service_tier"].as_str(), Some("ultrafast"));
    }

    #[test]
    fn enabling_picker_keeps_standard_and_custom_catalog_unchanged() {
        let dir =
            std::env::temp_dir().join(format!("cockpit-speed-feature-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), "service_tier = 'default'\nmodel_catalog_json = 'user.json'\n[features]\nfast_mode = false\nother_feature = true\n").unwrap();
        enable_native_speed_feature(&dir).unwrap();
        let doc = read_doc(&dir).unwrap();
        assert_eq!(doc["service_tier"].as_str(), Some("default"));
        assert_eq!(doc["model_catalog_json"].as_str(), Some("user.json"));
        assert_eq!(doc["features"]["fast_mode"].as_bool(), Some(true));
        assert_eq!(doc["features"]["other_feature"].as_bool(), Some(true));
    }

    #[test]
    #[ignore = "requires COCKPIT_TIER_TEST_CLI; sends only to a disposable loopback server"]
    fn real_cli_sends_selected_tier_with_native_capability_catalog() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::process::Stdio;
        let binary =
            PathBuf::from(std::env::var_os("COCKPIT_TIER_TEST_CLI").expect("test CLI path"));
        let root = std::env::temp_dir().join(format!("cockpit-tier-wire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let catalog = export_bundled_catalog(&binary, &root.join("export")).unwrap();
        for tier in ["default", "priority", "ultrafast"] {
            let profile = root.join(tier);
            std::fs::create_dir_all(&profile).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let receive = std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                started.elapsed() < Duration::from_secs(10),
                                "no native request"
                            );
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("accept: {error}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                    assert!(headers.len() < 65536);
                }
                let headers = String::from_utf8(headers).unwrap();
                assert!(headers.starts_with("POST /v1/responses "));
                let size: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; size];
                socket.read_exact(&mut body).unwrap();
                socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
                serde_json::from_slice::<Value>(&body).unwrap()
            });
            std::fs::write(profile.join("config.toml"), format!(
                "model = 'gpt-6.1-sol'\nmodel_provider = 'probe'\nservice_tier = '{tier}'\nmodel_reasoning_effort = 'low'\n[features]\nfast_mode = true\n[model_providers.probe]\nname = 'Loopback test'\nbase_url = 'http://127.0.0.1:{port}/v1'\nwire_api = 'responses'\nrequires_openai_auth = false\n"
            )).unwrap();
            install(&profile, catalog.clone()).unwrap();
            let mut command = Command::new(&binary);
            command
                .args([
                    "exec",
                    "--skip-git-repo-check",
                    "--ephemeral",
                    "--sandbox",
                    "read-only",
                    "--json",
                    "Reply OK",
                ])
                .env("CODEX_HOME", &profile)
                .env("NO_PROXY", "127.0.0.1,localhost")
                .current_dir(&profile)
                .stdin(Stdio::null());
            crate::modules::process_timeout::output_with_timeout(
                &mut command,
                Duration::from_secs(12),
            )
            .unwrap();
            let body = receive.join().unwrap();
            assert_eq!(body["model"], "gpt-6.1-sol");
            if tier == "default" {
                assert!(body.get("service_tier").is_none());
            } else {
                assert_eq!(body["service_tier"], tier);
            }
        }
    }
}
