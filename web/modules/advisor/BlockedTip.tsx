'use client';
import { useId, useState } from 'react';
import { Ban } from 'lucide-react';
import { interpolate, useTranslation } from '../../lib/i18n';
import { Tooltip, TooltipAnchor, TooltipContent } from '../../components/ui/shadcn/tooltip';

/** Why a pending task cannot start yet — the unresolved blockers, named.
 *
 *  The app's Tooltip is a CONTROLLED popover (see components/ui/shadcn/tooltip.tsx), so it needs open
 *  state of its own, which is why an ordinary truncated row uses a native `title` instead. A blocked task
 *  is the exception that earns one: the blocker ids are information the reader has to be able to reach on
 *  a touch screen, where there is no hover for a `title` to answer — hence the click handler beside the
 *  hover and focus ones. Only a blocked row mounts it.
 *
 *  Both places that list tasks render THIS component — the telemetry rail's Tasks section and the
 *  transcript's todo card — so the two cannot drift into two different answers to the same question.
 *  `testId` is the only thing they differ in: each surface addresses its own rows. */
export function BlockedTip({ ids, testId }: { ids: readonly string[]; testId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const text = interpolate(t.telemetry.taskBlocked, { ids: ids.map((id) => `#${id}`).join(', ') });
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipAnchor asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={text}
          aria-describedby={open ? tipId : undefined}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 text-subtle-foreground transition-colors hover:text-foreground"
        >
          <Ban size={11} aria-hidden />
        </button>
      </TooltipAnchor>
      <TooltipContent id={tipId} align="end" className="w-auto max-w-56">{text}</TooltipContent>
    </Tooltip>
  );
}
