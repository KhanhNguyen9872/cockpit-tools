// Per-instance, bounded background work. The CDP/render loop never awaits disk I/O.
struct InjectionUsagePoller {
    profile_dir: PathBuf,
    active: Vec<String>,
    snapshots: HashMap<String, usage::InjectionUsageSnapshot>,
    recent_accounts: HashMap<String, recent_account::RecentUsedAccount>,
    output_speeds: HashMap<String, output_speed::ThreadOutputSpeed>,
    pending: HashSet<String>,
    retry_after: HashMap<String, Instant>,
    next_index: usize,
    tasks: JoinSet<(
        String,
        Result<usage::InjectionUsageSnapshot, String>,
        Result<Option<recent_account::RecentUsedAccount>, String>,
        Result<Option<output_speed::ThreadOutputSpeed>, String>,
    )>,
    last_warning: Instant,
}

impl InjectionUsagePoller {
    fn new(profile_dir: &Path) -> Self {
        Self {
            profile_dir: profile_dir.to_path_buf(),
            active: Vec::new(),
            snapshots: HashMap::new(),
            recent_accounts: HashMap::new(),
            output_speeds: HashMap::new(),
            pending: HashSet::new(),
            retry_after: HashMap::new(),
            next_index: 0,
            tasks: JoinSet::new(),
            last_warning: Instant::now() - Duration::from_secs(30),
        }
    }

    fn collect(&mut self) -> Value {
        while let Some(completed) = self.tasks.try_join_next() {
            if let Ok((id, result, recent_result, speed_result)) = completed {
                self.pending.remove(&id);
                let usage_failed = result.is_err();
                let mut failure = None;
                match result {
                    Ok(snapshot) => {
                        self.ensure_cache_slot(&id);
                        self.snapshots.insert(id.clone(), snapshot);
                    }
                    Err(error) => failure = Some(error),
                }
                match recent_result {
                    Ok(Some(account)) => {
                        self.ensure_cache_slot(&id);
                        self.recent_accounts.insert(id.clone(), account);
                    }
                    Ok(None) => {
                        self.recent_accounts.remove(&id);
                    }
                    Err(error) => {
                        if failure.is_none() {
                            failure = Some(error);
                        }
                    }
                }
                let speed_failed = speed_result.is_err();
                match speed_result {
                    Ok(Some(speed)) => {
                        self.ensure_cache_slot(&id);
                        self.output_speeds.insert(id.clone(), speed);
                    }
                    Ok(None) => {
                        self.output_speeds.remove(&id);
                    }
                    Err(error) => {
                        // A failed timing/identity lookup must not retain an old speed.
                        self.output_speeds.remove(&id);
                        if failure.is_none() {
                            failure = Some(error);
                        }
                    }
                }
                if usage_failed || speed_failed {
                    self.retry_after
                        .insert(id.clone(), Instant::now() + Duration::from_secs(10));
                } else {
                    self.retry_after.remove(&id);
                }
                if let Some(error) = failure {
                    if self.last_warning.elapsed() >= Duration::from_secs(30) {
                        logger::log_warn(&format!(
                            "[Codex Usage] 本地用量读取失败，保留缓存: {}",
                            error
                        ));
                        self.last_warning = Instant::now();
                    }
                }
            }
        }
        Value::Object(
            self.active
                .iter()
                .filter_map(|id| {
                    let mut value = match self.snapshots.get(id) {
                        Some(snapshot) => serde_json::to_value(snapshot).ok()?,
                        None if self.recent_accounts.contains_key(id)
                            || self.output_speeds.contains_key(id) =>
                        {
                            json!({
                                "threadId": id, "events": [], "currentTurnId": null,
                            })
                        }
                        None => return None,
                    };
                    value.as_object_mut()?.insert(
                        "recentAccount".into(),
                        serde_json::to_value(self.recent_accounts.get(id)).ok()?,
                    );
                    value.as_object_mut()?.insert(
                        "outputSpeed".into(),
                        serde_json::to_value(self.output_speeds.get(id)).ok()?,
                    );
                    Some((id.clone(), value))
                })
                .collect(),
        )
    }

    fn ensure_cache_slot(&mut self, id: &str) {
        let keys: HashSet<_> = self
            .snapshots
            .keys()
            .chain(self.recent_accounts.keys())
            .chain(self.output_speeds.keys())
            .cloned()
            .collect();
        if keys.len() >= 32 && !keys.contains(id) {
            if let Some(old) = keys.iter().find(|key| !self.active.contains(key)) {
                self.snapshots.remove(old);
                self.recent_accounts.remove(old);
                self.output_speeds.remove(old);
            }
        }
    }

    fn request(&mut self, threads: Vec<String>) {
        self.active.clear();
        for id in threads {
            // CDP page values are untrusted: never accept a caller-supplied path.
            if uuid::Uuid::parse_str(&id).is_err() || self.active.contains(&id) {
                continue;
            }
            self.active.push(id);
            if self.active.len() == 8 {
                break;
            }
        }
        self.retry_after
            .retain(|id, until| self.active.contains(id) && *until > Instant::now());
        let count = self.active.len();
        if count == 0 {
            return;
        }
        for offset in 0..count {
            if self.tasks.len() >= 2 {
                break;
            }
            let index = (self.next_index + offset) % count;
            let id = &self.active[index];
            if self.pending.contains(id) || self.retry_after.contains_key(id) {
                continue;
            }
            self.pending.insert(id.clone());
            let id = id.clone();
            let profile_dir = self.profile_dir.clone();
            self.tasks.spawn(async move {
                let thread_id = id.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    (
                        usage::read_usage_snapshot(&profile_dir, &thread_id),
                        recent_account::read_recent_account(&profile_dir, &thread_id),
                        output_speed::read_output_speed(&profile_dir, &thread_id),
                    )
                })
                .await;
                match result {
                    Ok((usage, account, speed)) => (id, usage, account, speed),
                    Err(error) => {
                        let error = format!("usage worker failed: {}", error);
                        (id, Err(error.clone()), Err(error.clone()), Err(error))
                    }
                }
            });
        }
        self.next_index = (self.next_index + 2) % count;
    }
}

#[cfg(test)]
mod usage_poll_tests {
    use super::*;

    fn recent_account_fixture() -> recent_account::RecentUsedAccount {
        recent_account::RecentUsedAccount {
            account_id: "actual".into(),
            display_name: "actual@example.test".into(),
            email: Some("actual@example.test".into()),
            plan: Some("Team".into()),
            last_used_at_ms: 1000,
        }
    }

    #[tokio::test]
    async fn usage_poll_recent_errors_keep_account_without_delaying_usage() {
        let dir = tempfile::tempdir().unwrap();
        let id = "019e92aa-0000-7000-8000-000000000001".to_string();
        let mut poll = InjectionUsagePoller::new(dir.path());
        poll.active = vec![id.clone()];
        poll.recent_accounts
            .insert(id.clone(), recent_account_fixture());
        let task_id = id.clone();
        poll.tasks.spawn(async move {
            (
                task_id,
                Ok(usage::InjectionUsageSnapshot::default()),
                Err("database busy".into()),
                Ok(None),
            )
        });
        tokio::time::sleep(Duration::from_millis(1)).await;
        let state = poll.collect();
        assert_eq!(state[&id]["recentAccount"]["plan"], "Team");
        assert!(!poll.retry_after.contains_key(&id));
        let task_id = id.clone();
        poll.tasks.spawn(async move {
            (
                task_id,
                Ok(usage::InjectionUsageSnapshot::default()),
                Ok(None),
                Ok(None),
            )
        });
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert!(poll.collect()[&id]["recentAccount"].is_null());
        assert!(!poll.recent_accounts.contains_key(&id));
    }

    #[test]
    fn usage_poll_account_only_cache_has_a_bounded_union_with_rollout_cache() {
        let dir = tempfile::tempdir().unwrap();
        let mut poll = InjectionUsagePoller::new(dir.path());
        for n in 0..50 {
            let id = format!("019e92aa-0000-7000-8000-{n:012}");
            poll.active = vec![id.clone()];
            poll.ensure_cache_slot(&id);
            poll.recent_accounts.insert(id, recent_account_fixture());
        }
        assert_eq!(poll.recent_accounts.len(), 32);
        assert!(poll.snapshots.is_empty());
        assert_eq!(poll.collect().as_object().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn usage_poll_deduplicates_and_keeps_empty_snapshot_until_worker_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let id = "019e92aa-0000-7000-8000-000000000001".to_string();
        let mut poll = InjectionUsagePoller::new(dir.path());
        poll.request(vec![id.clone(), id.clone(), "../auth.json".into()]);
        assert_eq!(poll.active, vec![id.clone()]);
        assert_eq!(poll.pending.len(), 1);
        assert_eq!(poll.tasks.len(), 1);
        poll.request(vec![id.clone()]);
        assert_eq!(poll.tasks.len(), 1);
        let empty = poll.collect();
        assert!(empty.is_object());
        // The result is deliberately not awaited by collect or request.
        let (finished, snapshot, recent_account, speed) =
            poll.tasks.join_next().await.unwrap().unwrap();
        assert_eq!(finished, id);
        assert!(snapshot.unwrap().events.is_empty());
        assert!(recent_account.unwrap().is_none());
        assert!(speed.unwrap().is_none());
    }

    #[tokio::test]
    async fn usage_poll_limits_parallel_reads_and_does_not_expose_other_chats() {
        let dir = tempfile::tempdir().unwrap();
        let mut poll = InjectionUsagePoller::new(dir.path());
        poll.request(
            (1..=20)
                .map(|value| format!("019e92aa-0000-7000-8000-{value:012}"))
                .collect(),
        );
        assert_eq!(poll.tasks.len(), 2);
        assert_eq!(poll.active.len(), 8);
        poll.snapshots.insert(
            "another-chat".into(),
            usage::InjectionUsageSnapshot::default(),
        );
        assert!(poll.collect().get("another-chat").is_none());
        poll.request(Vec::new());
        assert_eq!(poll.collect(), json!({}));
    }
}
