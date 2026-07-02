//! ccusage-style aggregation of Claude Code token usage.
//!
//! Claude Code appends one JSON object per line to
//! `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Assistant turns
//! carry a `usage` block (`input_tokens`, `output_tokens`,
//! `cache_creation_input_tokens`, `cache_read_input_tokens`). We scan every
//! line, dedupe by `message.id` + `requestId` (the same logical message can be
//! written to more than one file), price each turn from a hardcoded table, then
//! roll the turns up into the time buckets the cat's state machine consumes.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use chrono::{DateTime, Datelike, Duration, Local, Timelike, Utc};
use serde::Serialize;
use serde_json::Value;
use walkdir::WalkDir;

/// How far back we keep parsed turns in the cache. The widest time bucket is the
/// calendar month (≤31 days) plus a margin, so 40 days safely covers every
/// bucket while bounding memory to recent activity. Older turns can never
/// contribute to any bucket, so we drop them at parse time.
const RETAIN_DAYS: i64 = 40;

/// Daily-token thresholds for the cat-tower evolution tier (see the frontend
/// `Furniture` `tier` prop). `today_tokens` below `TIER2` shows the simple
/// scratcher (tier 1), below `TIER3` the platform tower (tier 2), else the
/// hammock tower (tier 3). Token counts include cheap-but-voluminous cache
/// reads, so these run large — consistent with the other activity thresholds.
const TOWER_TIER2_MIN_TOKENS: u64 = 20_000_000;
const TOWER_TIER3_MIN_TOKENS: u64 = 100_000_000;

/// USD per **million** tokens, matched by substring against the model id.
/// Rough but current figures — see README for the tuning note. Order matters:
/// more specific ids first, generic family name last.
struct Price {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

fn price_for(model: &str) -> Price {
    let m = model.to_lowercase();
    // Opus family
    if m.contains("opus") {
        return Price { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.5 };
    }
    // Haiku family
    if m.contains("haiku") {
        return Price { input: 0.8, output: 4.0, cache_write: 1.0, cache_read: 0.08 };
    }
    // Sonnet family (and the safe default for anything unknown)
    Price { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 }
}

/// A single priced assistant turn. Cached between polls, so it carries its own
/// dedup key (`message.id`[:`requestId`]) — dedup runs at aggregation time
/// across the whole cache rather than during a single linear scan.
#[derive(Clone)]
struct Turn {
    ts: Option<DateTime<Utc>>,
    model: String,
    total_tokens: u64,
    cost: f64,
    dedup_key: Option<String>,
}

/// Per-model rollup surfaced in the details window.
#[derive(Serialize, Clone, Default)]
pub struct ModelUsage {
    pub model: String,
    pub tokens: u64,
    pub cost: f64,
}

/// The full snapshot handed to the frontend.
#[derive(Serialize, Clone, Default)]
pub struct Usage {
    pub today_tokens: u64,
    pub today_cost: f64,
    pub today_messages: u64,

    /// Tokens seen in the trailing 5 minutes and the derived per-minute rate.
    pub tokens_last_5min: u64,
    pub rate_per_min: u64,

    /// True when a turn landed within the last 30 seconds.
    pub session_active: bool,
    /// Minutes since the most recent turn (f64 so the UI can show <1m).
    pub idle_minutes: f64,

    pub week_tokens: u64,
    pub week_cost: f64,
    pub month_tokens: u64,
    pub month_cost: f64,

    /// Total tokens for the *previous* calendar day (yesterday 00:00 → today
    /// 00:00, local time). Drives the "vs. yesterday" delta in the details UI.
    pub yesterday_tokens: u64,

    /// Tokens bucketed by local hour of *today* (index 0 = 00:00–00:59 … 23 =
    /// 23:00–23:59). Powers the hourly sparkline.
    pub today_hourly: Vec<u64>,

    /// Tokens bucketed by weekday × local hour over the trailing 7 days (today
    /// and the previous 6). Outer index is the weekday, Monday = 0 … Sunday = 6;
    /// inner index is the local hour 0..23. Seven consecutive days cover each
    /// weekday exactly once, so every row maps to a single calendar date.
    /// Powers the weekly activity heatmap. Serialized as a `Vec<Vec<u64>>` so a
    /// non-finite/fixed-array shape never trips serde.
    pub weekly_hourly: Vec<Vec<u64>>,

    /// Cat-tower evolution tier derived from `today_tokens`: 1 (simple), 2
    /// (platform, the baseline), or 3 (hammock). See `TOWER_TIER*_MIN_TOKENS`.
    pub tower_tier: u8,

    /// Epoch millis of the last activity, or null if no data was found.
    pub last_activity_ms: Option<i64>,

    /// Today's usage split by model, biggest cost first.
    pub models_today: Vec<ModelUsage>,

    /// Set when the `~/.claude/projects` directory could not be read at all.
    pub error: Option<String>,
}

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn parse_turn(line: &str) -> Option<Turn> {
    let v: Value = serde_json::from_str(line).ok()?;
    let msg = v.get("message");

    // Accept both the top-level `type: "assistant"` shape and a nested
    // `message.role: "assistant"` shape — Claude Code has used both.
    let role = msg.and_then(|m| m.get("role")).and_then(Value::as_str);
    let ttype = v.get("type").and_then(Value::as_str);
    if role != Some("assistant") && ttype != Some("assistant") {
        return None;
    }

    let usage = msg.and_then(|m| m.get("usage")).or_else(|| v.get("usage"))?;
    let get = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let input = get("input_tokens");
    let output = get("output_tokens");
    let cache_w = get("cache_creation_input_tokens");
    let cache_r = get("cache_read_input_tokens");
    if input == 0 && output == 0 && cache_w == 0 && cache_r == 0 {
        return None;
    }

    // Dedup key for identical logical messages that land in more than one file.
    // Resolved at aggregation time, not here, since cached turns outlive a scan.
    let msg_id = msg.and_then(|m| m.get("id")).and_then(Value::as_str);
    let req_id = v
        .get("requestId")
        .or_else(|| v.get("request_id"))
        .and_then(Value::as_str);
    let dedup_key = match (msg_id, req_id) {
        (Some(m), Some(r)) => Some(format!("{m}:{r}")),
        (Some(m), None) => Some(m.to_string()),
        _ => None,
    };

    let model = msg
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    let ts = v
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc));

    let p = price_for(&model);
    let cost = (input as f64 * p.input
        + output as f64 * p.output
        + cache_w as f64 * p.cache_write
        + cache_r as f64 * p.cache_read)
        / 1_000_000.0;

    Some(Turn {
        ts,
        model,
        total_tokens: input + output + cache_w + cache_r,
        cost,
        dedup_key,
    })
}

// ---------------------------------------------------------------------------
// Incremental tailing cache
// ---------------------------------------------------------------------------

/// What we remember about a session file between polls so a 30s tick is mostly
/// no-op: unchanged files are skipped, grown files are read from `offset`, and
/// truncated/rewritten files are re-parsed from scratch.
struct FileEntry {
    /// Last-seen mtime + size, used to detect "nothing changed".
    mtime: Option<SystemTime>,
    size: u64,
    /// Byte offset of the first not-yet-parsed byte (always at a line boundary;
    /// a partial trailing line without a newline is intentionally left unread).
    offset: u64,
    /// Priced turns parsed from this file, within the retention window.
    turns: Vec<Turn>,
}

/// Per-file parse state, shared by the poller thread and the `get_usage`
/// command. The `Mutex` serializes the two callers; only one scan runs at a time.
fn cache() -> &'static Mutex<HashMap<PathBuf, FileEntry>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, FileEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What to do with a file this tick, decided from cached mtime/size vs. current.
enum Action {
    /// mtime + size unchanged — reuse cached turns as-is.
    Skip,
    /// File grew — seek to `offset` and parse only the appended lines.
    Tail(u64),
    /// New file, shrunk (truncated), or same-size-different-mtime (rewritten) —
    /// re-parse from the top and replace the cached turns.
    Full,
}

/// Read a file from `offset` to EOF, returning the turns parsed from complete
/// (newline-terminated) lines and the new offset. A trailing line still being
/// appended (no newline yet) is left unconsumed so we re-read it once complete.
fn read_turns(path: &PathBuf, offset: u64, retain_cutoff: DateTime<Utc>) -> (Vec<Turn>, u64) {
    let mut turns = Vec::new();
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (turns, offset),
    };
    let mut reader = BufReader::new(file);
    if offset > 0 && reader.seek(SeekFrom::Start(offset)).is_err() {
        return (turns, offset);
    }

    let mut pos = offset;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(_) => break,
        };
        // Partial trailing line (no newline yet): stop without consuming it.
        if buf.last() != Some(&b'\n') {
            break;
        }
        pos += n as u64;
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(turn) = parse_turn(line) {
            // Drop turns too old to affect any bucket; keeps memory bounded to
            // recent activity. Undated turns are kept (see `collect`).
            if turn.ts.map(|t| t >= retain_cutoff).unwrap_or(true) {
                turns.push(turn);
            }
        }
    }
    (turns, pos)
}

/// Scan every session file and aggregate into a [`Usage`] snapshot.
pub fn collect() -> Usage {
    let mut out = Usage::default();
    // Fixed 24-slot histogram (one bucket per local hour of today).
    out.today_hourly = vec![0; 24];
    // 7 weekday rows (Mon=0 … Sun=6) × 24 hourly columns for the heatmap.
    out.weekly_hourly = vec![vec![0u64; 24]; 7];

    let dir = match claude_projects_dir() {
        Some(d) if d.is_dir() => d,
        Some(d) => {
            out.error = Some(format!("not found: {}", d.display()));
            return out;
        }
        None => {
            out.error = Some("could not resolve home directory".into());
            return out;
        }
    };

    let now = Local::now();
    let today_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(Local)
        .unwrap()
        .with_timezone(&Utc);
    let month_start = now
        .date_naive()
        .with_day(1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(Local)
        .unwrap()
        .with_timezone(&Utc);
    let yesterday_start = today_start - Duration::days(1);
    // Trailing-7-day window (today + previous 6 local days) for the heatmap.
    let week7_start = today_start - Duration::days(6);
    let now_utc = now.with_timezone(&Utc);
    let week_start = now_utc - Duration::days(7);
    let five_min = now_utc - Duration::minutes(5);
    let thirty_sec = now_utc - Duration::seconds(30);

    let retain_cutoff = now_utc - Duration::days(RETAIN_DAYS);

    // --- Incremental scan: refresh the per-file cache, touching only files
    // whose mtime/size changed since the last tick. ---
    let mut store = cache().lock().unwrap();
    let mut present: HashSet<PathBuf> = HashSet::new();

    for entry in WalkDir::new(&dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
    {
        let path = entry.path().to_path_buf();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        let mtime = meta.modified().ok();
        present.insert(path.clone());

        let action = match store.get(&path) {
            Some(e) if e.size == size && e.mtime == mtime => Action::Skip,
            Some(e) if size > e.size => Action::Tail(e.offset),
            _ => Action::Full, // new, truncated, or same-size-but-rewritten
        };

        match action {
            Action::Skip => {}
            Action::Tail(offset) => {
                let (mut new_turns, new_offset) = read_turns(&path, offset, retain_cutoff);
                if let Some(e) = store.get_mut(&path) {
                    e.turns.append(&mut new_turns);
                    e.offset = new_offset;
                    e.size = size;
                    e.mtime = mtime;
                }
            }
            Action::Full => {
                let (turns, new_offset) = read_turns(&path, 0, retain_cutoff);
                store.insert(
                    path,
                    FileEntry { mtime, size, offset: new_offset, turns },
                );
            }
        }
    }

    // Forget files that disappeared (session cleanup, project deletion).
    store.retain(|p, _| present.contains(p));

    // --- Aggregate the cached turns into the time buckets. Dedup identical
    // logical messages across files here, once, over the whole cache. ---
    let mut seen: HashSet<String> = HashSet::new();
    let mut last_activity: Option<DateTime<Utc>> = None;
    let mut models: HashMap<String, ModelUsage> = HashMap::new();

    for entry in store.values() {
        for turn in &entry.turns {
            if let Some(key) = &turn.dedup_key {
                if !seen.insert(key.clone()) {
                    continue;
                }
            }

            let ts = match turn.ts {
                Some(t) => t,
                // Undated turns still count toward all-time-ish month/week
                // totals conservatively; skip them for the time buckets.
                None => {
                    out.month_tokens += turn.total_tokens;
                    out.month_cost += turn.cost;
                    continue;
                }
            };

            if last_activity.map(|l| ts > l).unwrap_or(true) {
                last_activity = Some(ts);
            }

            if ts >= month_start {
                out.month_tokens += turn.total_tokens;
                out.month_cost += turn.cost;
            }
            if ts >= week_start {
                out.week_tokens += turn.total_tokens;
                out.week_cost += turn.cost;
            }
            if ts >= today_start {
                out.today_tokens += turn.total_tokens;
                out.today_cost += turn.cost;
                out.today_messages += 1;
                // Bucket into the local-hour histogram for the sparkline.
                let hour = ts.with_timezone(&Local).hour() as usize;
                if let Some(slot) = out.today_hourly.get_mut(hour) {
                    *slot += turn.total_tokens;
                }
                let m = models.entry(turn.model.clone()).or_insert_with(|| ModelUsage {
                    model: turn.model.clone(),
                    ..Default::default()
                });
                m.tokens += turn.total_tokens;
                m.cost += turn.cost;
            } else if ts >= yesterday_start {
                // Strictly the previous calendar day (today branch took ≥today).
                out.yesterday_tokens += turn.total_tokens;
            }
            // Weekly heatmap: bucket by weekday (Mon=0) × local hour. Independent
            // of the today/yesterday split above — the window spans 7 days.
            if ts >= week7_start {
                let local = ts.with_timezone(&Local);
                let wd = local.weekday().num_days_from_monday() as usize; // Mon=0..Sun=6
                let hr = local.hour() as usize;
                if let Some(slot) = out.weekly_hourly.get_mut(wd).and_then(|r| r.get_mut(hr)) {
                    *slot += turn.total_tokens;
                }
            }
            if ts >= five_min {
                out.tokens_last_5min += turn.total_tokens;
            }
            if ts >= thirty_sec {
                out.session_active = true;
            }
        }
    }
    drop(store);

    out.tower_tier = if out.today_tokens < TOWER_TIER2_MIN_TOKENS {
        1
    } else if out.today_tokens < TOWER_TIER3_MIN_TOKENS {
        2
    } else {
        3
    };

    out.rate_per_min = out.tokens_last_5min / 5;
    // Large finite sentinel rather than INFINITY — serde_json rejects
    // non-finite floats. "No data ever" reads as very idle.
    out.idle_minutes = last_activity
        .map(|l| (now_utc - l).num_seconds() as f64 / 60.0)
        .unwrap_or(525_600.0);
    out.last_activity_ms = last_activity.map(|l| l.timestamp_millis());

    let mut models: Vec<ModelUsage> = models.into_values().collect();
    models.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
    out.models_today = models;

    out
}
