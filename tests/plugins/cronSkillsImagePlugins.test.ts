import { describe, it, expect, vi, afterEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { processRegistry } from '../../src/brain/processRegistry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const LIMITED: Policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [] };
const OWNER: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
const asText = (r: { content: { text?: string }[] }) => (r.content[0] as { text: string }).text;

function freshDataRoot(): string { return mkdtempSync(join(tmpdir(), 'elowen-pdata-')); }

// The process registry is a module-level singleton shared across every test in this run. Any handle a
// test registers (even fake ones) survives into later tests and other files, so clear it after each test.
// kill() is idempotent and safe on both fake and real handles.
afterEach(() => { for (const p of processRegistry.list()) processRegistry.kill(p.id); });

describe('cronjob plugin', () => {
  it('parses schedules and computes due-ness', async () => {
    const { parseSchedule, isDue } = await import(join(pluginsDir, 'cronjob/index.mjs')) as {
      parseSchedule: (s: string) => { kind: string } | null;
      isDue: (j: { schedule: string; lastRun?: string }, now: number) => boolean;
    };
    expect(parseSchedule('every 15m')).toEqual({ kind: 'interval', ms: 900_000 });
    expect(parseSchedule('every 2h')).toEqual({ kind: 'interval', ms: 7_200_000 });
    expect(parseSchedule('daily 07:30')).toEqual({ kind: 'daily', hour: 7, minute: 30 });
    expect(parseSchedule('every 30s')).toBeNull(); // sub-minute refused
    expect(parseSchedule('nesmysl')).toBeNull();

    const now = new Date('2026-07-02T08:00:00Z').getTime();
    expect(isDue({ schedule: 'every 15m' }, now)).toBe(true); // never ran
    expect(isDue({ schedule: 'every 15m', lastRun: new Date(now - 60_000).toISOString() }, now)).toBe(false);
    expect(isDue({ schedule: 'every 15m', lastRun: new Date(now - 16 * 60_000).toISOString() }, now)).toBe(true);
  });

  it('parses one-shot wakeups and fires them exactly once', async () => {
    const { parseOneShot, isDue } = await import(join(pluginsDir, 'cronjob/index.mjs')) as {
      parseOneShot: (s: string, now: number) => number | null;
      isDue: (j: { schedule: string; runAt?: string; lastRun?: string }, now: number) => boolean;
    };
    const now = new Date('2026-07-02T10:00:00Z').getTime();
    expect(parseOneShot('in 20m', now)).toBe(now + 20 * 60_000);
    expect(parseOneShot('in 2h', now)).toBe(now + 2 * 3_600_000);
    expect(parseOneShot('in 10s', now)).toBe(now + 10_000);
    expect(parseOneShot('in 4s', now)).toBeNull(); // below the 5 s floor
    expect(parseOneShot('every 5m', now)).toBeNull();
    const at = parseOneShot('at 18:30', now)!;
    expect(new Date(at).getHours()).toBe(18);
    expect(at).toBeGreaterThan(now);

    const job = { schedule: 'in 20m', runAt: new Date(now + 20 * 60_000).toISOString() };
    expect(isDue(job, now)).toBe(false);
    expect(isDue(job, now + 21 * 60_000)).toBe(true);
    expect(isDue({ ...job, lastRun: new Date(now + 21 * 60_000).toISOString() }, now + 30 * 60_000)).toBe(false); // ran → never again
  });

  it('the cron platform never exposes a `notify` method (the host broadcast would recurse into itself)', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger: log });
    // BrainService.notify() calls every platform whose `notify` is a function; the cron adapter holds
    // the host's own notify sink, so exposing it under that name loops host → cron → host until the
    // stack blows — every cron echo then lands dozens of times on Discord.
    expect(typeof (reg.platforms[0] as { notify?: unknown }).notify).toBe('undefined');
  });

  it('cron_add/list/remove work in an admin session and are refused otherwise', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger: log });
    expect(reg.platforms.map((p) => p.name)).toEqual(['cron']);
    const add = reg.tools.find((t) => t.name === 'cron_add')!;
    const list = reg.tools.find((t) => t.name === 'cron_list')!;
    const remove = reg.tools.find((t) => t.name === 'cron_remove')!;

    await runWithPolicy(LIMITED, async () => {
      expect(asText(await add.execute('t', { name: 'x', schedule: 'every 15m', prompt: 'p' }, undefined as never, undefined as never))).toMatch(/admin session/);
    });
    await runWithPolicy(ADMIN, async () => {
      expect(asText(await add.execute('t', { name: 'ranní report', schedule: 'daily 07:30', prompt: 'shrň stav' }, undefined as never, undefined as never))).toMatch(/Scheduled/);
      expect(asText(await add.execute('t', { name: 'bad', schedule: 'every 5s', prompt: 'p' }, undefined as never, undefined as never))).toMatch(/invalid schedule/);
      const listed = asText(await list.execute('t', {}, undefined as never, undefined as never));
      expect(listed).toContain('ranní report');
      const jobs = JSON.parse(readFileSync(join(dataRoot, 'cronjob/jobs.json'), 'utf-8')) as { id: string }[];
      expect(asText(await remove.execute('t', { id: jobs[0]!.id }, undefined as never, undefined as never))).toMatch(/Removed/);
      expect(asText(await list.execute('t', {}, undefined as never, undefined as never))).toBe('No scheduled jobs.');
    });
  });
});

describe('skills plugin creator tools', () => {
  it('create → list → delete a user skill (admin only)', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['skills'], dataRoot, logger: log });
    const create = reg.tools.find((t) => t.name === 'create_skill')!;
    const list = reg.tools.find((t) => t.name === 'list_skills')!;
    const del = reg.tools.find((t) => t.name === 'delete_skill')!;

    await runWithPolicy(LIMITED, async () => {
      expect(asText(await create.execute('t', { name: 'x', description: 'd', content: 'c' }, undefined as never, undefined as never))).toMatch(/admin session/);
    });
    await runWithPolicy(ADMIN, async () => {
      expect(asText(await create.execute('t', { name: 'Bad Name', description: 'd', content: 'c' }, undefined as never, undefined as never))).toMatch(/kebab-case/);
      expect(asText(await create.execute('t', { name: 'deploy-checklist', description: 'Kdy nasazovat', content: 'Kroky…' }, undefined as never, undefined as never))).toMatch(/saved/);
      const file = join(dataRoot, 'skills/deploy-checklist.md');
      expect(readFileSync(file, 'utf-8')).toContain('name: deploy-checklist');
      expect(asText(await list.execute('t', {}, undefined as never, undefined as never))).toContain('deploy-checklist (user)');
      expect(asText(await del.execute('t', { name: 'deploy-checklist' }, undefined as never, undefined as never))).toMatch(/deleted/);
      expect(existsSync(file)).toBe(false);
    });
  });

  it('user-created skills register on the next plugin load', async () => {
    const dataRoot = freshDataRoot();
    const reg1 = await loadPlugins({ dirs: [pluginsDir], enabled: ['skills'], dataRoot, logger: log });
    const create = reg1.tools.find((t) => t.name === 'create_skill')!;
    await runWithPolicy(ADMIN, async () => {
      await create.execute('t', { name: 'novy-skill', description: 'test', content: 'obsah' }, undefined as never, undefined as never);
    });
    const reg2 = await loadPlugins({ dirs: [pluginsDir], enabled: ['skills'], dataRoot, logger: log });
    expect(reg2.skills.some((s) => s.name === 'novy-skill')).toBe(true);
  });
});

describe('terminal plugin background processes', () => {
  it('runs a command in the background, reads its output, and lists/kills it', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['terminal'], dataRoot, logger: log });
    const names = reg.tools.map((t) => t.name).sort();
    expect(names).toEqual(['kill_process', 'list_processes', 'read_process_output', 'run_command']);
    const run = reg.tools.find((t) => t.name === 'run_command')!;
    const read = reg.tools.find((t) => t.name === 'read_process_output')!;
    const list = reg.tools.find((t) => t.name === 'list_processes')!;

    await runWithPolicy(ADMIN, async () => {
      const started = asText(await run.execute('t', { command: 'echo hello-bg', cwd: '/tmp', background: true }, undefined as never, undefined as never));
      const id = /background process (\w+):/.exec(started)![1]!;
      expect(asText(await list.execute('t', {}, undefined as never, undefined as never))).toContain(id);
      // give the child a moment to flush + exit
      await new Promise((r) => setTimeout(r, 300));
      const out = asText(await read.execute('t', { id, all: true }, undefined as never, undefined as never));
      expect(out).toContain('hello-bg');
    }, { identity: OWNER, sessionId: 'brain-terminal-test' });
  });

  it('keeps background process tools isolated between parent and child sessions', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['terminal'], dataRoot, logger: log });
    const run = reg.tools.find((t) => t.name === 'run_command')!;
    const list = reg.tools.find((t) => t.name === 'list_processes')!;
    const read = reg.tools.find((t) => t.name === 'read_process_output')!;
    const kill = reg.tools.find((t) => t.name === 'kill_process')!;
    const scoped = <T>(sessionId: string, fn: () => T): T => runWithPolicy(ADMIN, fn, { identity: OWNER, sessionId });

    const parentText = await scoped('brain-parent', async () => asText(await run.execute('p', { command: 'sleep 5', cwd: '/tmp', background: true }, undefined as never, undefined as never)));
    const childText = await scoped('brain-child', async () => asText(await run.execute('c', { command: 'sleep 5', cwd: '/tmp', background: true }, undefined as never, undefined as never)));
    const parentId = /background process (\w+):/.exec(parentText)![1]!;
    const childId = /background process (\w+):/.exec(childText)![1]!;
    expect(await scoped('brain-parent', async () => asText(await list.execute('l', {}, undefined as never, undefined as never)))).toContain(parentId);
    expect(await scoped('brain-parent', async () => asText(await list.execute('l', {}, undefined as never, undefined as never)))).not.toContain(childId);
    expect(await scoped('brain-parent', async () => asText(await read.execute('r', { id: childId }, undefined as never, undefined as never)))).toMatch(/no background process/);
    expect(await scoped('brain-parent', async () => asText(await kill.execute('k', { id: childId }, undefined as never, undefined as never)))).toMatch(/no background process/);
    await scoped('brain-parent', async () => kill.execute('kp', { id: parentId }, undefined as never, undefined as never));
    await scoped('brain-child', async () => kill.execute('kc', { id: childId }, undefined as never, undefined as never));
  });

  it('run_command is refused for a non-owner (role-scoped) identity', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['terminal'], dataRoot, logger: log });
    const run = reg.tools.find((t) => t.name === 'run_command')!;
    const CHANNEL: TurnIdentity = { platform: 'discord', userId: 'disc-9', admin: true, owner: false };
    await runWithPolicy(ADMIN, async () => {
      const out = asText(await run.execute('t', { command: 'echo nope', cwd: '/tmp' }, undefined as never, undefined as never));
      expect(out).toMatch(/only available to the operator/);
    }, { identity: CHANNEL });
  });
});

describe('subagent plugin', () => {
  it('collects a background job that already exited before the first reply', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    const sessionId = 'brain-ch-subagent-bgwait';
    const reminders: string[] = [];
    let calls = 0;
    reg.platforms[0]!.listen(async (_src, text, onEvent) => {
      calls += 1;
      onEvent?.({ type: 'session', sessionId });
      if (calls === 1) {
        // The job is ALREADY terminal by the time the parent replies. The old collect loop was gated on
        // runningJobCount > 0, so it would skip this job entirely and hand back only "I started the build".
        processRegistry.register({
          id: 'child-proc', command: 'build', cwd: '/tmp', startedAt: new Date().toISOString(), sessionId,
          running: () => false, exitCode: () => 0, readAll: () => 'build passed', kill: () => {},
        });
        return 'I started the build';
      }
      reminders.push(text);
      processRegistry.remove('child-proc');
      return 'final verified result';
    });
    const completions: Record<string, unknown>[] = [];
    await runWithPolicy(ADMIN, async () => {
      await delegate.execute('bg-wait', { task: 'build and verify', background: true }, undefined as never, undefined as never);
    }, { identity: OWNER, sessionId: 'brain-parent-bgwait', emitSubagentCompletion: (value) => completions.push(value) });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(calls).toBe(2);
    expect(reminders[0]).toContain('<background-processes-finished>');
    expect(reminders[0]).toContain('child-proc');
    expect(reminders[0]).toContain('exit 0');
    expect(completions[0]).toMatchObject({ status: 'done', result: 'final verified result' });
  });

  it('reports each finished background job exactly once across successive collect turns', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    const sessionId = 'brain-ch-subagent-delta';
    const reminders: string[] = [];
    const registerJob = (id: string) => {
      let running = true;
      processRegistry.register({
        id, command: id, cwd: '/tmp', startedAt: new Date().toISOString(), sessionId,
        running: () => running, exitCode: () => running ? null : 0, readAll: () => `${id} done`, kill: () => { running = false; },
      });
      setTimeout(() => { running = false; processRegistry.markExited(id); }, 10);
    };
    let calls = 0;
    reg.platforms[0]!.listen(async (_src, text, onEvent) => {
      calls += 1;
      onEvent?.({ type: 'session', sessionId });
      if (calls === 1) { registerJob('proc-a'); return 'started A'; }
      reminders.push(text);
      if (calls === 2) { registerJob('proc-b'); return 'started B'; }
      return 'final';
    });
    const completions: Record<string, unknown>[] = [];
    await runWithPolicy(ADMIN, async () => {
      await delegate.execute('delta', { task: 'chain jobs', background: true }, undefined as never, undefined as never);
    }, { identity: OWNER, sessionId: 'brain-parent-delta', emitSubagentCompletion: (v) => completions.push(v) });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(calls).toBe(3);
    expect(reminders).toHaveLength(2);
    // Turn 2 lists A only; turn 3 lists B and NEVER re-lists the already-reported A.
    expect(reminders[0]).toContain('proc-a');
    expect(reminders[0]).not.toContain('proc-b');
    expect(reminders[1]).toContain('proc-b');
    expect(reminders[1]).not.toContain('proc-a');
    // A block is only ever emitted with rows in it — never an empty element.
    for (const r of reminders) expect(r).not.toMatch(/<background-processes-(finished|still-running)>\s*<\//);
  });

  it('keeps announcing the child as running while the collect loop waits on its jobs', async () => {
    // The host registers a delegated child only for the duration of a channel turn, so the moment the
    // child's reply returns it is deregistered — while the delegation is still very much alive, parked in
    // the collect loop's job wait. Everything that decides whether a delegate is alive keys on that
    // registration (the parent's abort tree, its status view, its context block and, worst of all, the
    // restart reconcile, which terminalizes a "running" row it cannot see as live and tells the parent the
    // sub-agent was interrupted). So the plugin must re-assert `running` before it starts waiting.
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    const sessionId = 'brain-ch-subagent-alive';
    let released!: () => void;
    const jobExits = new Promise<void>((resolve) => { released = resolve; });
    const updates: { status: string; sessionId: string }[] = [];
    const completions: Record<string, unknown>[] = [];
    let calls = 0;
    let updatesWhenReplyReturned = -1;
    reg.platforms[0]!.listen(async (_src, _text, onEvent) => {
      calls += 1;
      onEvent?.({ type: 'session', sessionId });
      if (calls > 1) return 'final';
      let running = true;
      processRegistry.register({
        id: 'slow-job', command: 'build', cwd: '/tmp', startedAt: new Date().toISOString(), sessionId,
        running: () => running, exitCode: () => running ? null : 0, readAll: () => 'built', kill: () => { running = false; },
      });
      void jobExits.then(() => { running = false; processRegistry.markExited('slow-job'); });
      // Everything the host has heard by the time this reply returns — the point where it deregisters the
      // child. Anything after this is the plugin telling it the delegation is still alive.
      updatesWhenReplyReturned = updates.length;
      return 'started the build';
    });

    await runWithPolicy(ADMIN, async () => {
      await delegate.execute('alive', { task: 'build it', background: true }, undefined as never, undefined as never);
    }, {
      identity: OWNER, sessionId: 'brain-parent-alive',
      emitSubagent: (u) => updates.push(u as never),
      emitSubagentCompletion: (v) => completions.push(v),
    });

    // Parked on the job, with the reply already handed back. The plugin MUST have re-announced the child as
    // running since then; without that update the host's last word on this child is "not running", and the
    // reconcile terminalizes a delegate that is still working.
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(updatesWhenReplyReturned));
    expect(updates.slice(updatesWhenReplyReturned).every((u) => u.status === 'running')).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: 'running', sessionId });
    expect(completions).toHaveLength(0);

    released();
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(updates.at(-1)?.status).toBe('done'); // …and only the real finish takes the registration away
  });

  it('breaks the collect loop without an extra turn when the child job is killed', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    const sessionId = 'brain-ch-subagent-kill';
    let calls = 0;
    reg.platforms[0]!.listen(async (_src, _text, onEvent) => {
      calls += 1;
      onEvent?.({ type: 'session', sessionId });
      // Register a running job, then immediately kill it (dropped from the registry). Nothing is left to
      // collect, so the loop must break with no extra collect turn.
      let running = true;
      processRegistry.register({
        id: 'killed-proc', command: 'watch', cwd: '/tmp', startedAt: new Date().toISOString(), sessionId,
        running: () => running, exitCode: () => running ? null : 0, readAll: () => '', kill: () => { running = false; },
      });
      processRegistry.kill('killed-proc');
      return 'started and killed';
    });
    const completions: Record<string, unknown>[] = [];
    await runWithPolicy(ADMIN, async () => {
      await delegate.execute('kill', { task: 'watch', background: true }, undefined as never, undefined as never);
    }, { identity: OWNER, sessionId: 'brain-parent-kill', emitSubagentCompletion: (v) => completions.push(v) });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(calls).toBe(1);
    expect(completions[0]).toMatchObject({ status: 'done', result: 'started and killed' });
  });

  it('reminds the child of still-running jobs on a wait timeout, then of the finished job once it exits', async () => {
    vi.useFakeTimers();
    try {
      const dataRoot = freshDataRoot();
      const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
      const delegate = reg.tools.find((t) => t.name === 'delegate')!;
      const sessionId = 'brain-ch-subagent-timeout';
      const reminders: string[] = [];
      let running = true;
      let calls = 0;
      reg.platforms[0]!.listen(async (_src, text, onEvent) => {
        calls += 1;
        onEvent?.({ type: 'session', sessionId });
        if (calls === 1) {
          processRegistry.register({
            id: 'slow-proc', command: 'long-build', cwd: '/tmp', startedAt: new Date().toISOString(), sessionId,
            running: () => running, exitCode: () => running ? null : 0, readAll: () => 'built', kill: () => { running = false; },
          });
          return 'started slow build';
        }
        reminders.push(text);
        if (calls === 2) { running = false; processRegistry.markExited('slow-proc'); return 'still waiting'; }
        return 'final';
      });
      let resolveDone!: () => void;
      const completed = new Promise<void>((resolve) => { resolveDone = resolve; });
      const completions: Record<string, unknown>[] = [];
      await runWithPolicy(ADMIN, async () => {
        await delegate.execute('timeout', { task: 'slow build', background: true }, undefined as never, undefined as never);
      }, { identity: OWNER, sessionId: 'brain-parent-timeout', emitSubagentCompletion: (v) => { completions.push(v); resolveDone(); } });
      // Let the child reach its first idle wait (registers the timeout timer), then trip the timeout.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await completed;
      expect(calls).toBe(3);
      // Turn 2: the wait timed out with the job still running → still-running block, no finished block.
      expect(reminders[0]).toContain('<background-processes-still-running>');
      expect(reminders[0]).toContain('slow-proc');
      expect(reminders[0]).not.toContain('<background-processes-finished>');
      // Turn 3: the job has since exited → finished block.
      expect(reminders[1]).toContain('<background-processes-finished>');
      expect(reminders[1]).toContain('slow-proc');
      expect(reminders[1]).toContain('exit 0');
      expect(completions[0]).toMatchObject({ status: 'done', result: 'final' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits the child current-tool detail on progress updates (UI/store projection)', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    let resolveReply!: (r: string) => void;
    const reply = new Promise<string>((resolve) => { resolveReply = resolve; });
    reg.platforms[0]!.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-detail' });
      onEvent?.({ type: 'tool', name: 'read_file', detail: 'src/parser.ts' } as never);
      return reply;
    });
    const updates: { status: string; detail?: string }[] = [];
    const started = await runWithPolicy(ADMIN, async () =>
      asText(await delegate.execute('detail', { task: 'inspect', background: true }, undefined as never, undefined as never)), {
      sessionId: 'brain-parent-detail', identity: OWNER,
      emitSubagent: (u) => updates.push(u),
    });
    expect(started).toContain('Started background delegation');
    await vi.waitFor(() => expect(updates.some((u) => u.detail === 'read_file src/parser.ts')).toBe(true));
    resolveReply('done');
  });

  it('delegate forwards the caller access, parent session + task and blocks by default', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    expect(reg.platforms.map((p) => p.name)).toEqual(['subagent']);
    expect(reg.tools.map((t) => t.name).sort()).toEqual([
      'delegate', 'delegate_models', 'delegate_result', 'delegate_status',
      'workflow_add_nodes', 'workflow_start', 'workflow_status',
    ]);
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;

    // Before the host wires the platform handler, delegate fails gracefully.
    await runWithPolicy(LIMITED, async () => {
      expect(asText(await delegate.execute('t', { task: 'x' }, undefined as never, undefined as never))).toMatch(/not wired up/);
    });

    // Capture the handler the way the host does, then delegate under a scoped policy.
    let seen: { access?: { projectIds: number[]; admin: boolean; owner: boolean; parentSessionId?: string; sessionIdleMs?: number; toolPolicy?: { allow?: string[]; deny?: string[] } } } | null = null;
    reg.platforms[0]!.listen(async (src, text) => { seen = src; return `sub did: ${text}`; });
    await runWithPolicy(LIMITED, async () => {
      const out = asText(await delegate.execute('t', { task: 'najdi bug' }, undefined as never, undefined as never));
      expect(out).toBe('sub did: najdi bug');
    }, {
      sessionId: 'brain-parent-1',
      identity: { platform: 'discord', userId: 'foreign-admin', admin: true, owner: false },
      toolPolicy: { allow: new Set(['delegate']), deny: new Set(['discord_api']) },
    });
    expect(seen!.access).toMatchObject({
      projectIds: [1], admin: false, owner: false, parentSessionId: 'brain-parent-1',
      // The delegate transcript never rolls over into a fresh session mid-flight.
      sessionIdleMs: Infinity,
      toolPolicy: { allow: ['delegate'], deny: ['discord_api'] },
    });
  });

  it('delegate inherits admin scope and owner truth independently', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    let seen: { access?: { admin: boolean; owner: boolean } } | null = null;
    reg.platforms[0]!.listen(async (src) => { seen = src; return 'ok'; });
    await runWithPolicy(ADMIN, async () => {
      await delegate.execute('t', { task: 'cokoliv' }, undefined as never, undefined as never);
    }, { identity: OWNER });
    expect(seen!.access).toMatchObject({ admin: true, owner: true });
  });

  it('detaches a foreground delegation without cancelling the child and reports its eventual result', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    const control = reg.controls.get('subagent') as {
      detachForeground(input: { sessionId: string; principal: string }): { detached: number };
    };
    expect(control).toBeTruthy();

    let resolveChild!: (reply: string) => void;
    const child = new Promise<string>((resolve) => { resolveChild = resolve; });
    reg.platforms[0]!.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-detached' });
      return child;
    });
    const completed: unknown[] = [];
    const foreground = runWithPolicy(ADMIN, () =>
      delegate.execute('call-fg', { task: 'inspect slowly' }, undefined as never, undefined as never), {
      sessionId: 'brain-parent-detach', identity: OWNER,
      emitSubagentCompletion: (result) => completed.push(result),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(control.detachForeground(
      { sessionId: 'brain-parent-detach', principal: 'elowen:1' },
    )).toEqual({ detached: 1 });
    expect(asText(await foreground)).toContain('moved this sub-agent to the background');

    resolveChild('detached child result');
    await vi.waitFor(() => expect(completed).toEqual([
      expect.objectContaining({
        sessionId: 'brain-ch-subagent-detached',
        task: 'inspect slowly',
        status: 'done',
        result: 'detached child result',
      }),
    ]));
  });

  it('returns a background handle immediately, exposes progress/result, and keeps emitting the child session', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    const status = reg.tools.find((t) => t.name === 'delegate_status')!;
    const result = reg.tools.find((t) => t.name === 'delegate_result')!;

    let resolveReply!: (reply: string) => void;
    const childReply = new Promise<string>((resolve) => { resolveReply = resolve; });
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    let seen: { access?: { parentSessionId?: string } } | null = null;
    reg.platforms[0]!.listen(async (src, _text, onEvent) => {
      seen = src;
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-background' });
      onEvent?.({ type: 'tool', name: 'read_file', detail: 'src/a.ts' } as never);
      onEvent?.({ type: 'step', usage: { totalTokens: 321 } } as never);
      childStarted();
      return childReply;
    });

    const emitted: { status: string; sessionId: string }[] = [];
    const completions: Record<string, unknown>[] = [];
    let terminalEmitted!: () => void;
    const terminal = new Promise<void>((resolve) => { terminalEmitted = resolve; });
    const startedText = await runWithPolicy(ADMIN, async () =>
      asText(await delegate.execute('call-bg', { task: 'inspect the parser', background: true }, undefined as never, undefined as never)), {
      sessionId: 'brain-parent-bg',
      identity: OWNER,
      emitSubagent: (update) => {
        emitted.push(update);
        if (update.status === 'done' || update.status === 'error') terminalEmitted();
      },
      emitSubagentCompletion: (completion) => { completions.push(completion); },
    });
    const jobId = /Started background delegation (dlg-[\w-]+)\./.exec(startedText)?.[1];
    expect(jobId).toBeTruthy();
    // An auto-delivered result can only land once the parent turn is over, so the model must be told to end
    // its turn rather than wait or poll for it.
    expect(startedText).toContain('automatically in a NEW turn');
    expect(startedText).toContain('end your turn');
    expect(startedText).toContain('polling delegate_status in a loop is never the answer');
    await started;

    const asOwner = <T>(fn: () => T): T => runWithPolicy(ADMIN, fn, { sessionId: 'brain-parent-bg', identity: OWNER });
    const liveStatus = await asOwner(async () => asText(await status.execute('status', { id: jobId! }, undefined as never, undefined as never)));
    expect(liveStatus).toContain('RUNNING');
    expect(liveStatus).toContain('brain-ch-subagent-background');
    expect(liveStatus).toContain('Progress: read_file src/a.ts');
    expect(liveStatus).toContain('Tokens: 321');
    expect(await asOwner(async () => asText(await result.execute('result', { id: jobId! }, undefined as never, undefined as never)))).toContain('still running');
    const foreignSender: TurnIdentity = { platform: 'discord', userId: 'other-sender', admin: true, owner: false };
    const denied = await runWithPolicy(ADMIN, async () =>
      asText(await result.execute('result', { id: jobId! }, undefined as never, undefined as never)), {
      sessionId: 'brain-parent-bg', identity: foreignSender,
    });
    expect(denied).toMatch(/no background delegation/);
    expect(seen!.access).toMatchObject({ parentSessionId: 'brain-parent-bg' });

    resolveReply('background result');
    await terminal;
    expect(await asOwner(async () => asText(await result.execute('result', { id: jobId! }, undefined as never, undefined as never)))).toBe('background result');
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'running', sessionId: 'brain-ch-subagent-background', background: true, autoDeliver: true }),
      expect.objectContaining({ status: 'done', sessionId: 'brain-ch-subagent-background' }),
    ]));
    expect(completions).toEqual([
      expect.objectContaining({ id: jobId, toolCallId: 'call-bg', sessionId: 'brain-ch-subagent-background', status: 'done', result: 'background result' }),
    ]);
  });

  it('retains a canceled background child as ERROR (never DONE) and expires the terminal job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T20:00:00Z'));
    try {
      const dataRoot = freshDataRoot();
      const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot, logger: log });
      const delegate = reg.tools.find((t) => t.name === 'delegate')!;
      const status = reg.tools.find((t) => t.name === 'delegate_status')!;
      const result = reg.tools.find((t) => t.name === 'delegate_result')!;
      reg.platforms[0]!.listen(async (_src, _text, onEvent) => {
        onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-failed' });
        onEvent?.({ type: 'text', delta: 'partial output before cancellation' } as never);
        throw new Error('delegation aborted');
      });

      let terminalEmitted!: () => void;
      const terminal = new Promise<void>((resolve) => { terminalEmitted = resolve; });
      const startedText = await runWithPolicy(ADMIN, async () =>
        asText(await delegate.execute('call-fail', { task: 'fail safely', background: true }, undefined as never, undefined as never)), {
        sessionId: 'brain-parent-fail',
        identity: OWNER,
        emitSubagent: (update) => { if (update.status === 'error') terminalEmitted(); },
      });
      const jobId = /Started background delegation (dlg-[\w-]+)\./.exec(startedText)?.[1];
      expect(jobId).toBeTruthy();
      await terminal;
      const scoped = <T>(fn: () => T): T => runWithPolicy(ADMIN, fn, { sessionId: 'brain-parent-fail', identity: OWNER });
      expect(await scoped(async () => asText(await status.execute('status', { id: jobId! }, undefined as never, undefined as never)))).toContain('ERROR');
      expect(await scoped(async () => asText(await result.execute('result', { id: jobId! }, undefined as never, undefined as never)))).toBe('Error: delegation aborted');

      vi.setSystemTime(new Date('2026-07-10T22:00:01Z'));
      expect(await scoped(async () => asText(await status.execute('status', { id: jobId! }, undefined as never, undefined as never)))).toMatch(/may have expired/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains a failed progress fan-out so a detached background job still settles', async () => {
    const dataRoot = freshDataRoot();
    const warnings: string[] = [];
    const reg = await loadPlugins({
      dirs: [pluginsDir], enabled: ['subagent'], dataRoot,
      logger: { ...log, warn: (message: string) => warnings.push(message) },
    });
    const delegate = reg.tools.find((t) => t.name === 'delegate')!;
    const result = reg.tools.find((t) => t.name === 'delegate_result')!;
    reg.platforms[0]!.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-fanout' });
      return 'child completed';
    });

    const started = await runWithPolicy(ADMIN, async () =>
      asText(await delegate.execute('call-fanout', { task: 'finish safely', background: true }, undefined as never, undefined as never)), {
      sessionId: 'brain-parent-fanout', identity: OWNER,
      emitSubagent: () => { throw new Error('parent fan-out unavailable'); },
    });
    const jobId = /Started background delegation (dlg-[\w-]+)\./.exec(started)?.[1];
    expect(jobId).toBeTruthy();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const scoped = <T>(fn: () => T): T => runWithPolicy(ADMIN, fn, { sessionId: 'brain-parent-fanout', identity: OWNER });
    expect(await scoped(async () => asText(await result.execute('result', { id: jobId! }, undefined as never, undefined as never)))).toBe('child completed');
    expect(warnings).toContainEqual(expect.stringContaining('subagent progress fan-out failed'));
  });
});
