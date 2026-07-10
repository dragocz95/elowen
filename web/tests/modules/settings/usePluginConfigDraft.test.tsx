import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginConfigField, PluginDetail } from '../../../lib/types';

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/mutations', () => ({ useSavePluginConfig: () => ({ mutateAsync }) }));

import { usePluginConfigDraft } from '../../../modules/settings/usePluginConfigDraft';

function pluginDetail(configSchema: PluginConfigField[], config: Record<string, unknown>): PluginDetail {
  return {
    name: 'test-plugin', version: '1.0.0', description: 'test', source: 'user', enabled: true,
    configurable: true, provides: {}, configSchema, config, secretsSet: [],
    data: { path: '', exists: false, files: 0, bytes: 0 },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  mutateAsync.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('usePluginConfigDraft', () => {
  it('marks invalid JSON as an error and never claims the dropped value was persisted', async () => {
    mutateAsync.mockResolvedValue({ ok: true });
    const detail = pluginDetail([{ key: 'payload', label: 'Payload', type: 'json' }], { payload: '{}' });
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    act(() => result.current.setValue('payload', '{broken'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
  });

  it('serializes full-snapshot saves so an older response cannot overwrite the latest edit', async () => {
    const first = deferred();
    const second = deferred();
    mutateAsync.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const detail = pluginDetail([{ key: 'mode', label: 'Mode', type: 'string' }], { mode: 'a' });
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    act(() => result.current.setValue('mode', 'b'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ values: { mode: 'b' } });

    act(() => result.current.setValue('mode', 'c'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync.mock.calls[1]?.[0]).toMatchObject({ values: { mode: 'c' } });

    await act(async () => { second.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('saved');
  });
});
