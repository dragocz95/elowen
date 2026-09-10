'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from './queries';
import { BASE } from './elowenClient';
import { createReconnectController } from './reconnect';
import { subscribeRevive, STALE_HIDE_MS } from './useRevive';
import { emitPluginEvent, isPluginEvent } from './pluginEvents';
import { ENVIRONMENT_OPERATION_EVENT } from './useEnvironmentOperation';

/** Subscribe to the core daemon SSE bus and keep shared query caches fresh. */
export function useElowenEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let conversationsEs: EventSource | null = null;

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
    const pluginHandler = (event: MessageEvent) => {
      let parsed: unknown;
      try { parsed = JSON.parse(event.data); } catch { return; }
      // The payload goes to whoever is listening for it BEFORE any invalidation, so a surface that
      // follows a pushed operation reads the frame it was sent rather than refetching it.
      if (isPluginEvent(parsed)) emitPluginEvent(parsed);
      // A lifecycle operation publishes a frame per step — up to four a second while an image builds —
      // and every one of them used to refresh the WHOLE cache, which cost more than the poll the push
      // replaced. Such a frame names the project it belongs to, so it refreshes what names the same
      // project plus the project list, without core learning any bundle's private key convention.
      if (isPluginEvent(parsed) && parsed.kind === ENVIRONMENT_OPERATION_EVENT && typeof parsed.projectId === 'number') {
        const { projectId } = parsed;
        qc.invalidateQueries({ predicate: (query) => query.queryKey.includes(projectId) });
        qc.invalidateQueries({ queryKey: ['projects'] });
        return;
      }
      // Every other plugin's data is intentionally opaque to core: invalidate active queries so the
      // owning bundle refreshes whatever it keeps.
      qc.invalidateQueries();
    };
    const activityHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: ['activity'] });
      qc.invalidateQueries({ queryKey: ['activity-presence'] }); // someone started working
      qc.invalidateQueries({ queryKey: ['activity-pulse'] });
    });
    const authHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    });
    const conversationsHandler = makeHandler(() => {
      qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    });

    function connectConversations(): void {
      conversationsEs?.close();
      conversationsEs = new EventSource(`${BASE}/brain/conversations`, { withCredentials: true });
      conversationsEs.onopen = () => {
        conversationsReconnect.succeeded();
        qc.invalidateQueries({ queryKey: ['brain-sessions'] });
      };
      conversationsEs.onerror = () => {
        if (!conversationsEs || conversationsEs.readyState !== EventSource.CLOSED) return;
        conversationsEs.close();
        conversationsReconnect.retry();
      };
      conversationsEs.addEventListener('conversations', conversationsHandler);
    }

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
    const conversationsReconnect = createReconnectController(connectConversations);
    connect();
    connectConversations();
    const offRevive = subscribeRevive(({ hiddenMs }) => {
      if (!(es?.readyState === EventSource.OPEN && hiddenMs <= STALE_HIDE_MS)) reconnect.now();
      if (!(conversationsEs?.readyState === EventSource.OPEN && hiddenMs <= STALE_HIDE_MS)) conversationsReconnect.now();
    });

    return () => {
      offRevive();
      reconnect.stop();
      conversationsReconnect.stop();
      es?.close();
      conversationsEs?.close();
    };
  }, [qc]);
}
