export type Tone = 'default' | 'accent' | 'muted' | 'danger' | 'success' | 'warning';

/** Canonical tone → text-color class. Shared by every surface that colors text/icons by tone
 *  (timeline, event stream, dashboard signals) so a palette change lives in one place. */
export const TONE_TEXT: Record<Tone, string> = {
  default: 'text-text-muted',
  accent: 'text-accent',
  muted: 'text-text-muted',
  danger: 'text-danger',
  success: 'text-success',
  warning: 'text-warning',
};
