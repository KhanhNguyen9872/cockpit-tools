// Only cold-start maintenance removes retired settings. Reads and catalog
// snapshots stay read-only, and an atomic update preserves concurrent changes.
static RETIRED_OAUTH_RESERVE_CLEANUP: AtomicBool = AtomicBool::new(false);

fn remove_retired_oauth_reserve_from_path(path: &Path) -> Result<bool, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let state: Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if state.get("boundOauthQuotaReserve").is_none()
        && state.get("bound_oauth_quota_reserve").is_none()
    {
        return Ok(false);
    }
    let mut removed = false;
    update_string_atomic(path, |current| {
        let current = current.ok_or_else(|| "API service configuration is missing".to_string())?;
        let mut state: Value = serde_json::from_str(current).map_err(|error| error.to_string())?;
        let object = state
            .as_object_mut()
            .ok_or_else(|| "API service configuration must be an object".to_string())?;
        removed = object.remove("boundOauthQuotaReserve").is_some();
        removed |= object.remove("bound_oauth_quota_reserve").is_some();
        if removed {
            serde_json::to_string_pretty(&state).map_err(|error| error.to_string())
        } else {
            Ok(current.to_owned())
        }
    })?;
    Ok(removed)
}

fn cleanup_retired_oauth_reserve_in_background() {
    if crate::get_app_handle().is_none()
        || RETIRED_OAUTH_RESERVE_CLEANUP.swap(true, Ordering::AcqRel)
    {
        return;
    }
    tauri::async_runtime::spawn(async {
        let worker = tokio::task::spawn_blocking(|| {
            let result = local_access_file_path()
                .and_then(|path| remove_retired_oauth_reserve_from_path(&path));
            if let Err(error) = result {
                // A later synchronization can retry a failed atomic update.
                RETIRED_OAUTH_RESERVE_CLEANUP.store(false, Ordering::Release);
                logger::log_codex_api_warn(&format!(
                    "[CodexLocalAccess] Retired OAuth reserve cleanup failed: {error}"
                ));
            }
        });
        match timeout(Duration::from_secs(5), worker).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                RETIRED_OAUTH_RESERVE_CLEANUP.store(false, Ordering::Release);
                logger::log_codex_api_warn("[CodexLocalAccess] Retired settings cleanup worker failed");
            }
            Err(_) => {
                // Blocking filesystem work cannot be canceled safely halfway
                // through an atomic write. Keep its single-flight claim while
                // it finishes; no caller or UI operation waits for this task.
                logger::log_codex_api_warn("[CodexLocalAccess] Retired settings cleanup is slow; continuing without waiting");
            }
        }
    });
}

#[cfg(test)]
mod retired_oauth_reserve_tests {
    use super::*;
    #[test]
    fn obsolete_policy_is_ignored_on_read_and_removed_atomically_without_changing_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("service.json");
        let mut state = json!({
            "enabled":false,"port":14999,"apiKey":"test-local-key",
            "accountIds":[],"createdAt":1,"updatedAt":1
        });
        state["boundOauthAccountId"] = json!("bound-fixture");
        state["boundOauthQuotaReserve"] =
            json!({"hourlyPercent":99,"weeklyPercent":99,"strict":true});
        state["futureSetting"] = json!({"preserve":true});
        let loaded: CodexLocalAccessCollection = serde_json::from_value(state.clone()).unwrap();
        assert_eq!(
            loaded.bound_oauth_account_id.as_deref(),
            Some("bound-fixture")
        );
        assert!(serde_json::to_value(&loaded)
            .unwrap()
            .get("boundOauthQuotaReserve")
            .is_none());
        std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(remove_retired_oauth_reserve_from_path(&path).unwrap());
        state
            .as_object_mut()
            .unwrap()
            .remove("boundOauthQuotaReserve");
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after, state);
        assert!(!remove_retired_oauth_reserve_from_path(&path).unwrap());
    }

    #[test]
    fn missing_or_corrupt_configuration_is_not_replaced_or_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("service.json");
        assert!(!remove_retired_oauth_reserve_from_path(&path).unwrap());
        std::fs::write(&path, "partial file").unwrap();
        assert!(remove_retired_oauth_reserve_from_path(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "partial file");
    }
}
