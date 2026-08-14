import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { SessionSource, PluginHostWiring } from '../../src/plugins/api.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const LIMITED: Policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [] };
const AMY: TurnIdentity = { platform: 'elowen', userId: '4', elowenUserId: 4, admin: false, owner: false };
const asText = (r: { content: { text?: string }[] }) => (r.content[0] as { text: string }).text;

let dirs: string[] = [];
const freshDataRoot = (): string => { const p = mkdtempSync(join(tmpdir(), 'elowen-cron-owned-')); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

interface CronAdapterUnderTest {
  listen(fn: (src: SessionSource, text: string, onEvent?: (e: { type: string; sessionId?: string }) => void) => Promise<string | undefined>): void;
  tick(): Promise<void>;
}

/** The plugin reads the account view through `ctx.host.stores().usersRead`: `isAdmin` decides whether a
 *  job's shell guard may run, `mayUsePlugin` whether its owner may still schedule at all. */
const hostWith = (admins: number[], scheduling: { denied?: number[]; accounts?: number[] } = {}): PluginHostWiring => ({
  stores: {
    usersRead: {
      isAdmin: (id: number) => admins.includes(id),
      mayUsePlugin: (id: number) => !(scheduling.denied ?? []).includes(id),
      list: () => (scheduling.accounts ?? [4, 7, 9]).map((id) => ({ id })),
    },
  },
} as unknown as PluginHostWiring);

async function loadCron(dataRoot: string, opts: { admins?: number[]; notify?: (t: string, c?: string) => Promise<void>; host?: PluginHostWiring | null } = {}) {
  const reg = await loadPlugins({
    dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger: log, notify: opts.notify,
    host: opts.host === null ? undefined : opts.host ?? hostWith(opts.admins ?? []),
  });
  return { reg, adapter: reg.platforms[0] as unknown as CronAdapterUnderTest };
}

const jobsFile = (dataRoot: string) => join(dataRoot, 'cronjob/jobs.json');
function writeJobs(dataRoot: string, jobs: Record<string, unknown>[]): void {
  mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
  writeFileSync(jobsFile(dataRoot), JSON.stringify(jobs));
}
const readJobs = (dataRoot: string) => JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8')) as Record<string, unknown>[];
/** A recurring job that is due right now (last run 10 min ago on a 5-min interval). */
const dueJob = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', name: 'report', schedule: 'every 5m', prompt: 'do it',
  lastRun: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: new Date().toISOString(), ...extra,
});

describe('cron tick — a job that belongs to an account', () => {
  it('runs AS its owner and reports into that account\'s own conversation, never the notification channel', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueJob({ ownerUserId: 4 })]);
    const { adapter } = await loadCron(dataRoot, { notify: async (t) => { delivered.push(t); } });
    let seen: SessionSource | undefined;
    let seenText = '';
    adapter.listen(async (src, text, onEvent) => {
      seen = src; seenText = text;
      onEvent?.({ type: 'session', sessionId: 'brain-4' }); // the host resolved the owner's own conversation
      return 'her report';
    });
    await adapter.tick();

    // No admin powers, and the account is named so the host applies THAT account's policy and tool rules.
    expect(seen?.access?.admin).toBe(false);
    expect(seen?.access?.actAsUserId).toBe(4);
    // No session named: the host routes it into the owner's default conversation.
    expect(seen?.origin).toEqual({ userId: 4 });
    expect(seenText).toContain('Scheduled job "report" fires now');
    expect(delivered).toEqual([]); // the operator's channel never sees somebody else's result
    expect(readJobs(dataRoot)[0]!.lastResult).toBe('her report');
  });

  it('keeps an instance job on exactly the old path: admin powers and the notification channel', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueJob()]);
    const { adapter } = await loadCron(dataRoot, { notify: async (t) => { delivered.push(t); } });
    let seen: SessionSource | undefined;
    let seenText = '';
    adapter.listen(async (src, text) => { seen = src; seenText = text; return 'the report'; });
    await adapter.tick();

    expect(seen?.access?.admin).toBe(true);
    expect(seen?.access).not.toHaveProperty('actAsUserId');
    expect(seen?.origin).toBeUndefined();
    expect(seenText).toBe('do it'); // no bound-run framing without a conversation to replay into
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('the report');
  });

  it('does not echo an owned job whose bound delivery never landed — it records the outcome instead', async () => {
    const dataRoot = freshDataRoot();
    const delivered: string[] = [];
    writeJobs(dataRoot, [dueJob({ ownerUserId: 4 })]);
    const { adapter } = await loadCron(dataRoot, { notify: async (t) => { delivered.push(t); } });
    // The host fell back to the job's own channel session (the owner has no conversation yet).
    adapter.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-cron-job-r1' });
      return 'unreachable report';
    });
    await adapter.tick();

    expect(delivered).toEqual([]);
    expect(readJobs(dataRoot)[0]!.lastResult).toBe('unreachable report');
  });
});

describe('cron tick — scheduling itself is re-authorised at every fire', () => {
  it('skips an owned job once its owner loses the grant, and runs it again when it comes back', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob({ ownerUserId: 4 })]);
    let denied = [4];
    const { adapter } = await loadCron(dataRoot, {
      host: { stores: { usersRead: { isAdmin: () => false, mayUsePlugin: (id: number) => !denied.includes(id) } } } as unknown as PluginHostWiring,
    });
    let turns = 0;
    adapter.listen(async () => { turns += 1; return 'done'; });

    await adapter.tick();
    // Revoking the grant is the one lever an operator reaches for to stop somebody's automation. If the
    // schedule kept firing anyway it would keep spending model budget as that person, with nothing shown.
    expect(turns).toBe(0);
    expect(String(readJobs(dataRoot)[0]!.lastResult)).toContain('no longer allowed');

    // Skipped, never deleted: the schedule comes back untouched.
    denied = [];
    writeJobs(dataRoot, [dueJob({ ownerUserId: 4 })]);
    await adapter.tick();
    expect(turns).toBe(1);
  });

  it('keeps firing an INSTANCE job, which has no owner whose grant could be revoked', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob()]);
    const { adapter } = await loadCron(dataRoot, {
      host: { stores: { usersRead: { isAdmin: () => true, mayUsePlugin: () => false } } } as unknown as PluginHostWiring,
    });
    let turns = 0;
    adapter.listen(async () => { turns += 1; return 'done'; });
    await adapter.tick();
    expect(turns).toBe(1);
  });

  it('fails CLOSED when the host cannot answer whether the owner may still schedule', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob({ ownerUserId: 4 })]);
    const { adapter } = await loadCron(dataRoot, { host: null });
    let turns = 0;
    adapter.listen(async () => { turns += 1; return 'done'; });
    await adapter.tick();
    // Unattended automation running for an account nobody can vouch for is exactly what must not happen.
    expect(turns).toBe(0);
  });
});

describe('cron tick — the shell guard is re-authorised at every fire', () => {
  const guarded = (extra: Record<string, unknown>) => dueJob({ check: 'echo something-new', ...extra });

  it('runs the guard for an instance job and for an admin owner', async () => {
    for (const job of [guarded({}), guarded({ ownerUserId: 4 })]) {
      const dataRoot = freshDataRoot();
      writeJobs(dataRoot, [job]);
      const { adapter } = await loadCron(dataRoot, { admins: [4], notify: async () => {} });
      let seenText = '';
      adapter.listen(async (_src, text) => { seenText = text; return 'ok'; });
      await adapter.tick();
      expect(seenText, JSON.stringify(job.ownerUserId)).toContain('something-new');
    }
  });

  it('skips a job whose owner is no longer an admin, without running the shell command', async () => {
    const dataRoot = freshDataRoot();
    // The guard would create this file if it ran; it must not.
    const marker = join(dataRoot, 'guard-ran');
    writeJobs(dataRoot, [dueJob({ ownerUserId: 4, check: `touch ${marker} && echo new` })]);
    const { adapter } = await loadCron(dataRoot, { admins: [] }); // demoted since the job was written
    let ran = false;
    adapter.listen(async () => { ran = true; return 'ok'; });
    await adapter.tick();

    expect(ran).toBe(false);
    expect(readJobs(dataRoot)[0]!.lastResult).toMatch(/admin-owned/);
    expect(() => readFileSync(marker)).toThrow(); // the shell command never executed
  });

  it('fails CLOSED when the host cannot answer who the owner is', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob({ ownerUserId: 4, check: 'echo new' })]);
    // Scheduling is allowed, but the host cannot say who is an admin — the guard alone must fail closed.
    const { adapter } = await loadCron(dataRoot, {
      host: { stores: { usersRead: { mayUsePlugin: () => true } } } as unknown as PluginHostWiring,
    });
    let ran = false;
    adapter.listen(async () => { ran = true; return 'ok'; });
    await adapter.tick();

    expect(ran).toBe(false);
    expect(readJobs(dataRoot)[0]!.lastResult).toMatch(/admin-owned/);
  });
});

describe('cron load — jobs of accounts that no longer exist', () => {
  it('drops them at load, because the delete-time teardown only runs when the plugin is loaded', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [
      dueJob({ id: 'gone', ownerUserId: 77 }),
      dueJob({ id: 'kept', ownerUserId: 4 }),
      dueJob({ id: 'instance' }),
    ]);
    // Disable cronjob, delete the account, enable it again: nothing ever told the plugin, and the job
    // would otherwise keep firing paid turns for a person who does not exist.
    const { reg } = await loadCron(dataRoot, { admins: [4] });
    for (const { fn } of reg.bootReconciles) await fn(); // what PluginServiceRunner does at boot
    expect(readJobs(dataRoot).map((j) => j.id).sort()).toEqual(['instance', 'kept']);
  });

  it('leaves the file alone when it cannot read the account list', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob({ id: 'owned', ownerUserId: 77 })]);
    // An unreadable user table is not "nobody exists" — deleting on that reading would be unrecoverable.
    const { reg } = await loadCron(dataRoot, { host: null });
    for (const { fn } of reg.bootReconciles) await fn();
    expect(readJobs(dataRoot).map((j) => j.id)).toEqual(['owned']);
  });
});

describe('cron tools — a turn with no account behind it', () => {
  // A sub-agent inherits its parent's plugin grants but NOT their account (a delegated identity carries no
  // `elowenUserId`). An instance job's owner is also null, so comparing owner to caller would read
  // "null === null" as "mine" and hand every instance job to any granted colleague one delegation hop away.
  it('sees no instance job and cannot remove one, even though the grant came through', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [dueJob({ id: 'operators-job', name: 'operator digest' })]);
    const { reg } = await loadCron(dataRoot);
    const list = reg.tools.find((t) => t.name === 'CronList')!;
    const remove = reg.tools.find((t) => t.name === 'CronRemove')!;

    const delegated: TurnIdentity = { platform: 'subagent', userId: 'subagent', admin: false, owner: false };
    await runWithPolicy(LIMITED, async () => {
      expect(asText(await list.execute('t', {}, undefined as never, undefined as never))).toBe('No scheduled jobs.');
      expect(asText(await remove.execute('t', { id: 'operators-job' }, undefined as never, undefined as never)))
        .toMatch(/no job with id/);
    }, { identity: delegated });

    expect(readJobs(dataRoot).map((j) => j.id)).toEqual(['operators-job']);
  });
});

describe('cron tools — scheduling for the account behind the turn', () => {
  it('stamps the caller as owner, and refuses what only an admin may schedule', async () => {
    const dataRoot = freshDataRoot();
    const { reg } = await loadCron(dataRoot);
    const add = reg.tools.find((t) => t.name === 'CronAdd')!;
    const list = reg.tools.find((t) => t.name === 'CronList')!;
    const remove = reg.tools.find((t) => t.name === 'CronRemove')!;

    await runWithPolicy(LIMITED, async () => {
      expect(asText(await add.execute('t', { name: 'mine', schedule: 'daily 07:30', prompt: 'p' }, undefined as never, undefined as never)))
        .toContain('in your own conversation');
      expect(asText(await add.execute('t', { name: 'guarded', schedule: 'daily 07:30', prompt: 'p', check: 'ls /' }, undefined as never, undefined as never)))
        .toMatch(/shell check/);
      expect(asText(await add.execute('t', { name: 'fast', schedule: 'every 1m', prompt: 'p' }, undefined as never, undefined as never)))
        .toMatch(/shortest interval/);
    }, { identity: AMY });

    const jobs = readJobs(dataRoot);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.ownerUserId).toBe(4);

    // An admin's own job stays an INSTANCE job — no owner key at all, exactly as before ownership existed.
    await runWithPolicy(ADMIN, async () => {
      await add.execute('t', { name: 'instance', schedule: 'daily 08:00', prompt: 'p' }, undefined as never, undefined as never);
    });
    expect(readJobs(dataRoot).find((j) => j.name === 'instance')).not.toHaveProperty('ownerUserId');

    // Another account sees neither job, and cannot remove one it cannot see.
    const bob: TurnIdentity = { ...AMY, userId: '5', elowenUserId: 5 };
    await runWithPolicy(LIMITED, async () => {
      expect(asText(await list.execute('t', {}, undefined as never, undefined as never))).toBe('No scheduled jobs.');
      expect(asText(await remove.execute('t', { id: String(jobs[0]!.id) }, undefined as never, undefined as never))).toMatch(/no job with id/);
    }, { identity: bob });
    expect(readJobs(dataRoot)).toHaveLength(2); // nothing was removed

    // Its owner sees only her own, and may remove it.
    await runWithPolicy(LIMITED, async () => {
      const listed = asText(await list.execute('t', {}, undefined as never, undefined as never));
      expect(listed).toContain('mine');
      expect(listed).not.toContain('instance');
      expect(asText(await remove.execute('t', { id: String(jobs[0]!.id) }, undefined as never, undefined as never))).toMatch(/Removed/);
    }, { identity: AMY });
    expect(readJobs(dataRoot)).toHaveLength(1);
  });
});
