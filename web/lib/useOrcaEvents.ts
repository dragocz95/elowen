'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from './queries';
import { BASE } from './orcaClient';
import type { OrcaEvent } from './types';

export function useOrcaEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource(`${BASE}/events`);
    es.onmessage = (e) => {
      let ev: OrcaEvent;
      try { ev = JSON.parse(e.data) as OrcaEvent; } catch { return; } // skip malformed, keep the stream alive
      if (ev.type === 'task') qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks });
      else if (ev.type === 'mission') qc.invalidateQueries({ queryKey: QUERY_KEYS.missions });
      else if (ev.type === 'signal') qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions });
    };
    return () => es.close();
  }, [qc]);
}
