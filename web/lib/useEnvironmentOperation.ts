'use client';
import { useEffect, useState } from 'react';
import type { EnvironmentOperation } from '../../src/shared/wireContract';
import { BASE } from './elowenClient';
import { subscribePluginEvents } from './pluginEvents';

/** The kind the sandbox plugin publishes one lifecycle operation's live state under. */
const ENVIRONMENT_OPERATION_EVENT = 'environment-operation';

export interface EnvironmentOperationView {
  operation: EnvironmentOperation | null;
  logTail: string[];
  /** True until the first frame arrives, whether from the seed read or from the bus. */
  loading: boolean;
  /** A transport failure of the seed read, not an operation that FAILED — that is `operation.error`. */
  loadError: string | null;
}

const EMPTY: EnvironmentOperationView = { operation: null, logTail: [], loading: true, loadError: null };

/** Follow one durable environment operation.
 *
 *  One read to seed, then the daemon pushes. The operation row carries its own declared step list and
 *  percent, and the plugin republishes the row on every step, so there is nothing left for a timer to
 *  discover — a dialog opened halfway through a fifteen-minute image build shows the same thing a dialog
 *  opened at the start does, and a dialog left open costs no requests at all.
 *
 *  `operationId` null simply parks the hook, which is what lets a call site mount it unconditionally and
 *  hand it an id when the user starts something. */
export function useEnvironmentOperation(operationId: string | null, projectId?: number): EnvironmentOperationView {
  const [view, setView] = useState<EnvironmentOperationView>(EMPTY);
  useEffect(() => {
    if (!operationId) { setView(EMPTY); return; }
    let live = true;
    setView(EMPTY);
    const query = new URLSearchParams({ operationId, ...(projectId === undefined ? {} : { projectId: String(projectId) }) });
    void (async () => {
      try {
        const response = await fetch(`${BASE}/plugins/sandbox/api/environments/operation?${query}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`operation read failed (${response.status})`);
        const body = await response.json() as (EnvironmentOperation & { logTail?: string[] }) | null;
        if (!live) return;
        // A frame that already arrived on the bus is NEWER than this read: the seed must not overwrite it.
        setView((current) => current.operation ? { ...current, loading: false }
          : { operation: body, logTail: body?.logTail ?? [], loading: false, loadError: null });
      } catch (error) {
        if (live) setView((current) => ({ ...current, loading: false, loadError: error instanceof Error ? error.message : String(error) }));
      }
    })();
    const off = subscribePluginEvents((event) => {
      if (!live || event.plugin !== 'sandbox' || event.kind !== ENVIRONMENT_OPERATION_EVENT) return;
      const payload = event.data as { operation?: EnvironmentOperation; logTail?: string[] } | undefined;
      if (!payload?.operation || payload.operation.id !== operationId) return;
      setView({ operation: payload.operation, logTail: payload.logTail ?? [], loading: false, loadError: null });
    });
    return () => { live = false; off(); };
  }, [operationId, projectId]);
  return view;
}
