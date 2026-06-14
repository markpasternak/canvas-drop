/** A dependency-free inline-SVG sparkline (D24 view trend). Hand-drawn the same
 *  way FileTree draws its SVG — no chart library. Scales to its container width;
 *  `currentColor` lets callers theme the stroke. */
export interface SparklinePoint {
  dayMs: number;
  count: number;
}

export function Sparkline({ data, className }: { data: SparklinePoint[]; className?: string }) {
  const width = 240;
  const height = 40;
  const pad = 2;
  const n = data.length;
  // Floor of 1 keeps a flat zero-series on the baseline instead of dividing by zero.
  const max = Math.max(1, ...data.map((d) => d.count));
  const points = data.map((d, i) => {
    const x = n <= 1 ? width / 2 : pad + (i / (n - 1)) * (width - 2 * pad);
    const y = height - pad - (d.count / max) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={`Views over the last ${n} days`}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
