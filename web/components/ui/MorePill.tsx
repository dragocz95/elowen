'use client';
import { useTranslation } from '../../lib/i18n';

/** The single "+N more" / "Show less" collapse toggle shared by every pill row (plugin config, cron
 *  channel/model pickers, user tools, model catalog). One component so the expander is ALWAYS the same
 *  bordered pill — never a text link or a dashed variant. `hidden` is the folded-away count shown in the
 *  collapsed label; when `expanded` it reads "Show less" regardless. */
const cls = 'rounded-full border border-border px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:border-accent hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export function MorePill({ expanded, hidden, onToggle }: { expanded: boolean; hidden: number; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className={cls}>
      {expanded ? t.pills.showLess : t.pills.showMore.replace('{n}', String(hidden))}
    </button>
  );
}
