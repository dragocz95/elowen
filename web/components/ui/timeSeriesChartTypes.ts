/** The shapes `TimeSeriesChart` and its Recharts half both need.
 *
 *  They live apart from either component because the wrapper lazy-imports the implementation while the
 *  implementation needs the wrapper's prop types — a cycle, even though nothing but a type crosses it. A
 *  type-only edge is still an edge to the bundler and to depcruise, so the contract gets its own module
 *  and both sides depend on it instead of on each other. */

interface TimeSeriesPoint {
  /** The category shown on the x axis and in the tooltip heading. */
  label: string;
  [key: string]: string | number | null;
}

export interface TimeSeriesSeries {
  /** Key into each point. */
  key: string;
  label: string;
  /** Any CSS colour; a `var(--color-…)` token keeps the series on theme. */
  colour: string;
  variant?: 'bar' | 'line';
  /** Which axis this series is measured against. Two series in one unit should share one axis. */
  axis?: 'left' | 'right';
  /** Locale formatting belongs to the caller — the chart never guesses a currency or a number format. */
  format: (value: number) => string;
}

/** A per-point readout the tooltip (and the sr-only figures) state WITHOUT drawing it: a component of a
 *  drawn series, read straight off the data point. It carries no colour because it has no mark to match. */
export interface TimeSeriesDetail {
  /** Key into each point. */
  key: string;
  label: string;
  format: (value: number) => string;
}

export interface TimeSeriesChartProps {
  data: TimeSeriesPoint[];
  series: TimeSeriesSeries[];
  /** Undrawn breakdown rows shown under the drawn series in the tooltip and the sr-only list. */
  detail?: TimeSeriesDetail[];
  height?: number;
  emptyText?: string;
  ariaLabel?: string;
}
