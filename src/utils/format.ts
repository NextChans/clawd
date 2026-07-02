export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return `${n}`;
}

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatRate(perMin: number): string {
  return `${formatTokens(perMin)}/min`;
}

export function formatIdle(minutes: number): string {
  if (!isFinite(minutes) || minutes > 60 * 24 * 30) return '—';
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${Math.round(minutes)}분 전`;
  const h = Math.floor(minutes / 60);
  return `${h}시간 전`;
}
