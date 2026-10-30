use super::{parse_release_history_markdown, ReleaseHistoryItem};
use crate::modules::{config, logger};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::OnceCell;

const RELEASES_URL: &str = "https://api.github.com/repos/jlcodes99/cockpit-tools/releases";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ZH_HEADER: &str = "## 更新日志（中文）";
const EN_HEADER: &str = "## Changelog (English)";

type Flight = Arc<OnceCell<Result<Value, String>>>;

/// Share only requests that are currently running. Completed responses (including
/// failures and empty bodies) never become a memory/disk cache or bundled fallback.
#[derive(Default)]
struct Requests {
    flights: Mutex<HashMap<String, Flight>>,
}

impl Requests {
    async fn fetch(&self, url: &str, timeout: Duration) -> Result<Value, String> {
        let flight = self
            .flights
            .lock()
            .map_err(|e| e.to_string())?
            .entry(url.to_string())
            .or_default()
            .clone();
        let result = flight
            .get_or_init(|| async {
                let result = tokio::time::timeout(timeout, async {
                    // Native TLS/proxy discovery can do synchronous system I/O.
                    let client = tokio::task::spawn_blocking(move || {
                        reqwest::Client::builder()
                            .user_agent("Cockpit-Tools")
                            .connect_timeout(Duration::from_secs(3))
                            .timeout(timeout)
                            .build()
                    })
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?;
                    client
                        .get(url)
                        .header("Accept", "application/vnd.github+json")
                        .header("Cache-Control", "no-cache")
                        .send()
                        .await
                        .map_err(|e| e.to_string())?
                        .error_for_status()
                        .map_err(|e| e.to_string())?
                        .json::<Value>()
                        .await
                        .map_err(|e| e.to_string())
                })
                .await
                .unwrap_or_else(|_| Err("Release notes request timed out".to_string()));
                if let Err(error) = &result {
                    logger::log_warn(&format!(
                        "[UpdateChecker] Remote release notes failed: {error}"
                    ));
                }
                result
            })
            .await
            .clone();
        let mut flights = self.flights.lock().map_err(|e| e.to_string())?;
        if flights
            .get(url)
            .is_some_and(|current| Arc::ptr_eq(current, &flight))
        {
            flights.remove(url);
        }
        result
    }
}

async fn fetch_release_json(url: &str) -> Result<Value, String> {
    let enabled =
        tokio::task::spawn_blocking(|| config::get_user_config().external_network_enabled)
            .await
            .map_err(|e| e.to_string())?;
    if !enabled {
        return Err("External network access is disabled".to_string());
    }
    static REQUESTS: OnceLock<Requests> = OnceLock::new();
    REQUESTS
        .get_or_init(Requests::default)
        .fetch(url, REQUEST_TIMEOUT)
        .await
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReleaseNotes {
    pub release_notes: String,
    pub release_notes_zh: String,
}

fn split_notes(body: &str) -> ReleaseNotes {
    let body = body.replace("\r\n", "\n");
    let (english, chinese) = match (body.find(EN_HEADER), body.find(ZH_HEADER)) {
        (Some(en), Some(zh)) if zh < en => (
            &body[en + EN_HEADER.len()..],
            &body[zh + ZH_HEADER.len()..en],
        ),
        (Some(en), Some(zh)) => (
            &body[en + EN_HEADER.len()..zh],
            &body[zh + ZH_HEADER.len()..],
        ),
        _ => (body.as_str(), body.as_str()),
    };
    ReleaseNotes {
        release_notes: english.trim().to_string(),
        release_notes_zh: chinese.trim().to_string(),
    }
}

#[derive(Deserialize)]
struct RemoteRelease {
    tag_name: String,
    published_at: Option<String>,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
}

fn release_history(
    releases: Vec<RemoteRelease>,
    locale: &str,
    limit: usize,
) -> Vec<ReleaseHistoryItem> {
    releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .take(limit)
        .map(|release| {
            let version = release.tag_name.trim_start_matches('v');
            let date = release
                .published_at
                .as_deref()
                .unwrap_or("")
                .split('T')
                .next()
                .unwrap_or("");
            let notes = split_notes(release.body.as_deref().unwrap_or(""));
            let body = if locale.to_lowercase().starts_with("zh") {
                notes.release_notes_zh
            } else {
                notes.release_notes
            };
            // Release metadata is authoritative even when its body has no
            // changelog-style version header, or has been intentionally cleared.
            let mut item =
                parse_release_history_markdown(&format!("## [{version}] - {date}\n{body}"), 100)
                    .into_iter()
                    .rev()
                    .find(|item| item.version == version)
                    .unwrap_or_else(|| ReleaseHistoryItem {
                        version: version.to_string(),
                        date: date.to_string(),
                        highlights: Vec::new(),
                        added: Vec::new(),
                        changed: Vec::new(),
                        fixed: Vec::new(),
                        removed: Vec::new(),
                    });
            item.version = version.to_string();
            item.date = date.to_string();
            item
        })
        .collect()
}

pub async fn get_release_history(
    locale: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<ReleaseHistoryItem>, String> {
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let response = fetch_release_json(&format!("{RELEASES_URL}?per_page={limit}")).await?;
    let releases = serde_json::from_value(response).map_err(|e| e.to_string())?;
    Ok(release_history(releases, locale.unwrap_or("en"), limit))
}

pub async fn get_release_notes(version: &str) -> Result<ReleaseNotes, String> {
    let version = version.trim().trim_start_matches('v');
    if version.split('.').count() != 3
        || !version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Invalid release version".to_string());
    }
    let response = fetch_release_json(&format!("{RELEASES_URL}/tags/v{version}")).await?;
    let release: RemoteRelease = serde_json::from_value(response).map_err(|e| e.to_string())?;
    if release.draft || release.prerelease || release.tag_name != format!("v{version}") {
        return Err("Published release not found".to_string());
    }
    Ok(split_notes(release.body.as_deref().unwrap_or("")))
}

#[cfg(test)]
#[path = "update_checker_remote_tests.rs"]
mod tests;
