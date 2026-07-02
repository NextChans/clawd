import { CatState, Config, Usage } from '../types';
import { formatRate } from '../utils/format';

/** A cat mood plus a human-readable line explaining *why* it was chosen. */
export interface StateReason {
  state: CatState;
  /** Korean explanation naming the branch + the numbers that fired it. */
  reason: string;
}

/**
 * Map a usage snapshot onto one of the cat's moods **and** report which rule
 * fired. Ported from the design in the project brief; thresholds come from
 * config so they stay tunable.
 *
 * `rate` is tokens/min over the trailing 5 minutes; `dailyRatio` is today's
 * spend against the daily budget. The branch order and thresholds are identical
 * to the original `classify` — the `||` branches are only *split* so we can say
 * whether it was the rate side or the budget side that tripped (crucial for the
 * user: a rate-driven `alert` cannot be cleared by moving the budget).
 */
export function classifyWithReason(usage: Usage, config: Config): StateReason {
  const rate = usage.rate_per_min;
  const { low, mid, high, veryHigh } = config.thresholds;
  const active = usage.session_active;
  const dailyRatio = config.dailyBudget > 0 ? usage.today_cost / config.dailyBudget : 0;
  const pct = Math.round(dailyRatio * 100);
  const r = formatRate(rate);

  if (!active && usage.idle_minutes > 30)
    return { state: 'sleeping', reason: `비활성 · 마지막 활동 ${Math.round(usage.idle_minutes)}분 전` };
  if (dailyRatio > 0.95 && rate > high)
    return { state: 'exhausted', reason: `예산 ${pct}% (>95%) & rate ${r} > ${formatRate(high)}` };
  if (rate > veryHigh)
    return { state: 'angry', reason: `rate ${r} > angry ${formatRate(veryHigh)}` };
  if (dailyRatio > 0.85)
    return { state: 'angry', reason: `예산 ${pct}% > 85%` };
  if (rate > high)
    return { state: 'alert', reason: `rate ${r} > alert ${formatRate(high)}` };
  if (dailyRatio > 0.6)
    return { state: 'alert', reason: `예산 ${pct}% > 60%` };
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
