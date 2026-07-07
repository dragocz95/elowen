import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { SessionSource } from '../../src/plugins/api.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const OWNER: TurnIdentity = { platform: 'orca', userId: '1', orcaUserId: 1, admin: true, owner: true };
const asText = (r: { content: { text?: string }[] }) => (r.content[0] as { text: string }).text;

function freshDataRoot(): string { return mkdtempSync(join(tmpdir(), 'orca-pdata-')); }

/** The cron adapter's internals the tests drive directly (listen + a manual tick, no timers). */
interface CronAdapterUnderTest {
  listen(fn: (src: SessionSource, text: string, onEvent?: (e: { type: string; sessionId?: string }) => void) => Promise<string | undefined>): void;
  tick(): Promise<void>;
}

async function loadCron(dataRoot: string, notify?: (text: string, channelId?: string) => Promise<void>) {
  const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger: log, notify });
  return { reg, adapter: reg.platforms[0] as unknown as CronAdapterUnderTest };
}

const jobsFile = (dataRoot: string) => join(dataRoot, 'cronjob/jobs.json');

describe('schedule_wakeup origin capture', () => {
  it('records the originating USER conversation (session + orca user) and says so in the ok message', async () => {
    const dataRoot = freshDataRoot();
    const { reg } = await loadCron(dataRoot);
    const wakeup = reg.tools.find((t) => t.name === 'schedule_wakeup')!;
    const text = await runWithPolicy(ADMIN, async () =>
      asText(await wakeup.execute('t', { name: 'ping', when: 'in 30s', prompt: 'say hi' }, undefined as never, undefined as never)),
    { identity: OWNER, sessionId: 'brain-1-abc' });
    expect(text).toMatch(/Wake-up "ping" set for \d{4}-\d{2}-\d{2}T/); // ISO time kept
    expect(text).toContain('It will reply in this conversation.');
    const jobs = JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8')) as Record<string, unknown>[];
    expect(jobs[0]).toMatchObject({ originSessionId: 'brain-1-abc', originUserId: 1 });
  });

  it('keeps NO origin for channel/task-originated schedules and for turns without an Orca account', async () => {
    const dataRoot = freshDataRoot();
    const { reg } = await loadCron(dataRoot);
    const wakeup = reg.tools.find((t) => t.name === 'schedule_wakeup')!;
    // A cron/channel session (brain-ch-…) must not bind — today's notify-channel behavior stays.
    await runWithPolicy(ADMIN, async () => {
      await wakeup.execute('t', { name: 'ch', when: 'in 30s', prompt: 'p' }, undefined as never, undefined as never);
    }, { identity: OWNER, sessionId: 'brain-ch-cron-job-x' });
    // No orcaUserId (unlinked automation) → no origin either.
    const noAccount = await runWithPolicy(ADMIN, async () =>
      asText(await wakeup.execute('t', { name: 'anon', when: 'in 30s', prompt: 'p' }, undefined as never, undefined as never)),
    { identity: { platform: 'cron', userId: 'cron', admin: true, owner: true }, sessionId: 'brain-1' });
    expect(noAccount).not.toContain('reply in this conversation');
    const jobs = JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8')) as Record<string, unknown>[];
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.originSessionId).toBeUndefined();
      expect(j.originUserId).toBeUndefined();
    }
  });
});

describe('cron tick — origin-bound wake-up routing', () => {
  const dueWakeup = (extra: Record<string, unknown>) => ({
    id: 'j1', name: 'ping', schedule: 'in 30s', prompt: 'say hi',
    runAt: new Date(Date.now() - 1_000).toISOString(), createdAt: new Date().toISOString(), ...extra,
  });

  function writeJobs(dataRoot: string, jobs: Record<string, unknown>[]): void {
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(jobsFile(dataRoot), JSON.stringify(jobs));
  }

  it('hands the job origin to the handler and SKIPS the notify echo when the reply landed in the origin conversation', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueWakeup({ originSessionId: 'brain-1-abc', originUserId: 1 })]);
    const { adapter } = await loadCron(dataRoot, async (t) => { delivered.push(t); });
    let seenSrc: SessionSource | undefined;
    let seenText = '';
    adapter.listen(async (src, text, onEvent) => {
      seenSrc = src; seenText = text;
      onEvent?.({ type: 'session', sessionId: 'brain-1-abc' }); // host confirms the bound-send route
      return 'done, replied in the conversation';
    });
    await adapter.tick();
    expect(seenSrc?.origin).toEqual({ sessionId: 'brain-1-abc', userId: 1 });
    expect(seenText).toContain('Scheduled wake-up "ping" fires now'); // framed as the schedule firing, not the user speaking
    expect(seenText).toContain('say hi');
    expect(delivered).toEqual([]); // the conversation IS the delivery — no Discord echo
    expect(JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8'))).toEqual([]); // one-shot: done → gone
  });

  it('falls back to the notify echo when the host ran the job in its own channel session (origin gone)', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueWakeup({ originSessionId: 'brain-1-gone', originUserId: 1 })]);
    const { adapter } = await loadCron(dataRoot, async (t) => { delivered.push(t); });
    adapter.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-cron-job-j1' }); // channel fallback ran instead
      return 'fallback reply';
    });
    await adapter.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('fallback reply');
  });

  it('a wake-up WITHOUT origin keeps today\'s behavior: no src.origin, notify echo delivered', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueWakeup({})]);
    const { adapter } = await loadCron(dataRoot, async (t) => { delivered.push(t); });
    let seenSrc: SessionSource | undefined;
    let seenText = '';
    adapter.listen(async (src, text) => { seenSrc = src; seenText = text; return 'plain reply'; });
    await adapter.tick();
    expect(seenSrc?.origin).toBeUndefined();
    expect(seenText).toBe('say hi'); // no wake-up framing without an origin conversation
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('plain reply');
  });
});
