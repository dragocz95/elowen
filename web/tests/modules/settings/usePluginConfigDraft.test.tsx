import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElowenApiError } from '../../../lib/elowenClient';
import type { PluginConfigField, PluginDetail } from '../../../lib/types';

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/mutations', () => ({ useSavePluginConfig: () => ({ mutateAsync }) }));

import { usePluginConfigDraft } from '../../../lib/usePluginConfigDraft';

function pluginDetail(configSchema: PluginConfigField[], config: Record<string, unknown>, secretsSet: string[] = [], revision?: number): PluginDetail {
  return {
    name: 'test-plugin', version: '1.0.0', description: 'test', source: 'user', enabled: true,
    configurable: true, provides: {}, configSchema, config, secretsSet,
    ...(revision === undefined ? {} : { revision }),
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

  it('does not submit an untouched stored secret as an empty value', async () => {
    mutateAsync.mockResolvedValue({ ok: true });
    const detail = pluginDetail([
      { key: 'token', label: 'Token', type: 'secret' },
      { key: 'mode', label: 'Mode', type: 'string' },
    ], { mode: 'a' }, ['token']);
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    act(() => result.current.setValue('mode', 'b'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });

    expect(mutateAsync).toHaveBeenCalledWith({ name: 'test-plugin', values: { mode: 'b' } });
  });

  it('never autosaves a secret replacement and only sends it through explicit commitValue', async () => {
    mutateAsync.mockResolvedValue({ ok: true });
    const detail = pluginDetail([{ key: 'token', label: 'Token', type: 'secret' }], {}, ['token']);
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    act(() => result.current.setValue('token', 'typed-secret'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(mutateAsync).not.toHaveBeenCalled();

    await act(async () => { await result.current.commitValue('token', 'typed-secret'); });
    expect(mutateAsync).toHaveBeenCalledWith({ name: 'test-plugin', values: { token: 'typed-secret' } });
    expect(result.current.values).not.toHaveProperty('token');
  });

  it('sends the expected revision and adopts the canonical response', async () => {
    mutateAsync.mockResolvedValue({ ok: true, revision: 8, config: { mode: 'b' }, secretsSet: [] });
    const detail = pluginDetail([{ key: 'mode', label: 'Mode', type: 'string' }], { mode: 'a' }, [], 7);
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    act(() => result.current.setValue('mode', 'b'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });

    expect(mutateAsync).toHaveBeenCalledWith({ name: 'test-plugin', values: { mode: 'b' }, expectedRevision: 7 });
    expect(result.current.values).toEqual({ mode: 'b' });
    expect(result.current.errorKind).toBeNull();
  });

  it('classifies a revision conflict, keeps the draft, and retries with the canonical revision', async () => {
    mutateAsync
      .mockRejectedValueOnce(new ElowenApiError('conflict', 409, 'conflict', { current: { config: { mode: 'server' }, secretsSet: [], revision: 8 } }))
      .mockResolvedValueOnce({ ok: true, revision: 9, config: { mode: 'b' }, secretsSet: [] });
    const detail = pluginDetail([{ key: 'mode', label: 'Mode', type: 'string' }], { mode: 'a' }, [], 7);
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    act(() => result.current.setValue('mode', 'b'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });

    expect(result.current.values).toEqual({ mode: 'b' });
    expect(result.current.status).toBe('error');
    expect(result.current.errorKind).toBe('conflict');

    await act(async () => { await result.current.retry(); });
    expect(mutateAsync).toHaveBeenLastCalledWith({ name: 'test-plugin', values: { mode: 'b' }, expectedRevision: 8 });
    expect(result.current.status).toBe('saved');
    expect(result.current.errorKind).toBeNull();
  });

  it('offers reload and merge choices without blindly retrying a conflict', async () => {
    mutateAsync.mockRejectedValueOnce(new ElowenApiError('conflict', 409, 'conflict', { current: { config: { mode: 'server', other: true }, secretsSet: [], revision: 4 } }));
    const detail = pluginDetail([{ key: 'mode', label: 'Mode', type: 'string' }], { mode: 'old' }, [], 3);
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));
    act(() => result.current.setValue('mode', 'local'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(result.current.errorKind).toBe('conflict');
    act(() => result.current.resolveConflict('merge'));
    expect(result.current.values).toEqual({ mode: 'local', other: true });
    expect(result.current.status).toBe('idle');
    expect(result.current.errorKind).toBeNull();
  });

  it('publishes an immediate confirmed value only after the server accepts it', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('save failed'));
    const detail = pluginDetail([{ key: 'roles', label: 'Roles', type: 'rolePolicies' }], { roles: [{ roleId: 'support' }] });
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    await act(async () => {
      await expect(result.current.commitValue('roles', [])).rejects.toThrow('save failed');
    });

    expect(result.current.values.roles).toEqual([{ roleId: 'support' }]);
    expect(mutateAsync).toHaveBeenCalledWith({ name: 'test-plugin', values: { roles: [] } });
  });

  it('commits a persisted value and reports delayed activation', async () => {
    mutateAsync.mockResolvedValueOnce({ ok: true, pending: true });
    const detail = pluginDetail([{ key: 'roles', label: 'Roles', type: 'rolePolicies' }], { roles: [{ roleId: 'support' }] });
    const { result } = renderHook(() => usePluginConfigDraft('test-plugin', detail));

    let outcome: { pending: boolean } | undefined;
    await act(async () => { outcome = await result.current.commitValue('roles', []); });

    expect(outcome).toEqual({ pending: true });
    expect(result.current.values.roles).toEqual([]);
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
