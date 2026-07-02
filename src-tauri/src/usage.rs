//! ccusage-style aggregation of Claude Code token usage.
//!
//! Claude Code appends one JSON object per line to
//! `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Assistant turns
//! carry a `usage` block (`input_tokens`, `output_tokens`,
//! `cache_creation_input_tokens`, `cache_read_input_tokens`). We scan every
//! line, dedupe by `message.id` + `requestId` (the same logical message can be
//! written to more than one file), price each turn from a hardcoded table, then
//! roll the turns up into the time buckets the cat's state machine consumes.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use chrono::{DateTime, Datelike, Duration, Local, Utc};
use serde::Serialize;
use serde_json::Value;
use walkdir::WalkDir;

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

/// A single priced assistant turn.
struct Turn {
    ts: Option<DateTime<Utc>>,
    model: String,
    total_tokens: u64,
    cost: f64,
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

fn parse_turn(line: &str, seen: &mut HashSet<String>) -> Option<Turn> {
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

    // Dedupe identical logical messages across files.
    let msg_id = msg.and_then(|m| m.get("id")).and_then(Value::as_str);
    let req_id = v
        .get("requestId")
        .or_else(|| v.get("request_id"))
        .and_then(Value::as_str);
    if let Some(key) = match (msg_id, req_id) {
        (Some(m), Some(r)) => Some(format!("{m}:{r}")),
        (Some(m), None) => Some(m.to_string()),
        _ => None,
    } {
        if !seen.insert(key) {
            return None;
        }
    }

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
    })
}

/// Scan every session file and aggregate into a [`Usage`] snapshot.
pub fn collect() -> Usage {
    let mut out = Usage::default();

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
    let now_utc = now.with_timezone(&Utc);
    let week_start = now_utc - Duration::days(7);
    let five_min = now_utc - Duration::minutes(5);
    let thirty_sec = now_utc - Duration::seconds(30);

    let mut seen: HashSet<String> = HashSet::new();
    let mut last_activity: Option<DateTime<Utc>> = None;
    let mut models: std::collections::HashMap<String, ModelUsage> = std::collections::HashMap::new();

    for entry in WalkDir::new(&dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
    {
        let file = match File::open(entry.path()) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let Some(turn) = parse_turn(&line, &mut seen) else {
                continue;
            };

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
                let m = models.entry(turn.model.clone()).or_insert_with(|| ModelUsage {
                    model: turn.model.clone(),
                    ..Default::default()
                });
                m.tokens += turn.total_tokens;
                m.cost += turn.cost;
            }
            if ts >= five_min {
                out.tokens_last_5min += turn.total_tokens;
            }
            if ts >= thirty_sec {
                out.session_active = true;
            }
        }
    }

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
