import type { ReactNode } from 'react';
import type { Tone } from './tone';

import { Badge as ShadcnBadge, badgeVariants } from './shadcn/badge';

/** The app-shaped badge, composed from the shadcn/ui `Badge` in `./shadcn/badge.tsx`.
 *
 *  Only the vocabulary is this file's. The app colours a badge by TONE — the shared `Tone` union that the
 *  timeline, the event stream and the dashboard signals all read from `./tone.ts` — where shadcn names a
 *  badge by role. The two are not the same axis: `success` and `warning` are tones with no shadcn variant
 *  at all, and every tone here is the soft form rather than shadcn's solid one. This map is what keeps
 *  all 21 call sites untouched, and it goes away with this wrapper in a later phase. */
const TONE_VARIANT = {
  default: 'secondary',
  muted: 'secondary',
  accent: 'soft-primary',
  danger: 'soft-destructive',
  success: 'soft-success',
  warning: 'soft-warning',
} as const satisfies Record<Tone, NonNullable<Parameters<typeof badgeVariants>[0]>['variant']>;

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: Tone }) {
  return <ShadcnBadge variant={TONE_VARIANT[tone]}>{children}</ShadcnBadge>;
}
