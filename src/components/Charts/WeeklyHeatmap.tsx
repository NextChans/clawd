import { useState } from 'react';
import { formatTokens } from '../../utils/format';

/**
 * A dependency-free SVG heatmap of the trailing 7 days × 24 local hours. Each
 * cell's blue intensity encodes that weekday-hour's token volume on a log scale
 * (so a couple of huge hours don't wash the rest out). Rows are Mon→Sun to read
 * as a weekly habit; the current weekday's row is outlined. Hovering a cell
 * shows a tooltip with the weekday, hour, and token count. Renders nothing on a
 * fully empty week.
 *
 * `data` mirrors `usage.weekly_hourly`: 7 rows (Monday = 0 … Sunday = 6) × 24
 * hourly columns.
 */
const CELL = 12; // stride per cell (px)
const INSET = 1; // gap so cells read as a grid
const LABEL_W = 20; // left gutter for weekday labels
const TOP = 3;
const HOUR_LABEL_H = 14;
const GRID_H = 7 * CELL;
const TOTAL_W = LABEL_W + 24 * CELL;
const TOTAL_H = TOP + GRID_H + HOUR_LABEL_H;

/** Mon→Sun initials, matching the row order in `usage.weekly_hourly`. */
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
/** Sparse hour ticks along the bottom axis. */
const HOUR_TICKS = [0, 6, 12, 18, 23];

/** JS `getDay()` is Sun=0; convert to our Mon=0 row index. */
function todayRow(): number {
  return (new Date().getDay() + 6) % 7;
}

interface HoverCell {
  wd: number;
  hr: number;
  v: number;
}

export function WeeklyHeatmap({ data }: { data: number[][] }) {
  const [hover, setHover] = useState<HoverCell | null>(null);

  // Defensive: always work on a 7×24 grid regardless of what the payload holds.
  const grid = Array.from({ length: 7 }, (_, wd) =>
    Array.from({ length: 24 }, (_, hr) => data[wd]?.[hr] ?? 0),
  );
  const max = Math.max(0, ...grid.flat());
  if (max <= 0) return null;

  const logMax = Math.log1p(max);
  const today = todayRow();

  return (
    <section className="d-heat">
      <div className="d-heat-head">
        <span>최근 7일 활동</span>
        {hover && (
          <span className="d-heat-hint">
            {WEEKDAYS[hover.wd]} {hover.hr}시 · {formatTokens(hover.v)}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${TOTAL_W} ${TOTAL_H}`}
        width={TOTAL_W}
        height={TOTAL_H}
        role="img"
        aria-label="최근 7일 요일·시간대별 토큰 히트맵"
      >
        {grid.map((row, wd) =>
          row.map((v, hr) => {
            const t = v > 0 ? Math.log1p(v) / logMax : 0;
            const fill =
              v > 0 ? `rgba(58, 110, 209, ${(0.14 + 0.86 * t).toFixed(3)})` : 'rgba(128,128,128,0.1)';
            return (
              <rect
                key={`${wd}-${hr}`}
                x={LABEL_W + hr * CELL + INSET}
                y={TOP + wd * CELL + INSET}
                width={CELL - 2 * INSET}
                height={CELL - 2 * INSET}
                rx={2}
                fill={fill}
                onMouseEnter={() => setHover({ wd, hr, v })}
                onMouseLeave={() => setHover((h) => (h?.wd === wd && h?.hr === hr ? null : h))}
              />
            );
          }),
        )}

        {/* Outline today's weekday row. */}
        <rect
          x={LABEL_W}
          y={TOP + today * CELL}
          width={24 * CELL}
          height={CELL}
          rx={2.5}
          fill="none"
          className="d-heat-today"
        />

        {/* Weekday row labels (right-aligned in the gutter). */}
        {WEEKDAYS.map((d, wd) => (
          <text
            key={d}
            x={LABEL_W - 5}
            y={TOP + wd * CELL + CELL / 2}
            textAnchor="end"
            dominantBaseline="central"
            className={wd === today ? 'd-heat-wd today' : 'd-heat-wd'}
          >
            {d}
          </text>
        ))}

        {/* Sparse hour ticks along the bottom. */}
        {HOUR_TICKS.map((h) => (
          <text
            key={h}
            x={LABEL_W + h * CELL + CELL / 2}
            y={TOP + GRID_H + 10}
            textAnchor="middle"
            className="d-heat-hr"
          >
            {h}
          </text>
        ))}
      </svg>
    </section>
  );
}
