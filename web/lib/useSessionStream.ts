'use client';
import { useEffect, useState } from 'react';
import { BASE } from './orcaClient';
import { withToken } from './token';

// Dedupe seam: identical idle frames must not churn React state (the backend
// resends full snapshots on an interval). Returns the previous reference when
// the next frame equals it, so setState is a no-op.
export function nextPane(prev: string, next: string): string {
  return prev === next ? prev : next;
}

export function useSessionStream(name: string): string {
  const [pane, setPane] = useState('');
  useEffect(() => {
    const es = new EventSource(withToken(`${BASE}/sessions/${encodeURIComponent(name)}/stream`));
    const onPane = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as { pane: string };
        setPane((prev) => nextPane(prev, parsed.pane));
      } catch { /* malformed frame — skip, keep the stream alive */ }
    };
    es.addEventListener('pane', onPane as EventListener);
    // On a terminal failure (readyState CLOSED) just stop — do NOT clear the auth token here. The
    // EventSource API can't distinguish a 401 from a benign drop (proxy/SSE timeout, daemon restart,
    // hard-reload race), so clearing it would log the user out spuriously. Real auth expiry is
    // handled by the regular request path; this only avoids a retry storm against a dead endpoint.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) es.close();
    };
    return () => es.close();
  }, [name]);
  return pane;
}
