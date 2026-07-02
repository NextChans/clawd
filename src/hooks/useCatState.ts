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

/**
 * Map a usage snapshot onto one of the cat's moods **and** report which rule
 * fired. Thresholds come from config so they stay tunable.
 *
 * Everything is driven by **activity**, not money — the user is on a Claude
 * Team flat-rate plan, so there is no per-token bill to model. `rate` is
 * tokens/min over the trailing 5 minutes and picks the mood; `exhausted` layers
 * on top when that rate has stayed at/above the alert threshold for a sustained
 * ~30-minute stretch, so a long marathon session eventually tires the cat out.
 */
export function classifyWithReason(usage: Usage, config: Config): StateReason {
  const rate = usage.rate_per_min;
  const { low, mid, high, veryHigh } = config.thresholds;
  const active = usage.session_active;
  const r = formatRate(rate);

  // At night the cat dozes off sooner: relax the sleep-idle threshold from 30m
  // to 15m during 22:00–05:59 (local). Matches roam.rs's night wind-down.
  const hour = new Date().getHours();
  const isNight = hour >= 22 || hour < 6;
  const sleepIdle = isNight ? 15 : 30;

  if (!active && usage.idle_minutes > sleepIdle)
    return { state: 'sleeping', reason: `비활성 · 마지막 활동 ${Math.round(usage.idle_minutes)}분 전` };
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
  if (rate > low)
    return { state: 'curious', reason: `rate ${r} > curious ${formatRate(low)}` };
  return { state: 'playing', reason: rate > 0 ? `rate ${r} · 여유` : '유휴 · 활동 없음' };
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
