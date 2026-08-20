import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { elowenClient } from '../../lib/elowenClient';
import { fromHistory, prependHistory, type ChatView } from '../../lib/transcript';

export const HISTORY_PAGE = 50;

interface BrainChatHistoryOptions {
  getGeneration: () => number;
  getSession: () => string | undefined;
  setView: Dispatch<SetStateAction<ChatView>>;
}

interface BrainChatHistory {
  hasMoreHistory: boolean;
  loadHistory: (generation: number) => Promise<void>;
  loadOlder: () => Promise<void>;
  replaceWindow: (nextBefore: number | null, hasMore: boolean) => void;
  clearWindow: () => void;
}

export function useBrainChatHistory({ getGeneration, getSession, setView }: BrainChatHistoryOptions): BrainChatHistory {
  // Lazy-load history state: `hasMoreHistory` is reactive (drives the scroll-up sentinel); the cursor and
  // the in-flight guard are refs — they change across async fetches and must not each trigger a re-render.
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const historyCursorRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  // Bumped by EVERY transcript reset/refetch (loadHistory, idle-rollover, read-only). A loadOlder captures
  // it and discards its result if it changed while the fetch was in flight — the connect `generation` guard
  // alone is not enough, because compaction/model-switch/rollover refetch WITHOUT bumping the generation
  // (they keep the one SSE stream), which would otherwise let a stale older page tear a hole in the reset
  // transcript or double the rolled-over turns.
  const historyEpochRef = useRef(0);

  // The newest page bootstraps the transcript; older pages lazy-load on scroll-up. A full refetch (compaction
  // / model-switch markers) re-runs this, which correctly RESETS the lazy-load window to the tail — the
  // stored transcript changed, so any older cursor is stale.
  const loadHistory = async (generation: number): Promise<void> => {
    const epoch = ++historyEpochRef.current; // this reset invalidates any older page still in flight
    const page = await elowenClient.brainMessagesPage(getSession(), { limit: HISTORY_PAGE });
    if (generation !== getGeneration() || epoch !== historyEpochRef.current) return; // superseded — don't clobber
    // A refetch can land MID-TURN (an auto-compaction persists while the reply streams), and durable
    // history knows nothing about the running turn — so the refetch replaces the turns and leaves the
    // in-flight flag exactly where the stream put it.
    setView((cur) => ({ ...fromHistory(page.items), thinking: cur.thinking }));
    historyCursorRef.current = page.nextBefore;
    setHasMoreHistory(page.hasMore);
  };

  // Fetch the next older page and prepend it. Guarded against concurrent runs (a fast scroll fires scroll
  // events in bursts), a stale generation (session switch), AND a stale epoch (a compaction/rollover refetch
  // reset the transcript mid-fetch — those keep the generation, so the epoch is what discards this page
  // instead of tearing a hole in the reset transcript). `prependHistory` dedupes by id and leaves the live
  // streaming tail untouched, so a prepend mid-turn is safe.
  const loadOlder = async (): Promise<void> => {
    if (loadingOlderRef.current || historyCursorRef.current === null) return;
    loadingOlderRef.current = true;
    const generation = getGeneration();
    const epoch = historyEpochRef.current;
    const before = historyCursorRef.current;
    try {
      const page = await elowenClient.brainMessagesPage(getSession(), { limit: HISTORY_PAGE, before });
      if (generation !== getGeneration() || epoch !== historyEpochRef.current) return; // switch/reset superseded this
      setView((cur) => prependHistory(cur, page.items));
      historyCursorRef.current = page.nextBefore;
      setHasMoreHistory(page.hasMore);
    } finally {
      loadingOlderRef.current = false;
    }
  };

  const replaceWindow = (nextBefore: number | null, hasMore: boolean): void => {
    historyEpochRef.current++;
    historyCursorRef.current = nextBefore;
    setHasMoreHistory(hasMore);
  };

  const clearWindow = (): void => replaceWindow(null, false);

  return { hasMoreHistory, loadHistory, loadOlder, replaceWindow, clearWindow };
}
