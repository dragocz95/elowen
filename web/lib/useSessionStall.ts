'use client';
import { useEffect, useRef, useState } from 'react';
import { useSessionPane } from './useSessionPane';

export type StallState = 'fresh' | 'stalled' | 'stuck';

export interface StallThresholds {
  /** Seconds of silence before the dot turns amber (stalled). Default 5 min. */
  stalledSec: number;
  /** Seconds of silence before the dot turns red (stuck). Default 15 min. */
  stuckSec: number;
}

export const DEFAULT_STALL_THRESHOLDS: StallThresholds = { stalledSec: 5 * 60, stuckSec: 15 * 60 };

/** Pure threshold->state mapping. Unit-testable without React.
 *  - `silenceSec` is seconds since the pane last produced new output (>= 0).
 *  - `live` is whether the session actually has a live tmux pane; a dead session reads as 'fresh'. */
export function stallState(silenceSec: number, live: boolean, thresholds: StallThresholds = DEFAULT_STALL_THRESHOLDS): StallState {
  if (!live) return 'fresh';
  const s = Math.max(0, silenceSec);
  if (s >= thresholds.stuckSec) return 'stuck';
  if (s >= thresholds.stalledSec) return 'stalled';
  return 'fresh';
}

/** Track how long a session's tmux pane has produced no new output.
 *  Reuses the existing 2s `useSessionPane` poll; whenever the captured tail text
 *  changes we reset the "last change" timestamp, then derive a stall state from
 *  the elapsed silence. Returns `fresh` for non-live sessions. */
export function useSessionStall(name: string, live: boolean, thresholds: StallThresholds = DEFAULT_STALL_THRESHOLDS): { state: StallState; silenceSec: number } {
  // Only poll while the session is live; a dead session reads as 'fresh' below anyway.
  const { tail } = useSessionPane(name, 8, live);
  const [now, setNow] = useState(() => Date.now());
  const lastChangeRef = useRef<number>(Date.now());

  // Reset the clock whenever the pane actually produces different content.
  useEffect(() => {
    lastChangeRef.current = Date.now();
  }, [tail]);

  // Tick once per second so the amber/red thresholds are reached in real time.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  if (!live) return { state: 'fresh', silenceSec: 0 };
  const silenceSec = Math.floor((now - lastChangeRef.current) / 1000);
  return { state: stallState(silenceSec, true, thresholds), silenceSec };
}