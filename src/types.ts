// Mirrors the `Usage` struct serialized by src-tauri/src/usage.rs.
export interface ModelUsage {
  model: string;
  tokens: number;
  cost: number;
}

export interface Usage {
  today_tokens: number;
  today_cost: number;
  today_messages: number;

  tokens_last_5min: number;
  rate_per_min: number;

  session_active: boolean;
  idle_minutes: number;

  week_tokens: number;
  week_cost: number;
  month_tokens: number;
  month_cost: number;

  /** Total tokens for the previous calendar day (local time). */
  yesterday_tokens: number;
  /** Tokens per local hour of today: index 0 = 00:00 … 23 = 23:00. */
  today_hourly: number[];
  /** Tokens by weekday × local hour over the trailing 7 days. Outer index is
   * the weekday (Monday = 0 … Sunday = 6), inner is the hour 0..23. Powers the
   * weekly heatmap. */
  weekly_hourly: number[][];
  /** Cat-tower evolution tier from today's tokens: 1 (simple) / 2 (platform) /
   * 3 (hammock). */
  tower_tier: 1 | 2 | 3;

  last_activity_ms: number | null;
  models_today: ModelUsage[];
  error: string | null;
}

export const EMPTY_USAGE: Usage = {
  today_tokens: 0,
  today_cost: 0,
  today_messages: 0,
  tokens_last_5min: 0,
  rate_per_min: 0,
  session_active: false,
  idle_minutes: 525600,
  week_tokens: 0,
  week_cost: 0,
  month_tokens: 0,
  month_cost: 0,
  yesterday_tokens: 0,
  today_hourly: Array(24).fill(0),
  weekly_hourly: Array.from({ length: 7 }, () => Array(24).fill(0)),
  tower_tier: 2,
  last_activity_ms: null,
  models_today: [],
  error: null,
};

// Rate thresholds are in tokens/min. Note: token counts include cache-read
// tokens, which are cheap but voluminous, so "busy" numbers run large.
export interface Thresholds {
  low: number;
  mid: number;
  high: number;
  veryHigh: number;
}

/** Selectable coat colors. `orange_tabby` / `gray_tabby` show stripes. These
 * ids are also the on-disk asset folder names (`src/assets/cat/<id>/`). */
export type CatColor = 'cream' | 'black' | 'orange_tabby' | 'gray_tabby' | 'white';

export const CAT_COLORS: { id: CatColor; label: string; swatch: string }[] = [
  { id: 'cream', label: '크림', swatch: '#f7e6c4' },
  { id: 'black', label: '검정', swatch: '#35312f' },
  { id: 'orange_tabby', label: '치즈', swatch: '#f3b877' },
  { id: 'gray_tabby', label: '고등어', swatch: '#b8bdc1' },
  { id: 'white', label: '흰둥이', swatch: '#fbf7f1' },
];

export interface Config {
  /** Daily cumulative-token ceiling above which a busy cat reads as `exhausted`
   * (tokens). This is an *activity* signal, not a bill — the user is on a
   * Claude Team flat-rate plan, so there is no per-token cost to cap. */
  exhaustedTokenThreshold: number;
  thresholds: Thresholds;
  catColor: CatColor;
  /** Whether the app registers a macOS LaunchAgent to start at login. Opt-in:
   * defaults to `false` so a fresh install never auto-registers. The autostart
   * plugin is the source of truth (`isEnabled()`); this mirrors it for the UI. */
  autostart: boolean;
}

export const DEFAULT_CONFIG: Config = {
  exhaustedTokenThreshold: 50_000_000,
  thresholds: {
    low: 10_000,
    mid: 50_000,
    high: 150_000,
    veryHigh: 400_000,
  },
  catColor: 'cream',
  autostart: false,
};

export type CatState =
  | 'sleeping'
  | 'playing'
  | 'curious'
  | 'active'
  | 'alert'
  | 'angry'
  | 'exhausted';
