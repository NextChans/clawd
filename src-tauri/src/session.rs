//! Optional **session-usage** integration (experimental, opt-in).
//!
//! Claude subscription usage — the rolling 5-hour session window and the weekly
//! limit — has no official/public API. Claude Code itself learns its remaining
//! budget from **rate-limit response headers** on the Messages API, and we
//! replicate that: with a Claude Code OAuth token (`sk-ant-oat01…`, from
//! `claude setup-token`) we make one tiny Messages request and read the
//! `anthropic-ratelimit-unified-5h/7d-utilization` headers off the response.
//!
//! Everything here is best-effort and clearly labelled experimental:
//!   - the token lives in the **macOS Keychain**, never in the config store;
//!   - the header names + the OAuth request shape are undocumented, so if they
//!     don't match we surface the raw status + headers in `debug` (rather than
//!     guessing) and the app just keeps using local-log usage;
//!   - each check sends a minimal request, so callers should poll sparingly.

use std::time::Duration;

use serde::Serialize;

const KEYCHAIN_SERVICE: &str = "com.chani.clawd";
const KEYCHAIN_ACCOUNT: &str = "anthropic-oauth-token";
const API_URL: &str = "https://api.anthropic.com/v1/messages";

/// What the frontend gets back from a check. `configured` = a token is stored;
/// `ok` = we actually parsed at least one utilization value. `debug` always
/// carries the HTTP status and any `anthropic-ratelimit-*` headers we saw (and,
/// on failure, a snippet of the body) so a mismatch can be diagnosed from the UI.
#[derive(Serialize, Clone, Default)]
pub struct SessionUsage {
    pub configured: bool,
    pub ok: bool,
    /// Raw utilization values as returned (units per Anthropic; shown as-is).
    pub session_pct: Option<f64>,
    pub weekly_pct: Option<f64>,
    pub session_reset: Option<String>,
    pub weekly_reset: Option<String>,
    pub status: Option<u16>,
    pub debug: String,
}

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

fn stored_token() -> Option<String> {
    entry().ok().and_then(|e| e.get_password().ok())
}

/// Store the OAuth token in the OS keychain.
#[tauri::command]
pub fn session_set_token(token: String) -> Result<(), String> {
    let t = token.trim();
    if t.is_empty() {
        return Err("빈 토큰".into());
    }
    entry()
        .map_err(|e| e.to_string())?
        .set_password(t)
        .map_err(|e| e.to_string())
}

/// Remove the stored token (turns the integration off).
#[tauri::command]
pub fn session_clear_token() -> Result<(), String> {
    let e = entry().map_err(|e| e.to_string())?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Whether a token is currently stored (drives the UI without exposing it).
#[tauri::command]
pub fn session_has_token() -> bool {
    stored_token().is_some()
}

/// Check session/weekly utilization now. Reads the stored token, makes one
/// minimal Messages request, and parses the rate-limit headers off the response.
#[tauri::command]
pub async fn session_usage() -> SessionUsage {
    let Some(token) = stored_token() else {
        return SessionUsage {
            configured: false,
            debug: "토큰 미설정".into(),
            ..Default::default()
        };
    };
    fetch(&token).await
}

fn fail(status: Option<u16>, debug: String) -> SessionUsage {
    SessionUsage {
        configured: true,
        ok: false,
        status,
        debug,
        ..Default::default()
    }
}

async fn fetch(token: &str) -> SessionUsage {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => return fail(None, format!("client: {e}")),
    };

    // Mimic a Claude Code request: OAuth tokens are scoped to Claude Code, so the
    // request must carry its beta header, user-agent, and system prompt or the
    // API rejects it. `max_tokens: 1` keeps the quota cost negligible.
    let body = serde_json::json!({
        "model": "claude-3-5-haiku-20241022",
        "max_tokens": 1,
        "system": "You are Claude Code, Anthropic's official CLI for Claude.",
        "messages": [{ "role": "user", "content": "quota" }],
    });

    let resp = client
        .post(API_URL)
        .header("authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("user-agent", "claude-code/1.0")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return fail(None, format!("요청 실패: {e}")),
    };

    let status = resp.status().as_u16();
    let (mut session_pct, mut weekly_pct) = (None, None);
    let (mut session_reset, mut weekly_reset) = (None, None);
    let mut seen: Vec<String> = Vec::new();
    for (k, v) in resp.headers().iter() {
        let name = k.as_str().to_ascii_lowercase();
        if !name.starts_with("anthropic-ratelimit") {
            continue;
        }
        let val = v.to_str().unwrap_or("").to_string();
        seen.push(format!("{name}={val}"));
        match name.as_str() {
            "anthropic-ratelimit-unified-5h-utilization" => session_pct = val.parse().ok(),
            "anthropic-ratelimit-unified-7d-utilization" => weekly_pct = val.parse().ok(),
            "anthropic-ratelimit-unified-5h-reset" => session_reset = Some(val),
            "anthropic-ratelimit-unified-7d-reset" => weekly_reset = Some(val),
            _ => {}
        }
    }

    let ok = session_pct.is_some() || weekly_pct.is_some();
    let mut debug = format!("status {status}");
    if !seen.is_empty() {
        debug = format!("{debug} · {}", seen.join(" "));
    }
    if !ok {
        // No utilization headers — capture a little body so we can see why (auth
        // error, wrong request shape, changed header names, …).
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        if !snippet.is_empty() {
            debug = format!("{debug} · body: {snippet}");
        }
    }

    SessionUsage {
        configured: true,
        ok,
        session_pct,
        weekly_pct,
        session_reset,
        weekly_reset,
        status: Some(status),
        debug,
    }
}
