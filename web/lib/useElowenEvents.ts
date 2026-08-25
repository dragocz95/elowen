'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from './queries';
import { BASE } from './elowenClient';
import { createReconnectController } from './reconnect';
import { subscribeRevive, STALE_HIDE_MS } from './useRevive';

/** Subscribe to the core daemon SSE bus and keep shared query caches fresh. */
export function useElowenEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;

    const makeHandler = (invalidate: () => void) => (event: MessageEvent) => {
      try { JSON.parse(event.data); } catch { return; }
      invalidate();
    };

    const memoryHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.memories });
      qc.invalidateQueries({ queryKey: ['memory-vitality'] });
    });
    const pluginsHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.pluginUi });
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['marketplace'] });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands });
    });
    const pluginHandler = makeHandler(() => {
      // Plugin data is intentionally opaque to core. Invalidate active queries so the owning bundle
      // refreshes without core learning its private query-key convention.
      qc.invalidateQueries();
    });
    const activityHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['activity-presence'] }); // someone started working
      qc.invalidateQueries({ queryKey: ['activity-pulse'] });
    });
    const authHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    });

    function connect(): void {
      es?.close();
      es = new EventSource(`${BASE}/events`, { withCredentials: true });
      es.onopen = () => {
        reconnect.succeeded();
        qc.invalidateQueries({ queryKey: QUERY_KEYS.memories });
        qc.invalidateQueries({ queryKey: QUERY_KEYS.pluginUi });
        qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands });
        qc.invalidateQueries({ queryKey: ['plugins'] });
        qc.invalidateQueries({ queryKey: ['activity'] });
        qc.invalidateQueries({ queryKey: ['activity-presence'] });
        qc.invalidateQueries({ queryKey: ['activity-pulse'] });
      };
      es.onerror = () => {
        if (!es || es.readyState !== EventSource.CLOSED) return;
        es.close();
        reconnect.retry();
      };
      es.addEventListener('memory', memoryHandler);
      es.addEventListener('plugin', pluginHandler);
      es.addEventListener('plugins', pluginsHandler);
      es.addEventListener('activity', activityHandler);
      es.addEventListener('auth', authHandler);
    }

    const reconnect = createReconnectController(connect);
    connect();
    const offRevive = subscribeRevive(({ hiddenMs }) => {
      if (es?.readyState === EventSource.OPEN && hiddenMs <= STALE_HIDE_MS) return;
      reconnect.now();
    });

    return () => { offRevive(); reconnect.stop(); es?.close(); };
  }, [qc]);
}
