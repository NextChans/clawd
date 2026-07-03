import { CatState, Config, Usage } from '../types';
import { formatRate } from '../utils/format';

/** A cat mood plus a human-readable line explaining *why* it was chosen. */
export interface StateReason {
  state: CatState;
  /** Korean explanation naming the branch + the numbers that fired it. */
  reason: string;
}

/** Samples that must fill the rolling window before `exhausted` can trigger —
 * 60 samples at the 30s poll cadence ≈ 30 minutes. Below this the window is
 * still warming up (e.g. right after an app restart) and never reads exhausted. */
const SUSTAINED_SAMPLES = 60;
/** Fraction of the window that must sit at/above the alert threshold. A little
 * slack (54/60) rides out a brief dip without dropping out of `exhausted`. */
const SUSTAINED_RATIO = 0.9;

/**
 * True when the trailing ~30 minutes of rate history has stayed at/above the
 * alert (`high`) threshold for at least {@link SUSTAINED_RATIO} of its samples.
 * This is the "long, sustained hard work" signal that tires the cat out — as
 * opposed to a single busy spike. Returns false until the window is full so a
 * fresh launch can't false-positive during warm-up.
 */
function isSustainedHighRate(usage: Usage, high: number): boolean {
  const history = usage.rate_history ?? [];
  if (history.length < SUSTAINED_SAMPLES) return false;
  const window = history.slice(-SUSTAINED_SAMPLES);
  const highCount = window.filter((r) => r >= high).length;
  return highCount >= Math.ceil(SUSTAINED_SAMPLES * SUSTAINED_RATIO);
}

/** Intensity order, calm → intense, so we can pick the "more intense" of the
 * activity-based and session-based moods. */
const SEVERITY: Record<CatState, number> = {
  sleeping: 0,
  playing: 1,
  curious: 2,
  active: 3,
  alert: 4,
  angry: 5,
  exhausted: 6,
};

/** At/above this session-window utilization the cat reads as worn out —
 * you're near the 5-hour cap, so it winds down whatever you're doing. */
const SESSION_TIRED_PCT = 90;

/**
 * Activity-based mood from the local `~/.claude` logs. `rate` (tokens/min over
 * the trailing 5 minutes) picks the mood, `exhausted` layers on for a sustained
 * ~30-minute high stretch, and long idleness sleeps. On a Claude Team flat-rate
 * plan there's no per-token bill, so this is all about activity, not money.
 */
function classifyLocal(usage: Usage, config: Config): StateReason {
  const rate = usage.rate_per_min;
  const { low, mid, high, veryHigh } = config.thresholds;
  const active = usage.session_active;
  const r = formatRate(rate);

  // Day/night rhythm: the cat only naps at night (22:00–05:59 local) when it's
  // been idle a while. During the day an idle cat stays up and *plays* instead
  // of sleeping — a daytime companion shouldn't be curled up asleep.
  const hour = new Date().getHours();
  const isNight = hour >= 22 || hour < 6;
  const NIGHT_SLEEP_IDLE = 15;

  if (!active && isNight && usage.idle_minutes > NIGHT_SLEEP_IDLE)
    return { state: 'sleeping', reason: `밤 · 비활성 ${Math.round(usage.idle_minutes)}분` };
  if (isSustainedHighRate(usage, high) && rate >= high)
    return {
      state: 'exhausted',
      reason: `30분+ 지속 고활동 (rate ≥ ${formatRate(high)})`,
    };
  if (rate > veryHigh)
    return { state: 'angry', reason: `rate ${r} > angry ${formatRate(veryHigh)}` };
  if (rate > high)
    return { state: 'alert', reason: `rate ${r} > alert ${formatRate(high)}` };
  if (rate > mid)
    return { state: 'active', reason: `rate ${r} > active ${formatRate(mid)}` };
  // Baseline: an idle daytime cat pokes around (curious) rather than sitting in
  // the higher-energy "playing" — usage climbing past mid/high/veryHigh steps it
  // up to active/alert/angry from here. (`playing` is kept for the launch/greet
  // hello, not the resting baseline.)
  return {
    state: 'curious',
    reason:
      rate > low
        ? `rate ${r} > curious ${formatRate(low)}`
        : isNight
          ? '밤 · 유휴'
          : '낮 · 기웃기웃',
  };
}

/**
 * Map a usage snapshot onto one of the cat's moods **and** report which rule
 * fired. When the session-usage integration is live it adds two things the
 * local logs can't give on their own:
 *
 *  - **`sessionRising`** — the session % has climbed recently, i.e. you're
 *    using Claude *right now* (including on the web, which the CLI logs never
 *    see). This is the honest "actively using" signal: the absolute % alone
 *    can't tell a busy window from a high-but-idle one. When it's set and the
 *    CLI looks calmer, the cat perks up to `active`.
 *  - **`sessionPct`** — the accumulated 5-hour usage, used only for the
 *    near-the-cap → worn out signal (not as a liveliness gauge).
 *
 * Otherwise the local-activity mood stands, so an idle machine still naps even
 * at a high accumulated %.
 */
/** Milliseconds after launch during which the cat stays awake even with no
 * recent activity, so a fresh start greets you instead of napping on the spot. */
const LAUNCH_GRACE_MS = 120_000;
const LAUNCHED_AT = Date.now();

/**
 * Public classifier — wraps {@link classifyCore} with a launch grace: for the
 * first couple of minutes after the app starts, a would-be `sleeping` reads as
 * `playing` instead, so the cat perks up and wanders rather than dozing off the
 * instant it opens.
 */
export function classifyWithReason(
  usage: Usage,
  config: Config,
  sessionPct?: number | null,
  sessionRising?: boolean,
): StateReason {
  const r = classifyCore(usage, config, sessionPct, sessionRising);
  if (r.state === 'sleeping' && Date.now() - LAUNCHED_AT < LAUNCH_GRACE_MS) {
    return { state: 'playing', reason: '방금 시작 · 기지개 켜는 중' };
  }
  return r;
}

function classifyCore(
  usage: Usage,
  config: Config,
  sessionPct?: number | null,
  sessionRising?: boolean,
): StateReason {
  const local = classifyLocal(usage, config);
  if (sessionPct == null) return local;

  // Values may arrive as a 0–1 fraction or an already-0–100 number.
  const pct = sessionPct <= 1 ? sessionPct * 100 : sessionPct;

  // Near the 5-hour cap → worn out regardless of current activity.
  if (pct >= SESSION_TIRED_PCT)
    return { state: 'exhausted', reason: `세션 한도 임박 (${Math.round(pct)}%)` };

  // Actively using Claude now (session climbing) — keep the cat lively even if
  // the CLI is quiet (e.g. you're on claude.ai). Never downgrade a busier
  // CLI-driven mood.
  if (sessionRising) {
    const web: StateReason = { state: 'active', reason: `Claude 사용 중 · 세션 ${Math.round(pct)}%` };
    return SEVERITY[local.state] >= SEVERITY[web.state] ? local : web;
  }

  return local;
}

/** Just the mood — thin wrapper over {@link classifyWithReason}. */
export function classify(usage: Usage, config: Config): CatState {
  return classifyWithReason(usage, config).state;
}

export const STATE_LABEL: Record<CatState, string> = {
  sleeping: '자는 중',
  playing: '노는 중',
  curious: '기웃기웃',
  active: '활발',
  alert: '경계',
  angry: '하악!',
  exhausted: '탈진',
};
