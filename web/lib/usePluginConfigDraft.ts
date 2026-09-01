'use client';
import { useEffect, useRef, useState } from 'react';
import { useSavePluginConfig } from './mutations';
import { useAutoSaveStatus } from './useAutoSaveStatus';
import type { PluginConfigField, PluginDetail } from './types';

/** Invalid JSON remains editable but makes the save fail visibly; claiming "Saved" while dropping
 * that field would lose the user's draft on navigation. */
function sanitizeConfig(values: Record<string, unknown>, schema: PluginConfigField[], includeSecrets: ReadonlySet<string> = new Set(), validateJson = true): Record<string, unknown> {
  const jsonKeys = new Set(schema.filter((field) => field.type === 'json').map((field) => field.key));
  const secretKeys = new Set(schema.filter((field) => field.type === 'secret').map((field) => field.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (secretKeys.has(key) && !includeSecrets.has(key)) continue;
    if (validateJson && jsonKeys.has(key) && typeof value === 'string' && value.trim() !== '') {
      try { JSON.parse(value); } catch { throw new Error(`Invalid JSON in ${key}`); }
    }
    out[key] = value;
  }
  return out;
}

function sameSnapshot(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  retry: () => Promise<void>;
  flush: () => Promise<ReturnType<typeof useAutoSaveStatus>['status']>;
  ready: boolean;
}

/** One draft shared by the schema form and live preview. Refetches after saving never re-seed the
 * draft, preventing a slow query invalidation from overwriting a newer in-progress edit.
 *
 * Secret fields have an explicit commit boundary: `setValue` refuses to put them in the autosaved
 * snapshot, while `commitValue` sends one replacement and removes the plaintext from the local draft
 * after acceptance. Everything else keeps the debounced full-snapshot behavior. */
export function usePluginConfigDraft(
  name: string,
  detail: Pick<PluginDetail, 'config' | 'configSchema'>,
  options: { save?: (v: { name: string; values: Record<string, unknown> }) => Promise<unknown> } = {},
): PluginConfigDraft {
  const instanceSave = useSavePluginConfig();
  const save = options.save ?? ((v: { name: string; values: Record<string, unknown> }) => instanceSave.mutateAsync(v));
  const [values, setValues] = useState<Record<string, unknown>>(() => detail.config);
  const [seededName, setSeededName] = useState<string>(() => name);
  // Config PATCHes are full snapshots. Serialize them so a slow older response can never land after a
  // newer one and roll the server back while the UI reports the latest generation as saved.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const lastPersisted = useRef<Record<string, unknown>>(sanitizeConfig(detail.config, detail.configSchema, new Set(), false));

  useEffect(() => {
    if (seededName === name) return;
    setValues(detail.config);
    lastPersisted.current = sanitizeConfig(detail.config, detail.configSchema, new Set(), false);
    setSeededName(name);
  }, [detail.config, detail.configSchema, name, seededName]);

  const ready = seededName === name;
  const secretKeys = new Set(detail.configSchema.filter((field) => field.type === 'secret').map((field) => field.key));
  const queueSave = (snapshot: Record<string, unknown>): Promise<unknown> => {
    const operation = saveChain.current.then(() => save({ name, values: snapshot }));
    // Keep serialization alive after a rejected write without manufacturing an unhandled sibling promise.
    saveChain.current = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const autosave = useAutoSaveStatus(
    [values],
    async () => {
      const snapshot = sanitizeConfig(values, detail.configSchema);
      // Secret-only edits (including an accidental direct caller) do not create a no-op request or a false
      // "Saved" state. The editor keeps replacement text outside this draft until commitValue is called.
      if (sameSnapshot(snapshot, lastPersisted.current)) return;
      const response = await queueSave(snapshot);
      lastPersisted.current = snapshot;
      return response;
    },
    { ready, delay: 900 },
  );

  const commitValue = async (key: string, value: unknown): Promise<PluginConfigCommitResult> => {
    const base = values;
    // Finish any older debounced snapshot first. Otherwise its timer could enqueue the old list after
    // this confirmed deletion and resurrect the row on the server.
    await autosave.flush();
    const isSecret = secretKeys.has(key);
    const next = { ...base, [key]: value };
    const snapshot = sanitizeConfig(next, detail.configSchema, isSecret ? new Set([key]) : new Set());
    const response = await queueSave(snapshot);
    lastPersisted.current = sanitizeConfig(next, detail.configSchema);
    setValues((current) => {
      if (isSecret) {
        const sanitized = { ...current };
        delete sanitized[key];
        return sanitized;
      }
      if (current === base) return next;
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
    // Secret values belong to the explicit replacement UI, never to the generic draft controller.
    setValue: (key, value) => { if (!secretKeys.has(key)) setValues((current) => ({ ...current, [key]: value })); },
    commitValue,
    status: autosave.status,
    retry: autosave.retry,
    flush: autosave.flush,
    ready,
  };
}
