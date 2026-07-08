import { describe, it, expect, vi } from 'vitest';
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

  it('still echoes a FAILED origin-bound wake-up (reply "Error: …") so a crash after the session event is never lost', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueWakeup({ originSessionId: 'brain-1-abc', originUserId: 1 })]);
    const { adapter } = await loadCron(dataRoot, async (t) => { delivered.push(t); });
    adapter.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-1-abc' }); // bound-send route confirmed…
      throw new Error('turn blew up after the session event'); // …but the turn then failed, maybe with no client attached
    });
    await adapter.tick();
    // deliveredTo matched the origin, yet the reply is an error → the notify echo is NOT skipped.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('Error: turn blew up after the session event');
    expect(JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8'))).toEqual([]); // one-shot still consumed
  });
});

describe('cron tick — one-shot lifecycle (consume before run)', () => {
  const dueWakeup = (extra: Record<string, unknown>) => ({
    id: 'j1', name: 'ping', schedule: 'in 30s', prompt: 'say hi',
    runAt: new Date(Date.now() - 1_000).toISOString(), createdAt: new Date().toISOString(), ...extra,
  });
  function writeJobs(dataRoot: string, jobs: Record<string, unknown>[]): void {
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(jobsFile(dataRoot), JSON.stringify(jobs));
  }

  it('consumes a one-shot BEFORE running: a crash mid-turn leaves no zombie (not re-fired, not lingering)', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueWakeup({})]);
    const { adapter } = await loadCron(dataRoot, async () => {});
    let jobsWhileRunning: unknown[] = [{ marker: true }];
    adapter.listen(async () => {
      jobsWhileRunning = JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8')); // read at "mid-turn"
      throw new Error('daemon crashed mid-turn');
    });
    await adapter.tick();
    // The job was already deleted before the (crashing) turn — deletion IS the dedup.
    expect(jobsWhileRunning).toEqual([]);
    // After the crash the job is gone: it can't re-fire and doesn't linger in jobs.json.
    expect(JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8'))).toEqual([]);
    let fired = false;
    adapter.listen(async () => { fired = true; return 'x'; });
    await adapter.tick();
    expect(fired).toBe(false);
  });

  it('a recurring (interval) job is NOT consumed: it stamps lastRun, records lastResult, and survives', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [{ id: 'r1', name: 'poll', schedule: 'every 15m', prompt: 'check', createdAt: new Date().toISOString() }]);
    const { adapter } = await loadCron(dataRoot, async () => {});
    adapter.listen(async () => 'ran');
    await adapter.tick();
    const jobs = JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8')) as Record<string, unknown>[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lastRun).toBeTruthy();
    expect(jobs[0].lastResult).toBe('ran');
  });
});

describe('cron tick — reliability (re-entrancy guard + bounded retry)', () => {
  // A recurring job that is due right now (last run 10 min ago on a 5-min interval), no `check` guard,
  // so the tick goes straight to the brain turn — the shape of the morning report jobs.
  const dueJob = (extra: Record<string, unknown> = {}) => ({
    id: 'r1', name: 'report', schedule: 'every 5m', prompt: 'do it',
    lastRun: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: new Date().toISOString(), ...extra,
  });
  function writeJobs(dataRoot: string, jobs: Record<string, unknown>[]): void {
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(jobsFile(dataRoot), JSON.stringify(jobs));
  }

  it('runs one tick at a time — a second tick while the first is in flight is a no-op', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob()]);
    const { adapter } = await loadCron(dataRoot, async () => {});
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    adapter.listen(async () => { calls++; await gate; return 'ok'; });
    const first = adapter.tick(); // starts; the handler is invoked and parks on the gate
    await Promise.resolve();
    await adapter.tick(); // second tick overlaps — the guard makes it a no-op
    expect(calls).toBe(1); // the job did NOT double-fire
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('retries a request-time failure that produced no output, then delivers the recovered reply', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueJob()]);
    const { adapter } = await loadCron(dataRoot, async (t) => { delivered.push(t); });
    let calls = 0;
    adapter.listen(async () => {
      calls++;
      if (calls === 1) throw new Error('400 "Bad Request (ref: abc)"'); // transient relay blip, nothing ran
      return 'recovered report';
    });
    vi.useFakeTimers();
    try {
      const p = adapter.tick();
      await vi.advanceTimersByTimeAsync(3_000); // clear the retry backoff
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(2); // one retry
    expect(delivered.some((d) => d.includes('recovered report'))).toBe(true);
    expect(delivered.some((d) => d.includes('Bad Request'))).toBe(false); // the transient error never reached the user
  });

  it('does NOT retry once the turn has done work — delivers the error instead of repeating side effects', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueJob()]);
    const { adapter } = await loadCron(dataRoot, async (t) => { delivered.push(t); });
    let calls = 0;
    adapter.listen(async (_src, _text, onEvent) => {
      calls++;
      onEvent?.({ type: 'tool' } as { type: string }); // the turn already ran a tool (a side effect)...
      throw new Error('500 upstream blip'); // ...then failed — retrying would repeat the side effect
    });
    await adapter.tick();
    expect(calls).toBe(1); // no retry
    expect(delivered.some((d) => d.includes('Error: 500 upstream blip'))).toBe(true);
  });

  it('gives up after the retry budget and delivers the error', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueJob()]);
    const { adapter } = await loadCron(dataRoot, async (t) => { delivered.push(t); });
    let calls = 0;
    adapter.listen(async () => { calls++; throw new Error('400 persistent'); });
    vi.useFakeTimers();
    try {
      const p = adapter.tick();
      await vi.advanceTimersByTimeAsync(3_000);
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(2); // initial + one retry, then give up
    expect(delivered.some((d) => d.includes('Error: 400 persistent'))).toBe(true);
  });
});
