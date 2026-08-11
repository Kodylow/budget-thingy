interface SparklinePoint {
  date: string;
  spendUsd: number;
}

interface SparklineProps {
  points: SparklinePoint[];
  width?: number;
  height?: number;
  className?: string;
  'data-testid'?: string;
}

/**
 * Tiny inline SVG sparkline for daily spend history.
 * Renders a dash placeholder with fewer than 2 points.
 */
export function Sparkline({
  points,
  width = 96,
  height = 28,
  className,
  'data-testid': testId,
}: SparklineProps) {
  if (points.length < 2) {
    return (
      <span className="text-xs text-muted-foreground" data-testid={testId} title="Not enough history yet">
        {points.length === 1 ? '· collecting' : '—'}
      </span>
    );
  }

  const values = points.map((p) => p.spendUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;

  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (p.spendUsd - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });

  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      data-testid={testId}
      role="img"
      aria-label={`Spend trend over ${points.length} days`}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary" />
      {last && <circle cx={last[0]} cy={last[1]} r={2} className="fill-primary text-primary" />}
    </svg>
  );
}
