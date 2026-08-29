import type { ReactNode } from 'react';
import type { Tone } from './tone';

import { Badge as ShadcnBadge, badgeVariants } from './shadcn/badge';

/** The app-shaped badge, composed from the shadcn/ui `Badge` in `./shadcn/badge.tsx`.
 *
 *  Only the vocabulary is this file's. The app colours a badge by TONE — the shared `Tone` union that the
 *  timeline, the event stream and the dashboard signals all read from `./tone.ts` — where shadcn names a
 *  badge by role. The two are not the same axis: `success` and `warning` are tones with no shadcn variant
 *  at all, and every tone here is the soft form rather than shadcn's solid one. This map goes away with
 *  the wrapper in a later phase.
 *
 *  `default` and `muted` both resolved to `secondary`, which made the quiet tone a synonym rather than a
 *  step down — a caller asking for less emphasis got exactly the same chip, so `tone="muted"` documented
 *  an intention the UI never carried out. They are now the two neutral shadcn variants, and which way
 *  round follows from what the tones mean: `muted` keeps the filled chip with MUTED ink, which is the
 *  quieter of the two and the paint both tones used to share, and `default` takes the outlined chip with
 *  full-strength ink. The ordinary badge is the one that has to be read (a plugin id, a model's context
 *  window); the muted one is the one allowed to recede into the row. */
const TONE_VARIANT = {
  default: 'outline',
  muted: 'secondary',
  accent: 'soft-primary',
  danger: 'soft-destructive',
  success: 'soft-success',
  warning: 'soft-warning',
} as const satisfies Record<Tone, NonNullable<Parameters<typeof badgeVariants>[0]>['variant']>;

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return <ShadcnBadge variant={TONE_VARIANT[tone]}>{children}</ShadcnBadge>;
}
