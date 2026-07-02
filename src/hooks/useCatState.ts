import { CatState, Config, Usage } from '../types';

/**
 * Map a usage snapshot onto one of the cat's moods. Ported from the design in
 * the project brief; thresholds come from config so they stay tunable.
 *
 * `rate` is tokens/min over the trailing 5 minutes; `dailyRatio` is today's
 * spend against the daily budget.
 */
export function classify(usage: Usage, config: Config): CatState {
  const rate = usage.rate_per_min;
  const { low, mid, high, veryHigh } = config.thresholds;
  const active = usage.session_active;
  const dailyRatio = config.dailyBudget > 0 ? usage.today_cost / config.dailyBudget : 0;

  if (!active && usage.idle_minutes > 30) return 'sleeping';
  if (dailyRatio > 0.95 && rate > high) return 'exhausted';
  if (rate > veryHigh || dailyRatio > 0.85) return 'angry';
  if (rate > high || dailyRatio > 0.6) return 'alert';
  if (rate > mid) return 'active';
  if (rate > low) return 'curious';
  return 'playing';
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
