use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn release(version: &str, body: &str) -> RemoteRelease {
    RemoteRelease {
        tag_name: format!("v{version}"),
        published_at: Some("2026-10-27T07:00:00Z".into()),
        body: Some(body.into()),
        draft: false,
        prerelease: false,
    }
}

#[test]
fn history_uses_remote_locales_metadata_and_highlights() {
    let body = "## 更新日志（中文）\n## [1.3.75] - 2000-01-01\n### 重要更新\n- 当前重点\n### 新增\n- 当前条目\n## Changelog (English)\n### Added\n- Current entry";
    let zh = release_history(vec![release("1.3.75", body)], "zh-CN", 30);
    assert_eq!(zh.len(), 1);
    assert_eq!(zh[0].version, "1.3.75");
    assert_eq!(zh[0].date, "2026-10-27");
    assert_eq!(zh[0].highlights, vec!["当前重点"]);
    assert_eq!(zh[0].added, vec!["当前条目"]);
    let en = release_history(vec![release("1.3.75", body)], "en-US", 30);
    assert_eq!(en[0].added, vec!["Current entry"]);
    assert!(en[0].highlights.is_empty());
}

#[test]
fn withdrawn_notes_and_removed_releases_are_not_restored() {
    let old = release_history(
        vec![release("1.3.75", "### Added\n- Withdraw me")],
        "en",
        30,
    );
    assert_eq!(old[0].added, vec!["Withdraw me"]);
    let cleared = release_history(vec![release("1.3.75", "")], "en", 30);
    assert!(cleared[0].added.is_empty());
    assert!(cleared[0].highlights.is_empty());
    assert!(release_history(vec![], "en", 30).is_empty());
    assert_eq!(
        split_notes(""),
        ReleaseNotes {
            release_notes: "".into(),
            release_notes_zh: "".into()
        }
    );
}

#[test]
fn history_filters_unpublished_releases_and_honors_limit() {
    let mut draft = release("9.0.0", "");
    draft.draft = true;
    let mut prerelease = release("8.0.0", "");
    prerelease.prerelease = true;
    let result = release_history(
        vec![
            draft,
            prerelease,
            release("1.3.75", ""),
            release("1.3.74", ""),
        ],
        "en",
        1,
    );
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].version, "1.3.75");
}

#[test]
fn bilingual_notes_support_both_orders_crlf_and_single_language() {
    let zh_first = split_notes("## 更新日志（中文）\r\n中文\r\n## Changelog (English)\r\nEnglish");
    let en_first = split_notes("## Changelog (English)\nEnglish\n## 更新日志（中文）\n中文");
    assert_eq!(zh_first, en_first);
    assert_eq!(en_first.release_notes_zh, "中文");
    assert_eq!(en_first.release_notes, "English");
    let single = split_notes("### Added\n- Shared remote body");
    assert_eq!(single.release_notes, single.release_notes_zh);
}

async fn server(
    responses: Vec<(&'static str, &'static str, Duration)>,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/releases", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let task = tokio::spawn(async move {
        for (status, body, delay) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            socket.read(&mut buffer).await.unwrap();
            requests.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(delay).await;
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (url, count, task)
}

#[tokio::test]
async fn concurrent_fetches_share_request_but_next_open_refetches() {
    let delay = Duration::from_millis(25);
    let (url, count, server) = server(vec![
        ("200 OK", "{\"body\":\"old\"}", delay),
        ("200 OK", "{\"body\":\"edited\"}", delay),
    ])
    .await;
    let requests = Requests::default();
    let (first, second) = tokio::join!(
        requests.fetch(&url, REQUEST_TIMEOUT),
        requests.fetch(&url, REQUEST_TIMEOUT)
    );
    assert_eq!(first.unwrap()["body"], "old");
    assert_eq!(second.unwrap()["body"], "old");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        requests.fetch(&url, REQUEST_TIMEOUT).await.unwrap()["body"],
        "edited"
    );
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert!(requests.flights.lock().unwrap().is_empty());
    server.await.unwrap();
}

#[tokio::test]
async fn http_failure_is_retryable_without_an_empty_success_or_stale_fallback() {
    let (url, _, server) = server(vec![
        ("503 Unavailable", "{}", Duration::ZERO),
        ("200 OK", "[]", Duration::ZERO),
    ])
    .await;
    let requests = Requests::default();
    assert!(requests.fetch(&url, REQUEST_TIMEOUT).await.is_err());
    assert!(requests.flights.lock().unwrap().is_empty());
    assert_eq!(
        requests.fetch(&url, REQUEST_TIMEOUT).await.unwrap(),
        serde_json::json!([])
    );
    server.await.unwrap();
}

#[tokio::test]
async fn stalled_request_times_out_and_releases_its_flight() {
    let (url, _, server) = server(vec![("200 OK", "[]", Duration::from_secs(5))]).await;
    let requests = Requests::default();
    let result = requests.fetch(&url, Duration::from_millis(100)).await;
    assert!(result.is_err());
    assert!(requests.flights.lock().unwrap().is_empty());
    server.abort();
}
