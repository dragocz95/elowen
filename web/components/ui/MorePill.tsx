'use client';
import { useTranslation } from '../../lib/i18n';

/** The single "+N more" / "Show less" collapse toggle shared by every pill row (plugin config, cron
 *  channel/model pickers, user tools, model catalog, a folded diff). One component so the expander is
 *  ALWAYS the same bordered pill — never a text link or a dashed variant. `hidden` is the folded-away
 *  count shown in the collapsed label; when `expanded` it reads "Show less" regardless.
 *
 *  `controls` names the element the pill unfolds, and `label` replaces the announced text where the
 *  generic "+N more" would be ambiguous — several pills on one screen folding different things. */
const cls = 'rounded-full border border-border px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:border-primary hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';

export function MorePill({ expanded, hidden, onToggle, controls, label }: {
  expanded: boolean;
  hidden: number;
  onToggle: () => void;
  controls?: string;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={controls} aria-label={label} className={cls}>
      {expanded ? t.pills.showLess : t.pills.showMore.replace('{n}', String(hidden))}
    </button>
  );
}
