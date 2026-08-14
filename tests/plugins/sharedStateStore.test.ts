import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
// @ts-expect-error — plain .mjs plugin module, no types
import { StateStore } from '../../packages/plugin-shared/stateStore.mjs';

let dirs: string[] = [];
function freshDir(): string { const p = mkdtempSync(join(tmpdir(), 'elowen-statestore-')); dirs.push(p); return p; }
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });
function fakeLogger() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }

describe('StateStore', () => {
  it('patch() persists atomically and get() reflects it', () => {
    const dir = freshDir();
    const file = join(dir, 'channel-state.json');
    const store = new StateStore(file, fakeLogger());
    store.patch('chan-1', { model: { provider: 'openai', model: 'gpt-5' } });
    expect(store.get('chan-1')).toEqual({ model: { provider: 'openai', model: 'gpt-5' } });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ 'chan-1': { model: { provider: 'openai', model: 'gpt-5' } } });
  });

  it('a corrupt state file is reported to the logger, not silently treated as empty', () => {
    const dir = freshDir();
    const file = join(dir, 'channel-state.json');
    writeFileSync(file, '{not json at all');
    const logger = fakeLogger();
    const store = new StateStore(file, logger);
    expect(store.get('chan-1')).toEqual({}); // still usable — corruption isn't fatal to the command
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toMatch(/corrupt/i);
  });

  it('a failed write THROWS instead of reporting success while the change vanishes on restart', () => {
    const dir = freshDir();
    const file = join(dir, 'channel-state.json');
    const logger = fakeLogger();
    const store = new StateStore(file, logger);
    store.patch('chan-1', { voice: true }); // one good write on disk first
    const before = readFileSync(file, 'utf-8');
    const originalMode = statSync(dir).mode;
    chmodSync(dir, 0o500); // no write permission → the next patch cannot persist
    try {
      expect(() => store.patch('chan-1', { voice: false })).toThrow();
    } finally {
      chmodSync(dir, originalMode);
    }
    expect(logger.error).toHaveBeenCalled();
    // Neither the file NOR the in-memory view moved on — a caller checking get() after the throw does
    // not see a change that never actually stuck (matches "the setting did not stick").
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(store.get('chan-1')).toEqual({ voice: true });
  });

  it('a write failure does not corrupt the file for the NEXT (successful) write', () => {
    const dir = freshDir();
    const file = join(dir, 'channel-state.json');
    const store = new StateStore(file, fakeLogger());
    store.patch('chan-1', { voice: true });
    const originalMode = statSync(dir).mode;
    chmodSync(dir, 0o500);
    try {
      expect(() => store.patch('chan-1', { voice: false })).toThrow();
    } finally {
      chmodSync(dir, originalMode);
    }
    store.patch('chan-1', { thinkingLevel: 'high' }); // a later write, once permissions are restored, still works
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ 'chan-1': { voice: true, thinkingLevel: 'high' } });
  });
});
