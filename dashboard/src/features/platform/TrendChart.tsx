import { useState } from 'react';

export interface TrendPoint {
  id: string;
  label: string;
  value: number;
}
const width = 380,
  height = 170,
  left = 34,
  right = 10,
  top = 12,
  bottom = 20;

/** Picks a round step so the axis ends just above the largest value. */
function axis(maximum: number) {
  const rough = maximum / 3 || 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * power).find((n) => n >= rough)!;
  return { step, ceiling: step * 3 };
}

/** One series, oldest to newest, with the last point marked as the latest run. */
export function TrendChart({
  title,
  unit,
  points,
  scale,
  format,
  median,
}: {
  title: string;
  unit: string;
  points: TrendPoint[];
  /** Divides raw values into axis units, such as milliseconds into minutes. */
  scale: number;
  format: (value: number) => string;
  median?: number | null;
}) {
  const [hover, setHover] = useState<number>();
  const { step, ceiling } = axis(Math.max(...points.map((p) => p.value), median ?? 0) / scale);
  const x = (index: number) =>
    left + (points.length > 1 ? (index * (width - left - right)) / (points.length - 1) : 0);
  const y = (value: number) =>
    height - bottom - (value / scale / ceiling) * (height - top - bottom);
  const shown = hover === undefined ? undefined : points[hover];
  return (
    <figure className="trend-chart">
      <figcaption>
        <strong>{title}</strong>
        <span>{shown ? `${shown.label} · ${format(shown.value)}` : unit}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${title} across the last ${points.length} successful runs, oldest to newest`}
        onMouseLeave={() => setHover(undefined)}
      >
        {[0, 1, 2, 3].map((tick) => (
          <g key={tick}>
            <line
              className="trend-grid"
              x1={left}
              x2={width - right}
              y1={y(tick * step * scale)}
              y2={y(tick * step * scale)}
            />
            <text x={left - 8} y={y(tick * step * scale) + 4} textAnchor="end">
              {Number((tick * step).toFixed(2))}
            </text>
          </g>
        ))}
        {median != null && (
          <line
            className="trend-median"
            x1={left}
            x2={width - right}
            y1={y(median)}
            y2={y(median)}
          />
        )}
        <polyline points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
        {points.map((p, i) => (
          <g key={p.id}>
            <circle
              className={i === points.length - 1 ? 'trend-latest' : undefined}
              cx={x(i)}
              cy={y(p.value)}
              r={i === hover ? 6 : i === points.length - 1 ? 5 : 4}
            />
            <rect
              x={x(i) - (width - left - right) / points.length / 2}
              y={0}
              width={(width - left - right) / points.length}
              height={height}
              onMouseEnter={() => setHover(i)}
            >
              <title>
                {p.label}: {format(p.value)}
              </title>
            </rect>
          </g>
        ))}
        <text x={left} y={height - 4}>
          {points[0]!.label}
        </text>
        <text x={width - right} y={height - 4} textAnchor="end">
          {points.at(-1)!.label}
        </text>
      </svg>
    </figure>
  );
}
