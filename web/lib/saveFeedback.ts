import type { SaveStatus } from './useAutoSaveStatus';

/** One section's autosave state plus an optional retry for the error case. */
export type SaveFeedback = { status: SaveStatus; retry?: () => void | Promise<void> };

/** Fold several sections' save states into one. Errors win, then active saves, delayed activation,
 * saved, and finally idle. A composite error always retries every failed child in declaration order. */
export function combineSaveFeedback(...items: SaveFeedback[]): SaveFeedback {
  const errors = items.filter((item) => item.status === 'error');
  if (errors.length > 0) {
    const retries = errors.map((item) => item.retry).filter((retry): retry is () => void | Promise<void> => Boolean(retry));
    return {
      status: 'error',
      retry: retries.length > 0 ? () => { for (const retry of retries) void retry(); } : undefined,
    };
  }
  if (items.some((item) => item.status === 'saving')) return { status: 'saving' };
  if (items.some((item) => item.status === 'pending')) return { status: 'pending' };
  if (items.some((item) => item.status === 'saved')) return { status: 'saved' };
  return { status: 'idle' };
}
