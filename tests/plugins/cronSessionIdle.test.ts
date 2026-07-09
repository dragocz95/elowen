import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { SessionSource } from '../../src/plugins/api.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');

/** The cron adapter internals these tests drive directly (a manual tick, no timers) plus the resolved
 *  session-idle limit (see plugins/cronjob/elowen-plugin.json's "Scheduler" config section). */
interface CronAdapterUnderTest {
  listen(fn: (src: SessionSource, text: string, onEvent?: (e: { type: string; sessionId?: string }) => void) => Promise<string | undefined>): void;
  tick(): Promise<void>;
  sessionIdleMs: number | undefined;
}

function freshDataRoot(): string { return mkdtempSync(join(tmpdir(), 'elowen-pdata-')); }

async function loadCron(dataRoot: string, config?: Record<string, unknown>) {
  const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger: log, config: config ? { cronjob: config } : undefined });
  return reg.platforms[0] as unknown as CronAdapterUnderTest;
}

function writeJobs(dataRoot: string, jobs: Record<string, unknown>[]): void {
  mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
  writeFileSync(join(dataRoot, 'cronjob/jobs.json'), JSON.stringify(jobs));
}

const dueJob = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', name: 'report', schedule: 'every 15m', prompt: 'do it',
  lastRun: new Date(Date.now() - 20 * 60_000).toISOString(), createdAt: new Date().toISOString(), ...extra,
});

describe('cron session-idle threshold (fresh-session cache-cost knob)', () => {
  it('unset config leaves the override undefined — the host default (like Discord) applies', async () => {
    const adapter = await loadCron(freshDataRoot());
    expect(adapter.sessionIdleMs).toBeUndefined();
  });

  it('an unset override is OMITTED from access, so an existing job keeps its cross-run context', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob()]);
    const adapter = await loadCron(dataRoot); // no config → unset
    let seen: SessionSource | undefined;
    adapter.listen(async (src) => { seen = src; return 'ran'; });
    await adapter.tick();
    expect(seen?.access && 'sessionIdleMs' in seen.access).toBe(false);
  });

  it('explicit 0 disables rollover (Infinity) and forwards it, keeping the running context', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob()]);
    const adapter = await loadCron(dataRoot, { sessionIdleMs: 0 });
    expect(adapter.sessionIdleMs).toBe(Infinity);
    let seen: SessionSource | undefined;
    adapter.listen(async (src) => { seen = src; return 'ran'; });
    await adapter.tick();
    expect(seen?.access?.sessionIdleMs).toBe(Infinity);
  });

  it('clamps an explicit too-low value up to the 1-min floor', async () => {
    const low = await loadCron(freshDataRoot(), { sessionIdleMs: 1 });
    expect(low.sessionIdleMs).toBe(60_000);
  });

  it('does NOT upper-clamp — an operator can opt into a long keep-continuity window', async () => {
    const high = await loadCron(freshDataRoot(), { sessionIdleMs: 999_999_999 });
    expect(high.sessionIdleMs).toBe(999_999_999); // no upper cap
  });

  it('forwards an explicit threshold to the host as access.sessionIdleMs on every tick', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob()]);
    const adapter = await loadCron(dataRoot, { sessionIdleMs: 120_000 });
    let seen: SessionSource | undefined;
    adapter.listen(async (src) => { seen = src; return 'ran'; });
    await adapter.tick();
    expect(seen?.access?.sessionIdleMs).toBe(120_000);
  });
});
