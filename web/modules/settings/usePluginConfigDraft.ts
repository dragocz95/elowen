'use client';
import { useEffect, useRef, useState } from 'react';
import { useSavePluginConfig } from '../../lib/mutations';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import type { PluginConfigField, PluginDetail } from '../../lib/types';

/** Invalid JSON remains editable but makes the save fail visibly; claiming "Saved" while dropping
 *  that field would lose the user's draft on navigation. */
function sanitizeConfig(values: Record<string, unknown>, schema: PluginConfigField[]): Record<string, unknown> {
  const jsonKeys = new Set(schema.filter((field) => field.type === 'json').map((field) => field.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (jsonKeys.has(key) && typeof value === 'string' && value.trim() !== '') {
      try { JSON.parse(value); } catch { throw new Error(`Invalid JSON in ${key}`); }
    }
    out[key] = value;
  }
  return out;
}

export interface PluginConfigDraft {
  values: Record<string, unknown>;
  setValue: (key: string, value: unknown) => void;
  status: ReturnType<typeof useAutoSaveStatus>['status'];
  retry: () => void;
  flush: () => void;
  ready: boolean;
}

/** One draft shared by the schema form and live preview. Refetches after saving never re-seed the
 *  draft, preventing a slow query invalidation from overwriting a newer in-progress edit. */
export function usePluginConfigDraft(name: string, detail: PluginDetail): PluginConfigDraft {
  const save = useSavePluginConfig();
  const [values, setValues] = useState<Record<string, unknown>>(() => detail.config);
  const [seededName, setSeededName] = useState<string>(() => name);
  // Config PATCHes are full snapshots. Serialize them so a slow older response can never land after a
  // newer one and roll the server back while the UI reports the latest generation as saved.
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (seededName === name) return;
    setValues(detail.config);
    setSeededName(name);
  }, [detail.config, name, seededName]);

  const ready = seededName === name;
  const autosave = useAutoSaveStatus(
    [values],
    async () => {
      const snapshot = sanitizeConfig(values, detail.configSchema);
      const queued = saveChain.current
        .catch(() => undefined)
        .then(async () => { await save.mutateAsync({ name, values: snapshot }); });
      saveChain.current = queued;
      await queued;
    },
    { ready, delay: 900 },
  );

  return {
    values,
    setValue: (key, value) => setValues((current) => ({ ...current, [key]: value })),
    status: autosave.status,
    retry: autosave.retry,
    flush: autosave.flush,
    ready,
  };
}
