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
  /** Rolling per-minute rate samples, oldest first, one per ~30s poll (capped
   * at ~30 min / 60 samples). In-memory on the Rust side, so it resets on app
   * restart. Drives the sustained-high-activity → `exhausted` classification. */
  rate_history?: number[];

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
  rate_history: [],
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

/** Cat render scale bounds, applied as a CSS `scale()` on the sprite. Kept in
 * sync with the details-window slider and clamped on load so a hand-edited
 * store can't blow the cat up past the window. */
export const CAT_SCALE_MIN = 0.5;
export const CAT_SCALE_MAX = 2.0;
export const CAT_SCALE_DEFAULT = 1.0;

/** Selectable emoji accessories worn above the cat. `''` = bare-headed. */
export const CAT_HATS: { value: string; label: string }[] = [
  { value: '', label: '없음' },
  { value: '🎀', label: '리본' },
  { value: '🎩', label: '중절모' },
  { value: '👑', label: '왕관' },
  { value: '🧢', label: '캡' },
  { value: '🌸', label: '꽃' },
];

export interface Config {
  thresholds: Thresholds;
  catColor: CatColor;
  /** Whether the app registers to start at login (macOS LaunchAgent / Windows
   * registry Run key). Opt-in:
   * defaults to `false` so a fresh install never auto-registers. The autostart
   * plugin is the source of truth (`isEnabled()`); this mirrors it for the UI. */
  autostart: boolean;
  /** Visual size multiplier for the cat sprite (0.5–2.0, default 1.0). Purely
   * cosmetic — the overlay geometry Rust reasons about stays fixed. */
  catScale: number;
  /** Optional accessory worn above the cat, as an emoji ('' = none). Purely
   * cosmetic; rides with the cat's flip + scale. See {@link CAT_HATS}. */
  catHat: string;
  /** Master switch for the playful reactions/celebrations (usage zoomies,
   * tower-tier confetti, party, petting hearts, golden shimmer, late-night &
   * break nudges). On by default; flip off for a calm, minimal cat. */
  funEffects: boolean;
  /** Social mode (LAN presence). Opt-in and off by default: while on, the app
   * advertises a *coarse* status (nickname, coat color, mood, activity bucket —
   * never token counts or project names) to other clawd instances on the same
   * local network, and shows their cats on screen. */
  networkEnabled: boolean;
  /** Display name shown under your cat on peers' screens. Empty → the hook
   * falls back to a generated "cat-1234" style name. */
  nickname: string;
  /** Optional custom iroh relay URL for remote rooms (e.g. a self-hosted
   * `iroh-relay` on `https://relay.example.com`). Empty → n0's public relays.
   * Set the *same* URL on both peers to bypass a network that blocks the
   * public relays. See `docs/self-hosted-relay.md`. */
  remoteRelayUrl: string;
}

export const DEFAULT_CONFIG: Config = {
  thresholds: {
    low: 10_000,
    mid: 50_000,
    high: 150_000,
    veryHigh: 400_000,
  },
  catColor: 'cream',
  autostart: false,
  catScale: CAT_SCALE_DEFAULT,
  catHat: '',
  funEffects: true,
  networkEnabled: false,
  nickname: '',
  remoteRelayUrl: '',
};

export type CatState =
  | 'sleeping'
  | 'playing'
  | 'curious'
  | 'active'
  | 'alert'
  | 'angry'
  | 'exhausted';

/** Coarse "how busy" bucket shared over the network in place of raw numbers. */
export type ActivityBucket = 'idle' | 'light' | 'busy' | 'intense';

/** A peer clawd on the LAN. Mirrors `PresencePayload` in
 * src-tauri/src/presence.rs — the entire wire format for social mode. */
export interface Peer {
  id: string;
  nickname: string;
  color: CatColor;
  state: CatState;
  activity: ActivityBucket;
}

/** Map a cat mood onto the coarse activity bucket peers see. Keeps exact
 * tokens/min private while still conveying a vibe. */
export const ACTIVITY_FOR_STATE: Record<CatState, ActivityBucket> = {
  sleeping: 'idle',
  playing: 'light',
  curious: 'light',
  active: 'busy',
  alert: 'busy',
  angry: 'intense',
  exhausted: 'intense',
};

/** Badge glyph + label per activity bucket, for the peer name tag. */
export const ACTIVITY_BADGE: Record<ActivityBucket, { icon: string; label: string }> = {
  idle: { icon: '💤', label: '쉬는 중' },
  light: { icon: '🐾', label: '여유' },
  busy: { icon: '🔥', label: '바쁨' },
  intense: { icon: '⚡', label: '폭주' },
};
