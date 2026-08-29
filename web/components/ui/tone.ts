export type Tone = 'default' | 'accent' | 'muted' | 'danger' | 'success' | 'warning';

/** Canonical tone → text-color class. Shared by every surface that colors text/icons by tone
 *  (timeline, event stream, dashboard signals) so a palette change lives in one place. */
export const TONE_TEXT: Record<Tone, string> = {
  default: 'text-muted-foreground',
  accent: 'text-primary',
  muted: 'text-muted-foreground',
  danger: 'text-destructive',
  success: 'text-success',
  warning: 'text-warning',
};
