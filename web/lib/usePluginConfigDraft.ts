'use client';
import { useEffect, useRef, useState } from 'react';
import { useSavePluginConfig } from './mutations';
import { useAutoSaveStatus } from './useAutoSaveStatus';
import type { PluginConfigField, PluginDetail } from './types';

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

export interface PluginConfigCommitResult {
  /** The values are durable, but the live plugin registry has not activated them yet. */
  pending: boolean;
}

export interface PluginConfigDraft {
  values: Record<string, unknown>;
  setValue: (key: string, value: unknown) => void;
  /** Persist one replacement immediately and publish it to the draft only after the save succeeds. */
  commitValue: (key: string, value: unknown) => Promise<PluginConfigCommitResult>;
  status: ReturnType<typeof useAutoSaveStatus>['status'];
  retry: () => void;
  flush: () => void;
  ready: boolean;
}

/** One draft shared by the schema form and live preview. Refetches after saving never re-seed the
 *  draft, preventing a slow query invalidation from overwriting a newer in-progress edit.
 *
 *  `save` overrides where the values go — the per-ACCOUNT form writes the caller's own row instead of
 *  the instance-wide config. Everything else (debounce, serialization, JSON validation) is identical,
 *  which is the point: the two forms must not drift into two behaviours. */
export function usePluginConfigDraft(
  name: string,
  detail: Pick<PluginDetail, 'config' | 'configSchema'>,
  options: { save?: (v: { name: string; values: Record<string, unknown> }) => Promise<unknown> } = {},
): PluginConfigDraft {
  const instanceSave = useSavePluginConfig();
  const save = { mutateAsync: options.save ?? ((v: { name: string; values: Record<string, unknown> }) => instanceSave.mutateAsync(v)) };
  const [values, setValues] = useState<Record<string, unknown>>(() => detail.config);
  const [seededName, setSeededName] = useState<string>(() => name);
  // Config PATCHes are full snapshots. Serialize them so a slow older response can never land after a
  // newer one and roll the server back while the UI reports the latest generation as saved.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  // An immediate confirmed write updates the draft only after the server accepts it. The resulting state
  // change still passes through the autosave effect; this identity lets that one redundant write be skipped.
  const committedValues = useRef<Record<string, unknown> | undefined>(undefined);

  useEffect(() => {
    if (seededName === name) return;
    setValues(detail.config);
    setSeededName(name);
  }, [detail.config, name, seededName]);

  const ready = seededName === name;
  const queueSave = (snapshot: Record<string, unknown>): Promise<unknown> => {
    const operation = saveChain.current.then(() => save.mutateAsync({ name, values: snapshot }));
    // Keep serialization alive after a rejected write without manufacturing an unhandled sibling promise.
    saveChain.current = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const autosave = useAutoSaveStatus(
    [values],
    async () => {
      const committed = committedValues.current;
      committedValues.current = undefined;
      if (committed === values) return;
      await queueSave(sanitizeConfig(values, detail.configSchema));
    },
    { ready, delay: 900 },
  );

  const commitValue = async (key: string, value: unknown): Promise<PluginConfigCommitResult> => {
    const base = values;
    // Finish any older debounced snapshot first. Otherwise its timer could enqueue the old list after
    // this confirmed deletion and resurrect the row on the server.
    autosave.flush();
    const next = { ...base, [key]: value };
    const response = await queueSave(sanitizeConfig(next, detail.configSchema));
    setValues((current) => {
      if (current === base) {
        committedValues.current = next;
        return next;
      }
      // Overlay isolation normally makes this impossible, but preserving a concurrent edit is safer than
      // replacing the whole draft. Its autosave will persist the merged snapshot next.
      return { ...current, [key]: value };
    });
    return {
      pending: typeof response === 'object' && response !== null && 'pending' in response && response.pending === true,
    };
  };

  return {
    values,
    setValue: (key, value) => setValues((current) => ({ ...current, [key]: value })),
    commitValue,
    status: autosave.status,
    retry: autosave.retry,
    flush: autosave.flush,
    ready,
  };
}
