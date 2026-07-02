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

export interface Config {
  dailyBudget: number; // USD
  notifyEnabled: boolean;
  thresholds: Thresholds;
}

export const DEFAULT_CONFIG: Config = {
  dailyBudget: 20,
  notifyEnabled: true,
  thresholds: {
    low: 10_000,
    mid: 50_000,
    high: 150_000,
    veryHigh: 400_000,
  },
};

export type CatState =
  | 'sleeping'
  | 'playing'
  | 'curious'
  | 'active'
  | 'alert'
  | 'angry'
  | 'exhausted';
