import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export function padAnsi(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? truncateToWidth(text, width) : text + ' '.repeat(width - w);
}

export function formatK(n: number): string {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

/** Elapsed run time for humans: seconds under a minute, then `2m 17s` — a five-digit seconds counter
 *  reads as noise once an agent runs long. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
