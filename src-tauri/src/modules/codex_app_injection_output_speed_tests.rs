use super::*;

const THREAD: &str = "019e92aa-0000-7000-8000-000000000001";
const CHILD_THREAD: &str = "019e92aa-0000-7000-8000-000000000002";

fn create_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE request_logs (
            id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
            client_instance_id TEXT NOT NULL, success INTEGER NOT NULL,
            error_category TEXT NOT NULL, output_tokens INTEGER NOT NULL,
            output_generation_ms INTEGER, request_id TEXT NOT NULL,
            api_key_id TEXT NOT NULL);
        CREATE INDEX idx_codex_local_access_logs_api_key
            ON request_logs(api_key_id,timestamp DESC);
        CREATE TABLE request_diagnostics (
            request_id TEXT PRIMARY KEY, client_identity_captured INTEGER,
            client_thread_id TEXT, client_identity_metadata_captured INTEGER,
            client_installation_id TEXT);",
    )
    .unwrap();
}

fn database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    create_schema(&conn);
    conn
}

struct Sample<'a> {
    key: &'a str,
    instance: &'a str,
    thread: Option<&'a str>,
    installation: Option<&'a str>,
    captured: Option<i64>,
    metadata_captured: Option<i64>,
    timestamp: i64,
    success: bool,
    error: &'a str,
    tokens: i64,
    generation_ms: Option<i64>,
}

impl Default for Sample<'_> {
    fn default() -> Self {
        Self {
            key: "key-a",
            instance: "instance-a",
            thread: Some(THREAD),
            installation: None,
            captured: Some(1),
            metadata_captured: Some(1),
            timestamp: 1000,
            success: true,
            error: "",
            tokens: 200,
            generation_ms: Some(2000),
        }
    }
}

fn append(conn: &Connection, request: &str, sample: Sample<'_>) {
    conn.execute(
        "INSERT INTO request_logs(timestamp,client_instance_id,success,error_category,
            output_tokens,output_generation_ms,request_id,api_key_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            sample.timestamp,
            sample.instance,
            sample.success,
            sample.error,
            sample.tokens,
            sample.generation_ms,
            request,
            sample.key
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO request_diagnostics VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![
            request,
            sample.captured,
            sample.thread,
            sample.metadata_captured,
            sample.installation
        ],
    )
    .unwrap();
}

fn scope() -> RequestScope {
    RequestScope {
        key_id: "key-a".into(),
        instance_id: Some("instance-a".into()),
        installation_id: None,
    }
}

fn read(conn: &Connection, scope: &RequestScope) -> Option<ThreadOutputSpeed> {
    read_samples(conn, THREAD, scope, Instant::now()).unwrap()
}

#[test]
fn output_speed_accepts_real_client_without_optional_installation_header() {
    let conn = database();
    append(&conn, "real-client", Sample::default());
    let speed = read(&conn, &scope()).unwrap();
    assert_eq!(speed.thread_id, THREAD);
    assert_eq!(speed.tokens_per_second, 100.0);
    assert_eq!(speed.samples, 1);
    assert_eq!(speed.observed_at_ms, 1000);
}

#[test]
fn output_speed_requires_explicit_installation_to_match_when_configured() {
    let conn = database();
    let mut expected = scope();
    expected.installation_id = Some("installation-a".into());
    append(&conn, "missing", Sample::default());
    append(
        &conn,
        "other",
        Sample {
            installation: Some("installation-b"),
            ..Default::default()
        },
    );
    assert!(read(&conn, &expected).is_none());
    append(
        &conn,
        "exact",
        Sample {
            installation: Some("installation-a"),
            ..Default::default()
        },
    );
    let speed = read(&conn, &expected).unwrap();
    assert_eq!(speed.samples, 1);
    assert_eq!(speed.tokens_per_second, 100.0);
}

#[test]
fn output_speed_isolates_key_instance_parent_and_child_threads() {
    let conn = database();
    for (request, sample) in [
        (
            "other-key",
            Sample {
                key: "key-b",
                ..Default::default()
            },
        ),
        (
            "other-instance",
            Sample {
                instance: "instance-b",
                ..Default::default()
            },
        ),
        (
            "child",
            Sample {
                thread: Some(CHILD_THREAD),
                ..Default::default()
            },
        ),
    ] {
        append(&conn, request, sample);
    }
    assert!(read(&conn, &scope()).is_none());
    append(
        &conn,
        "parent",
        Sample {
            tokens: 300,
            ..Default::default()
        },
    );
    let parent = read(&conn, &scope()).unwrap();
    assert_eq!(parent.samples, 1);
    assert_eq!(parent.tokens_per_second, 150.0);
    let child = read_samples(&conn, CHILD_THREAD, &scope(), Instant::now())
        .unwrap()
        .unwrap();
    assert_eq!(child.samples, 1);
    assert_eq!(child.tokens_per_second, 100.0);
}

#[test]
fn output_speed_never_guesses_missing_or_uncaptured_identity() {
    for sample in [
        Sample {
            captured: None,
            ..Default::default()
        },
        Sample {
            captured: Some(0),
            ..Default::default()
        },
        Sample {
            metadata_captured: None,
            ..Default::default()
        },
        Sample {
            metadata_captured: Some(0),
            ..Default::default()
        },
        Sample {
            thread: None,
            ..Default::default()
        },
        Sample {
            thread: Some("invalid-thread"),
            ..Default::default()
        },
    ] {
        let conn = database();
        append(&conn, "invalid", sample);
        assert!(read(&conn, &scope()).is_none());
    }
    let conn = database();
    append(&conn, "missing-diagnostics", Sample::default());
    conn.execute("DELETE FROM request_diagnostics", []).unwrap();
    assert!(read(&conn, &scope()).is_none());
}

#[test]
fn output_speed_uses_generation_timing_and_rejects_ineligible_samples() {
    for sample in [
        Sample {
            generation_ms: None,
            ..Default::default()
        },
        Sample {
            generation_ms: Some(99),
            ..Default::default()
        },
        Sample {
            generation_ms: Some(0),
            ..Default::default()
        },
        Sample {
            generation_ms: Some(-1),
            ..Default::default()
        },
        Sample {
            generation_ms: Some(MAX_SAFE_INTEGER + 1),
            ..Default::default()
        },
        Sample {
            tokens: 99,
            ..Default::default()
        },
        Sample {
            tokens: -1,
            ..Default::default()
        },
        Sample {
            tokens: MAX_SAFE_INTEGER + 1,
            ..Default::default()
        },
        Sample {
            success: false,
            ..Default::default()
        },
        Sample {
            error: "upstream_failure",
            ..Default::default()
        },
    ] {
        let conn = database();
        append(&conn, "ineligible", sample);
        assert!(read(&conn, &scope()).is_none());
    }
    let conn = database();
    append(
        &conn,
        "threshold",
        Sample {
            tokens: 100,
            generation_ms: Some(100),
            ..Default::default()
        },
    );
    assert_eq!(read(&conn, &scope()).unwrap().tokens_per_second, 1000.0);
}

#[test]
fn output_speed_weights_tokens_and_generation_time_instead_of_averaging_rates() {
    let conn = database();
    append(
        &conn,
        "fast",
        Sample {
            tokens: 1000,
            generation_ms: Some(1000),
            timestamp: 100,
            ..Default::default()
        },
    );
    append(
        &conn,
        "slow",
        Sample {
            tokens: 100,
            generation_ms: Some(9000),
            timestamp: 200,
            ..Default::default()
        },
    );
    append(
        &conn,
        "failed-newest",
        Sample {
            success: false,
            timestamp: 300,
            ..Default::default()
        },
    );
    let speed = read(&conn, &scope()).unwrap();
    assert_eq!(speed.tokens_per_second, 110.0);
    assert_eq!(speed.samples, 2);
    assert_eq!(speed.observed_at_ms, 200);
}

#[test]
fn output_speed_rejects_totals_outside_javascript_safe_range() {
    for (tokens, generation_ms) in [(MAX_SAFE_INTEGER, 100), (100, MAX_SAFE_INTEGER)] {
        let conn = database();
        for request in ["one", "two"] {
            append(
                &conn,
                request,
                Sample {
                    tokens,
                    generation_ms: Some(generation_ms),
                    ..Default::default()
                },
            );
        }
        assert!(read(&conn, &scope()).is_none());
    }
}

#[test]
fn output_speed_only_reads_latest_256_requests_for_the_selected_key() {
    let conn = database();
    append(
        &conn,
        "too-old",
        Sample {
            timestamp: 1,
            ..Default::default()
        },
    );
    for n in 0..RECENT_LOG_LIMIT {
        append(
            &conn,
            &format!("child-{n}"),
            Sample {
                thread: Some(CHILD_THREAD),
                timestamp: n + 2,
                ..Default::default()
            },
        );
    }
    assert!(read(&conn, &scope()).is_none());
    append(
        &conn,
        "current",
        Sample {
            timestamp: 1000,
            tokens: 400,
            ..Default::default()
        },
    );
    for n in 0..RECENT_LOG_LIMIT {
        append(
            &conn,
            &format!("other-key-{n}"),
            Sample {
                key: "key-b",
                timestamp: 2000 + n,
                ..Default::default()
            },
        );
    }
    let speed = read(&conn, &scope()).unwrap();
    assert_eq!(speed.samples, 1);
    assert_eq!(speed.tokens_per_second, 200.0);
}

#[test]
fn output_speed_old_schema_returns_none_without_migration() {
    for setup in ["CREATE TABLE request_logs(id INTEGER PRIMARY KEY)", ""] {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(setup).unwrap();
        let before: i64 = conn
            .query_row("PRAGMA schema_version", [], |row| row.get(0))
            .unwrap();
        assert!(read(&conn, &scope()).is_none());
        let after: i64 = conn
            .query_row("PRAGMA schema_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after);
    }
    for column in ["output_generation_ms", "client_identity_metadata_captured"] {
        let conn = database();
        let table = if column == "output_generation_ms" {
            "request_logs"
        } else {
            "request_diagnostics"
        };
        conn.execute_batch(&format!("ALTER TABLE {table} DROP COLUMN {column}"))
            .unwrap();
        assert!(read(&conn, &scope()).is_none());
    }
}

#[test]
fn output_speed_query_budget_does_not_return_stale_partial_result() {
    let conn = database();
    append(&conn, "sample", Sample::default());
    assert!(read_samples(
        &conn,
        THREAD,
        &scope(),
        Instant::now() - Duration::from_secs(1)
    )
    .is_err());
}

struct TestData {
    _directory: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}

impl TestData {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("COCKPIT_TOOLS_TEST_DATA_DIR");
        std::env::set_var("COCKPIT_TOOLS_TEST_DATA_DIR", directory.path());
        Self {
            _directory: directory,
            previous,
        }
    }
}

impl Drop for TestData {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var("COCKPIT_TOOLS_TEST_DATA_DIR", value),
            None => std::env::remove_var("COCKPIT_TOOLS_TEST_DATA_DIR"),
        }
    }
}

#[test]
fn output_speed_profile_resolution_accepts_optional_installation_but_requires_instance() {
    let _guard = crate::modules::test_support::env_lock().lock().unwrap();
    let data = TestData::new();
    let profile = tempfile::tempdir().unwrap();
    let config = r#"model_provider = "local"
[model_providers.local]
base_url = "http://127.0.0.1:58554/v1"
experimental_bearer_token = "synthetic-speed-token"
[model_providers.local.http_headers]
x-cockpit-instance-id = "instance-a"
"#;
    std::fs::write(profile.path().join("config.toml"), config).unwrap();
    // A real client may have this local file without sending it on the wire.
    std::fs::write(profile.path().join("installation_id"), "local-only-id").unwrap();
    std::fs::write(
        data._directory.path().join("codex_local_access.json"),
        r#"{"apiKeys":[{"id":"key-a","key":"synthetic-speed-token"}]}"#,
    )
    .unwrap();
    let conn = Connection::open(
        data._directory
            .path()
            .join("codex_local_access_logs.sqlite"),
    )
    .unwrap();
    create_schema(&conn);
    append(&conn, "current", Sample::default());
    drop(conn);

    let speed = read_output_speed(profile.path(), THREAD).unwrap().unwrap();
    assert_eq!(speed.tokens_per_second, 100.0);
    assert_eq!(speed.samples, 1);
    let explicit = format!("{config}x-codex-installation-id = \"explicit-installation\"\n");
    std::fs::write(profile.path().join("config.toml"), explicit).unwrap();
    assert!(read_output_speed(profile.path(), THREAD).unwrap().is_none());
    let conn = Connection::open(
        data._directory
            .path()
            .join("codex_local_access_logs.sqlite"),
    )
    .unwrap();
    conn.execute(
        "UPDATE request_diagnostics SET client_installation_id='explicit-installation'",
        [],
    )
    .unwrap();
    drop(conn);
    assert!(read_output_speed(profile.path(), THREAD).unwrap().is_some());

    std::fs::write(
        profile.path().join("config.toml"),
        config.replace("x-cockpit-instance-id = \"instance-a\"", ""),
    )
    .unwrap();
    assert!(read_output_speed(profile.path(), THREAD).unwrap().is_none());
    std::fs::write(
        profile.path().join("config.toml"),
        config.replace("synthetic-speed-token", "unregistered-token"),
    )
    .unwrap();
    assert!(read_output_speed(profile.path(), THREAD).unwrap().is_none());
    std::fs::write(
        profile.path().join("config.toml"),
        config.replace("127.0.0.1", "gateway.example.test"),
    )
    .unwrap();
    assert!(read_output_speed(profile.path(), THREAD).unwrap().is_none());
    assert!(read_output_speed(profile.path(), "not-a-thread-id").is_err());
}
