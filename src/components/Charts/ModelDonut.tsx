import { ModelUsage } from '../../types';
import { formatTokens } from '../../utils/format';

/**
 * A dependency-free SVG donut of today's tokens split by model family. Raw model
 * ids (which vary by version) are folded into four families so the ring stays
 * legible: Opus (purple), Sonnet (blue), Haiku (green), and everything else
 * (gray). The center shows the day's total. Renders nothing on an empty day.
 */
type Family = 'Opus' | 'Sonnet' | 'Haiku' | '기타';

const FAMILY_ORDER: Family[] = ['Opus', 'Sonnet', 'Haiku', '기타'];
const FAMILY_COLOR: Record<Family, string> = {
  Opus: '#a274e8',
  Sonnet: '#4a90d9',
  Haiku: '#4bb58a',
  기타: '#9a938a',
};

function familyOf(model: string): Family {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return '기타';
}

export function ModelDonut({ models }: { models: ModelUsage[] }) {
  const totals = new Map<Family, number>();
  for (const m of models) {
    const f = familyOf(m.model);
    totals.set(f, (totals.get(f) ?? 0) + m.tokens);
  }

  const segments = FAMILY_ORDER.map((family) => ({
    family,
    tokens: totals.get(family) ?? 0,
    color: FAMILY_COLOR[family],
  })).filter((s) => s.tokens > 0);

  const total = segments.reduce((a, s) => a + s.tokens, 0);
  if (total <= 0) return null;

  const r = 38;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((s) => {
    const frac = s.tokens / total;
    const dash = frac * circumference;
    const arc = { ...s, frac, dash, gap: circumference - dash, off: offset };
    offset += dash;
    return arc;
  });

  return (
    <section className="d-donut">
      <svg viewBox="0 0 100 100" width="96" height="96" role="img" aria-label="오늘 모델별 토큰">
        {/* Ring starts at 12 o'clock. */}
        <g transform="rotate(-90 50 50)">
          <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(128,128,128,0.16)" strokeWidth="15" />
          {arcs.map((a) => (
            <circle
              key={a.family}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth="15"
              strokeDasharray={`${a.dash} ${a.gap}`}
              strokeDashoffset={-a.off}
            />
          ))}
        </g>
        <text x="50" y="48" textAnchor="middle" className="d-donut-total">
          {formatTokens(total)}
        </text>
        <text x="50" y="61" textAnchor="middle" className="d-donut-cap">
          tokens
        </text>
      </svg>
      <ul className="d-donut-legend">
        {arcs.map((a) => (
          <li key={a.family}>
            <span className="d-donut-dot" style={{ background: a.color }} />
            <span className="d-donut-name">{a.family}</span>
            <span className="d-donut-pct">{Math.round(a.frac * 100)}%</span>
            <span className="d-donut-tok">{formatTokens(a.tokens)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
