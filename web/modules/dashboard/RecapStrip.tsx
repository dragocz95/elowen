'use client';
import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import { openBrainComposer, openBrainSession } from '../../lib/brainDock';
import { useTranslation } from '../../lib/i18n';
import { Button } from '../../components/ui/Button';
import type { DashRecap, DashRecapVariant } from '../../lib/types';
import type { useRecapRotation } from './useRecapRotation';

/** Render emphasis as text nodes, never model-written markup. */
function emphasize(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <b key={i} className="font-medium text-foreground">{part}</b> : part);
}

const PILL =
  'inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-[13px] text-muted-foreground transition-[background-color,border-color,color] hover:border-muted-foreground hover:text-foreground active:bg-muted';

/** The lower recap and its controls use the same selection as the headline and quick actions. */
export function RecapStrip({ recap, rotation }: {
  recap: DashRecap | undefined;
  rotation: ReturnType<typeof useRecapRotation>;
}) {
  const { t } = useTranslation();
  const { variants, current, index: idx, leavingIndex: leavingIdx, paused, setPaused, goTo } = rotation;
  const count = variants.length;
  if (!recap?.enabled) return null;

  const sessions = recap.yesterday?.sessions ?? [];
  const cont = (recap.continue ?? []).slice(0, 2);
  const fallbackSentence = sessions.length
    ? t.dashboard.recap.fallback.replace('{sessions}', sessions.slice(0, 2).join(', '))
    : null;
  const sentence = current?.summary ? emphasize(current.summary) : fallbackSentence;
  const suggestions = (current?.suggestions ?? []).slice(0, 3);
  if (!sentence && !cont.length && !suggestions.length && count < 2) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo((idx + 1) % count); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo((idx - 1 + count) % count); }
  };

  // Park every variant in the same grid cell: the tallest reserves the strip's height even after
  // its outgoing fade completes. Hidden layers are inert and never enter the accessibility tree.
  const layer = (variant: DashRecapVariant | undefined, mode: 'current' | 'leaving' | 'parked', key: string) => {
    const line = variant?.summary ? emphasize(variant.summary) : fallbackSentence;
    const steps = (variant?.suggestions ?? []).slice(0, 3);
    return (
      <div
        key={key}
        className={[
          '[grid-area:1/1]',
          mode === 'leaving' ? 'recap-variant-out' : '',
          mode === 'current' && leavingIdx !== null ? 'recap-variant-in' : '',
          mode === 'parked' ? 'invisible' : '',
        ].filter(Boolean).join(' ')}
        {...(mode !== 'current' ? { inert: true, 'aria-hidden': true } : {})}
      >
        {line ? (
          <p className="mx-auto max-w-[34rem] text-sm leading-relaxed text-muted-foreground">{line}</p>
        ) : null}
        {cont.length || steps.length ? (
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
            {steps.map((s, i) => (
              <li key={`sugg-${i}`}>
                <button type="button" className={PILL} title={s.prompt} onClick={() => openBrainComposer(s.prompt)}>
                  <ArrowUpRight size={13} aria-hidden className="shrink-0 text-subtle-foreground" />
                  <span className="max-w-[16rem] truncate">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  };

  return (
    <section aria-label={t.dashboard.recap.label} className="mx-auto mt-10 w-full max-w-2xl text-center">
      <div aria-live="off" className="grid">
        {current !== undefined && leavingIdx !== null ? layer(variants[leavingIdx], 'leaving', `out-${leavingIdx}`) : null}
        {layer(current, 'current', `in-${idx}`)}
        {variants.map((v, i) => (i !== idx && i !== leavingIdx ? layer(v, 'parked', `parked-${i}`) : null))}
      </div>
      {count > 1 ? (
        <div role="group" aria-label={t.dashboard.recap.rotation} onKeyDown={onKey}
          className="mt-3 flex items-center justify-center gap-1">
          <Button variant="ghost" size="sm" aria-label={t.dashboard.recap.prev} onClick={() => goTo((idx - 1 + count) % count)}>
            <ChevronLeft size={14} aria-hidden />
          </Button>
          <Button variant="ghost" size="sm" aria-label={paused ? t.dashboard.recap.resume : t.dashboard.recap.pause}
            onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
          </Button>
          <Button variant="ghost" size="sm" aria-label={t.dashboard.recap.next} onClick={() => goTo((idx + 1) % count)}>
            <ChevronRight size={14} aria-hidden />
          </Button>
          <span aria-hidden className="ml-1 text-xs tabular-nums">{`${idx + 1} / ${count}`}</span>
        </div>
      ) : null}
    </section>
  );
}
