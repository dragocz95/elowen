'use client';
import { useEffect, useState } from 'react';
import { BASE } from './orcaClient';

// Dedupe seam: identical idle frames must not churn React state (the backend
// resends full snapshots on an interval). Returns the previous reference when
// the next frame equals it, so setState is a no-op.
export function nextPane(prev: string, next: string): string {
  return prev === next ? prev : next;
}

export function useSessionStream(name: string): string {
  const [pane, setPane] = useState('');
  useEffect(() => {
    const es = new EventSource(`${BASE}/sessions/${encodeURIComponent(name)}/stream`);
    const onPane = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as { pane: string };
        setPane((prev) => nextPane(prev, parsed.pane));
      } catch { /* malformed frame — skip, keep the stream alive */ }
    };
    es.addEventListener('pane', onPane as EventListener);
    return () => es.close();
  }, [name]);
  return pane;
}
