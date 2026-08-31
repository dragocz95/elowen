'use client';
import type { ReactNode } from 'react';
import { ArrowUpRight, RotateCcw } from 'lucide-react';
import { openBrainComposer, openBrainSession } from '../../lib/brainDock';
import { useTranslation } from '../../lib/i18n';
import type { DashRecap } from '../../lib/types';

/** The approved v3 shape (31 Aug 2026): NO cards. One quiet centered sentence about yesterday and one
 *  pill row in the page's own pill vocabulary — ↺ continues a conversation, ↗ seeds the composer with
 *  a suggested next step. Numbers stay out: the top strip already carries them. Renders nothing at all
 *  without data, so a fresh instance keeps today's landing page exactly. */

/** Render the digest's `**…**` emphasis as brighter text. Any other markup arrives as plain text —
 *  the daemon capped and sanitized the string, and this renderer only ever emits text nodes. */
function emphasize(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <b key={i} className="font-medium text-foreground">{part}</b> : part);
}

const PILL =
  'inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-[13px] text-muted-foreground transition-[background-color,border-color,color] hover:border-muted-foreground hover:text-foreground active:bg-muted';

export function RecapStrip({ recap }: { recap: DashRecap | undefined }) {
  const { t } = useTranslation();
  if (!recap?.enabled) return null;

  const digest = recap.digest?.status === 'ready' ? recap.digest : undefined;
  const sessions = recap.yesterday?.sessions ?? [];
  // The digest sentence when it exists; until then (or when generation is off) the deterministic
  // fallback built from yesterday's conversation titles. The line upgrades in place — no spinner.
  const sentence = digest?.summary
    ? emphasize(digest.summary)
    : sessions.length
      ? t.dashboard.recap.fallback.replace('{sessions}', sessions.slice(0, 2).join(', '))
      : null;

  const cont = (recap.continue ?? []).slice(0, 2);
  const suggestions = (digest?.suggestions ?? []).slice(0, 3);
  if (!sentence && !cont.length && !suggestions.length) return null;

  return (
    <section aria-label={t.dashboard.recap.label} className="mx-auto mt-10 w-full max-w-2xl text-center">
      {sentence ? (
        <p className="mx-auto max-w-[34rem] text-sm leading-relaxed text-muted-foreground">{sentence}</p>
      ) : null}
      {cont.length || suggestions.length ? (
        <ul aria-label={t.dashboard.recap.label} className="mt-4 flex flex-wrap justify-center gap-2.5">
          {cont.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={PILL}
                title={t.dashboard.recap.continueTitle.replace('{title}', s.title)}
                onClick={() => openBrainSession(s.id, true)}
              >
                <RotateCcw size={13} aria-hidden className="shrink-0 text-subtle-foreground" />
                <span className="max-w-[16rem] truncate">{s.title}</span>
              </button>
            </li>
          ))}
          {suggestions.map((s, i) => (
            <li key={`sugg-${i}`}>
              <button type="button" className={PILL} title={s.prompt} onClick={() => openBrainComposer(s.prompt)}>
                <ArrowUpRight size={13} aria-hidden className="shrink-0 text-subtle-foreground" />
                <span className="max-w-[16rem] truncate">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
