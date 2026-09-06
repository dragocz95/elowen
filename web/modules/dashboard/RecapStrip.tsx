'use client';
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import { openBrainComposer, openBrainSession } from '../../lib/brainDock';
import { useEffects } from '../../lib/useEffects';
import { useTranslation } from '../../lib/i18n';
import { Button } from '../../components/ui/Button';
import type { DashRecap, DashRecapVariant } from '../../lib/types';

/** The approved v3 shape (31 Aug 2026): NO cards. One quiet centered sentence about yesterday and one
 *  pill row in the page's own pill vocabulary — ↺ continues a conversation, ↗ seeds the composer with
 *  a suggested next step. Numbers stay out: the top strip already carries them. Renders nothing at all
 *  without data, so a fresh instance keeps today's landing page exactly.
 *
 *  A generation now writes a small BATCH of recap variants of the same day (same grounding, same tone,
 *  a different telling). They rotate here, client-side only — switching a variant never touches the
 *  daemon, so the rotation costs no inference, no fetch and no poll. */

/** The auto-advance beat. A plain constant on purpose: the strip has no settings panel, and twelve
 *  seconds is long enough to read one variant and short enough that the page feels alive. */
const ROTATE_MS = 12_000;
/** Kept in step with the crossfade duration in app/styles/animations.css. */
const FADE_MS = 500;

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
  const { resolvedMode } = useEffects();
  // `cur` is the variant being shown, `prev` the one fading out under it. Both start at zero so the
  // server-rendered first frame is the same variant the client hydrates — variant 1, as always.
  const [shown, setShown] = useState<{ cur: number; prev: number | null }>({ cur: 0, prev: null });
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);

  // The rotation batch. A daemon older than the batch serves no `recaps`, so the strip derives its
  // single variant from the digest's own summary/suggestions — a legacy digest renders exactly as it
  // always did, controls and rotation absent.
  const digest = recap?.digest?.status === 'ready' ? recap.digest : undefined;
  const variants: DashRecapVariant[] = digest
    ? digest.recaps?.length
      ? digest.recaps
      : digest.summary || digest.suggestions?.length ? [{ summary: digest.summary, suggestions: digest.suggestions }] : []
    : [];
  const count = variants.length;

  // A hidden tab holds the rotation — nothing is watching, so nothing should move.
  useEffect(() => {
    const sync = () => setTabHidden(document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const crossfade = resolvedMode === 'full';
  const goTo = useCallback((next: number) => {
    setShown((s) => (next === s.cur ? s : crossfade ? { cur: next, prev: s.cur } : { cur: next, prev: null }));
  }, [crossfade]);

  // Drop the outgoing variant once its fade-out has played. The timeout belongs to the state it
  // cleans up, so an unmount clears it with the rest.
  useEffect(() => {
    if (shown.prev === null) return;
    const timer = setTimeout(() => setShown((s) => (s.prev === null ? s : { cur: s.cur, prev: null })), FADE_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  // Auto-advance only while nothing holds it: the pause button, the pointer or keyboard resting on the
  // strip, a hidden tab — or a reader who asked for less motion, for whom the crossfade is silenced by
  // CSS anyway and the timer would only churn content they did not ask to change. Manual stepping
  // stays available in every mode.
  useEffect(() => {
    if (count < 2 || paused || held || tabHidden || !crossfade) return;
    const id = setInterval(() => {
      setShown((s) => ({ cur: (s.cur + 1) % count, prev: s.cur }));
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [count, paused, held, tabHidden, crossfade]);

  if (!recap?.enabled) return null;

  const sessions = recap.yesterday?.sessions ?? [];
  const cont = (recap.continue ?? []).slice(0, 2);
  // The deterministic sentence for a variant without its own summary — the digest usually provides
  // it, so this only ever fires while generation is off or still running.
  const fallbackSentence = sessions.length
    ? t.dashboard.recap.fallback.replace('{sessions}', sessions.slice(0, 2).join(', '))
    : null;

  const idx = count ? ((shown.cur % count) + count) % count : 0;
  const current = count ? variants[idx] : undefined;
  const sentence = current?.summary ? emphasize(current.summary) : fallbackSentence;
  const suggestions = (current?.suggestions ?? []).slice(0, 3);
  if (!sentence && !cont.length && !suggestions.length) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo((idx + 1) % count); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo((idx - 1 + count) % count); }
  };

  // One variant layer: the sentence and the pill row, exactly the approved v3 shape. The outgoing
  // layer is stacked into the same grid cell so the box never changes size mid-fade — and it is inert
  // and aria-hidden, so nothing inside it can take focus or reach a reader mid-fade.
  const layer = (variant: DashRecapVariant | undefined, leaving: boolean) => {
    const line = variant?.summary ? emphasize(variant.summary) : fallbackSentence;
    const steps = (variant?.suggestions ?? []).slice(0, 3);
    return (
      <div
        className={`[grid-area:1/1] ${leaving ? 'recap-variant-out' : 'recap-variant-in'}`}
        {...(leaving ? { inert: true, 'aria-hidden': true } : {})}
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
    <section
      aria-label={t.dashboard.recap.label}
      className="mx-auto mt-10 w-full max-w-2xl text-center"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {/* The swap is silence on purpose: with no live region the reader hears the strip only when they
          navigate to it, never one variant after another read out over the timer. */}
      <div aria-live="off" className="grid">
        {current !== undefined && shown.prev !== null ? layer(variants[shown.prev % count], true) : null}
        {layer(current, false)}
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
          <span aria-hidden className="ml-1 text-xs tabular-nums text-muted-foreground">{`${idx + 1} / ${count}`}</span>
        </div>
      ) : null}
    </section>
  );
}