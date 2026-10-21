//! Per-thread output throughput from recorded generation timing only. The
//! caller runs this read-only, bounded work on its background blocking worker.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;

use super::recent_account::{open_gateway_logs, RequestScope};

const RECENT_LOG_LIMIT: i64 = 256;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const QUERY_BUDGET: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadOutputSpeed {
    pub thread_id: String,
    pub tokens_per_second: f64,
    pub samples: u32,
    pub observed_at_ms: i64,
}

pub(super) fn read_output_speed(
    profile: &Path,
    thread_id: &str,
) -> Result<Option<ThreadOutputSpeed>, String> {
    let thread = uuid::Uuid::parse_str(thread_id)
        .map_err(|_| "invalid output-speed thread ID".to_string())?
        .hyphenated()
        .to_string();
    let Some((conn, scope)) = open_gateway_logs(profile)? else {
        return Ok(None);
    };
    // Only a configured instance header proves this profile's wire identity.
    // Codex does not necessarily send its local installation_id file as a
    // request header. Check installation only when explicitly configured;
    // treating that optional field as mandatory rejects every such request.
    if scope.instance_id.is_none() {
        return Ok(None);
    }

    let started = Instant::now();
    let interrupt = conn.get_interrupt_handle();
    let (finished, completion) = std::sync::mpsc::channel::<()>();
    // Bound SQLite execution as well as the Rust row loop. The timer is woken
    // immediately on completion; it cannot outlive or interrupt another query.
    std::thread::scope(|threads| {
        let _timer = std::thread::Builder::new()
            .name("codex-output-speed-budget".into())
            .spawn_scoped(threads, move || {
                if matches!(
                    completion.recv_timeout(QUERY_BUDGET),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ) {
                    interrupt.interrupt();
                }
            })
            .map_err(|error| format!("output-speed query timer unavailable: {error}"))?;
        let result = read_samples(&conn, &thread, &scope, started);
        let _ = finished.send(());
        result
    })
}

fn read_samples(
    conn: &Connection,
    thread_id: &str,
    scope: &RequestScope,
    started: Instant,
) -> Result<Option<ThreadOutputSpeed>, String> {
    // LIMIT stays inside the indexed subquery. Thus a sparse/old thread never
    // scans the full log history. The diagnostic join uses its primary key and
    // reads identity columns only, never payloads or attempt JSON.
    let query = r#"SELECT recent.timestamp, recent.client_instance_id,
            recent.success, recent.error_category, recent.output_tokens,
            recent.output_generation_ms, d.client_identity_captured,
            d.client_thread_id, d.client_identity_metadata_captured,
            d.client_installation_id
        FROM (SELECT timestamp,client_instance_id,success,error_category,
                     output_tokens,output_generation_ms,request_id
              FROM request_logs INDEXED BY idx_codex_local_access_logs_api_key
              WHERE api_key_id=?1 ORDER BY timestamp DESC LIMIT ?2) AS recent
        LEFT JOIN request_diagnostics AS d
            INDEXED BY sqlite_autoindex_request_diagnostics_1
            ON d.request_id=recent.request_id"#;
    let mut statement = match conn.prepare(query) {
        Ok(statement) => statement,
        Err(error) => {
            let message = error.to_string();
            if message.contains("no such table")
                || message.contains("no such column")
                || message.contains("no such index")
            {
                return Ok(None);
            }
            return Err(format!("output-speed query unavailable: {error}"));
        }
    };
    let mut rows = statement
        .query(rusqlite::params![scope.key_id, RECENT_LOG_LIMIT])
        .map_err(|error| format!("output-speed query failed: {error}"))?;
    let mut tokens: i64 = 0;
    let mut generation_ms: i64 = 0;
    let mut samples: u32 = 0;
    let mut observed_at_ms: i64 = 0;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        if started.elapsed() > QUERY_BUDGET {
            return Err("output-speed query budget exceeded".into());
        }
        let instance: String = row.get(1).map_err(|error| error.to_string())?;
        let identity_captured: Option<i64> = row.get(6).map_err(|error| error.to_string())?;
        let thread: Option<String> = row.get(7).map_err(|error| error.to_string())?;
        let metadata_captured: Option<i64> = row.get(8).map_err(|error| error.to_string())?;
        let installation: Option<String> = row.get(9).map_err(|error| error.to_string())?;
        if identity_captured != Some(1)
            || metadata_captured != Some(1)
            || Some(&instance) != scope.instance_id.as_ref()
            || scope
                .installation_id
                .as_ref()
                .is_some_and(|expected| installation.as_ref() != Some(expected))
            || thread
                .as_deref()
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .map(|id| id.hyphenated().to_string())
                .as_deref()
                != Some(thread_id)
        {
            continue;
        }
        let success: i64 = row.get(2).map_err(|error| error.to_string())?;
        let error_category: String = row.get(3).map_err(|error| error.to_string())?;
        let output_tokens: i64 = row.get(4).map_err(|error| error.to_string())?;
        let output_ms: Option<i64> = row.get(5).map_err(|error| error.to_string())?;
        // Keep eligibility and weighted arithmetic identical to
        // src/utils/codexOutputSpeed.ts. Never infer generation from latency.
        if success != 1
            || !error_category.is_empty()
            || !(100..=MAX_SAFE_INTEGER).contains(&output_tokens)
            || !output_ms.is_some_and(|ms| (100..=MAX_SAFE_INTEGER).contains(&ms))
        {
            continue;
        }
        tokens += output_tokens;
        generation_ms += output_ms.unwrap_or_default();
        if tokens > MAX_SAFE_INTEGER || generation_ms > MAX_SAFE_INTEGER {
            return Ok(None);
        }
        samples += 1;
        let timestamp: i64 = row.get(0).map_err(|error| error.to_string())?;
        observed_at_ms = observed_at_ms.max(timestamp);
    }
    if started.elapsed() > QUERY_BUDGET {
        return Err("output-speed query budget exceeded".into());
    }
    Ok((samples > 0).then(|| ThreadOutputSpeed {
        thread_id: thread_id.to_string(),
        tokens_per_second: tokens as f64 / (generation_ms as f64 / 1000.0),
        samples,
        observed_at_ms,
    }))
}

#[cfg(test)]
#[path = "codex_app_injection_output_speed_tests.rs"]
mod tests;
