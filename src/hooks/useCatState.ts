import { CatState, Config, Usage } from '../types';
import { formatRate, formatTokens } from '../utils/format';

/** A cat mood plus a human-readable line explaining *why* it was chosen. */
export interface StateReason {
  state: CatState;
  /** Korean explanation naming the branch + the numbers that fired it. */
  reason: string;
}

/**
 * Map a usage snapshot onto one of the cat's moods **and** report which rule
 * fired. Thresholds come from config so they stay tunable.
 *
 * Everything is driven by **activity**, not money — the user is on a Claude
 * Team flat-rate plan, so there is no per-token bill to model. `rate` is
 * tokens/min over the trailing 5 minutes and picks the mood; `exhausted` layers
 * on top as "busy *and* the day's cumulative tokens crossed a ceiling", so a
 * marathon session eventually tires the cat out.
 */
export function classifyWithReason(usage: Usage, config: Config): StateReason {
  const rate = usage.rate_per_min;
  const { low, mid, high, veryHigh } = config.thresholds;
  const active = usage.session_active;
  const todayTokens = usage.today_tokens;
  const exhaustedThreshold =
    config.exhaustedTokenThreshold ?? DEFAULT_EXHAUSTED_TOKENS;
  const r = formatRate(rate);

  if (!active && usage.idle_minutes > 30)
    return { state: 'sleeping', reason: `비활성 · 마지막 활동 ${Math.round(usage.idle_minutes)}분 전` };
  if (todayTokens > exhaustedThreshold && rate > high)
    return {
      state: 'exhausted',
      reason: `오늘 ${formatTokens(todayTokens)} > ${formatTokens(exhaustedThreshold)} & rate ${r} > ${formatRate(high)}`,
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

/** Fallback ceiling if config somehow lacks the field (matches DEFAULT_CONFIG). */
const DEFAULT_EXHAUSTED_TOKENS = 50_000_000;

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
