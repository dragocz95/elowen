/** Format a run duration (ms) as a compact "1h 4m" / "3m 12s" / "8s" label.
 *  Single source of truth for run-length formatting across the UI. */
export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

/** Single-unit elapsed ladder (ms → "12s" / "3m" / "5h" / "2d"). Picks the largest unit that
 *  fits, so it reads at a glance — unlike the two-unit `formatDuration`. Negatives clamp to "0s".
 *  Single source of truth for the compact relative-time chips across the UI. */
export function compactElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
