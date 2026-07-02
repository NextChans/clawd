import { formatTokens } from '../../utils/format';

/**
 * A dependency-free SVG sparkline of today's tokens per local hour (24 buckets).
 * Draws a smooth (Catmull-Rom) area curve with a subtle fill and marks the
 * current hour with a vertical guide + dot. Renders nothing on an empty day.
 */
const W = 208;
const H = 44;
const PAD = 4;

/** Catmull-Rom spline through `pts` as a cubic-bezier path `d` string. */
function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]},${pts[0][1]}`;
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

export function HourlySparkline({ data }: { data: number[] }) {
  // Defensive: always work on a 24-length series.
  const series = Array.from({ length: 24 }, (_, i) => data[i] ?? 0);
  const total = series.reduce((a, v) => a + v, 0);
  if (total <= 0) return null;

  const max = Math.max(1, ...series);
  const x = (i: number) => PAD + (i / 23) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const pts: [number, number][] = series.map((v, i) => [x(i), y(v)]);

  const line = smoothPath(pts);
  const area = `${line} L ${x(23).toFixed(2)},${H - PAD} L ${x(0).toFixed(2)},${H - PAD} Z`;

  const nowHour = new Date().getHours();
  const nowX = x(nowHour);
  const nowY = y(series[nowHour]);

  const peak = series.indexOf(max);

  return (
    <section className="d-spark">
      <div className="d-spark-head">
        <span>오늘 시간대별</span>
        <span className="d-spark-peak">피크 {peak}시 · {formatTokens(max)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden>
        <path d={area} className="d-spark-area" />
        <path d={line} className="d-spark-line" fill="none" />
        {/* Current-hour guide + marker. */}
        <line x1={nowX} y1={PAD} x2={nowX} y2={H - PAD} className="d-spark-now" />
        <circle cx={nowX} cy={nowY} r="2.6" className="d-spark-dot" />
      </svg>
    </section>
  );
}
