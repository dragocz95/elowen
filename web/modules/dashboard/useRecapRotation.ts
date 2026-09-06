'use client';
import { useCallback, useEffect, useMemo, useState, type FocusEvent } from 'react';
import type { DashRecap, DashRecapVariant } from '../../lib/types';
import { useEffects } from '../../lib/useEffects';

const ROTATE_MS = 12_000;
const FADE_MS = 500;

/** One selection for the entire dashboard. Rotation never fetches or regenerates content. */
export function useRecapRotation(recap: DashRecap | undefined) {
  const { resolvedMode } = useEffects();
  const digest = recap?.enabled && recap.digest?.status === 'ready' ? recap.digest : undefined;
  const variants = useMemo<DashRecapVariant[]>(() => {
    if (!digest) return [];
    const batch = digest.recaps?.length ? digest.recaps : [digest];
    // Previously stored batches carried their hero only at the top level. Missing per-variant
    // fields inherit that hero, while explicitly empty fields remain empty.
    return batch.map((variant) => ({
      greeting: variant.greeting ?? digest.greeting,
      ask: variant.ask ?? digest.ask,
      pills: variant.pills ?? digest.pills,
      summary: variant.summary,
      suggestions: variant.suggestions,
    }));
  }, [digest]);
  const count = variants.length;
  const [shown, setShown] = useState<{ cur: number; prev: number | null }>({ cur: 0, prev: null });
  const [paused, setPaused] = useState(false);
  const [hoverHeld, setHoverHeld] = useState(false);
  const [focusHeld, setFocusHeld] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const crossfade = resolvedMode === 'full';

  useEffect(() => {
    const sync = () => setTabHidden(document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const goTo = useCallback((next: number) => {
    setShown((s) => (next === s.cur ? s : { cur: next, prev: crossfade ? s.cur : null }));
  }, [crossfade]);

  useEffect(() => {
    if (shown.prev === null) return;
    const timer = setTimeout(() => setShown((s) => ({ cur: s.cur, prev: null })), FADE_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  useEffect(() => {
    if (count < 2 || paused || hoverHeld || focusHeld || tabHidden || !crossfade) return;
    const timer = setInterval(() => {
      setShown((s) => ({ cur: (s.cur + 1) % count, prev: s.cur }));
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [count, paused, hoverHeld, focusHeld, tabHidden, crossfade]);

  const index = count ? ((shown.cur % count) + count) % count : 0;
  const leavingIndex = count && shown.prev !== null ? ((shown.prev % count) + count) % count : null;
  return {
    variants, index, leavingIndex, current: variants[index], paused, setPaused, goTo,
    // Hold the WHOLE hero, including its quick actions and composer, not just the lower strip.
    interactionProps: {
      onMouseEnter: () => setHoverHeld(true),
      onMouseLeave: () => setHoverHeld(false),
      onFocus: () => setFocusHeld(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusHeld(false);
      },
    },
  };
}
