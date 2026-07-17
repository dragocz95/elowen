import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import { processRegistry } from '../../src/brain/processRegistry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true };
const scoped: TurnIdentity = { platform: 'discord', userId: '999', admin: true, owner: false };

const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('t', params);
};

// The process registry is a module-level singleton shared across every test in this run. Background
// commands (and any handle a test registers) survive into later tests and other files, so clear it after
// each test. kill() is idempotent and safe on both fake and real handles.
afterEach(() => { for (const p of processRegistry.list()) processRegistry.kill(p.id); });

describe('terminal plugin', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-term-'));
  });

  it('registers Bash + background process tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['Bash', 'KillProcess', 'ListProcesses', 'ProcessOutput']);
  });

  it('runs a command in an allowed repo (default cwd = first root)', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'echo terminaltest' }), { identity: owner });
    expect(res.content[0].text).toContain('terminaltest');
    expect(res.content[0].text).toContain('[exit 0]');
  });

  it('a turn bound to a project defaults the cwd to that project path, not the first root', async () => {
    const bound = join(dir, 'bound');
    mkdirSync(bound, { recursive: true });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'pwd' }), { identity: owner, workDir: bound });
    expect(res.content[0].text).toContain(join(realpathSync(dir), 'bound'));
    expect(res.content[0].text).toContain('[exit 0]');
  });

  it('refuses a cwd outside the allowed roots', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'echo x', cwd: '/etc' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('admin all-access runs with no roots (defaults to process cwd)', async () => {
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', { command: 'echo adminok' }), { identity: owner });
    expect(res.content[0].text).toContain('adminok');
  });

  it('a user with no repos cannot run anything', async () => {
    const res = await runWithPolicy(userPolicy([]), () => runTool(reg, 'Bash', { command: 'echo nope' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('refuses ALL terminal tools for a role-scoped (non-owner) caller, even with an admin role', async () => {
    for (const [name, params] of [
      ['Bash', { command: 'cat /etc/hostname' }],
      ['ListProcesses', {}],
      ['ProcessOutput', { id: 'x' }],
      ['KillProcess', { id: 'x' }],
    ] as const) {
      const res = await runWithPolicy(adminPolicy, () => runTool(reg, name, params), { identity: scoped });
      expect(res.content[0].text).toMatch(/only available to the operator/);
    }
  });

  it('denies terminal tools when there is no identity (outside a turn)', async () => {
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', { command: 'echo x' }));
    expect(res.content[0].text).toMatch(/only available to the operator/);
  });
});

describe('terminal plugin — live foreground output (onUpdate streaming)', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-term-live-'));
  });

  const runStreaming = (command: string, onUpdate: (p: { content: { text: string }[] }) => void) => {
    const tool = reg.tools.find((t) => t.name === 'Bash');
    if (!tool) throw new Error('Bash not registered');
    const exec = (tool as unknown as { execute: (id: string, p: unknown, signal: undefined, onUpdate: unknown) => Promise<{ content: { text: string }[] }> }).execute;
    return runWithPolicy(userPolicy([dir]), () => exec('t', { command }, undefined, onUpdate), { identity: owner });
  };

  it('pushes the rolling output tail LIVE via onUpdate as a foreground command runs, then returns the full result', async () => {
    const snapshots: string[] = [];
    // Two writes ~250ms apart: past the 100ms throttle, so the second write yields a second progress push
    // whose tail carries BOTH lines — proving the output streamed live, not just at the end.
    const command = `node -e "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 250)"`;
    const res = await runStreaming(command, (p) => snapshots.push(p.content[0].text));
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0]).toContain('first');
    expect(snapshots[0]).not.toContain('second');        // the first push landed before the second write
    expect(snapshots[snapshots.length - 1]).toContain('second'); // a later push carries the grown tail
    // The final result is still complete and correctly framed — streaming didn't replace it.
    expect(res.content[0].text).toContain('first');
    expect(res.content[0].text).toContain('second');
    expect(res.content[0].text).toContain('[exit 0]');
  }, 15_000);

  it('runs fine with no onUpdate (non-streaming callers): the full result is unchanged', async () => {
    const res = await runStreaming('echo noupdate', undefined as unknown as (p: { content: { text: string }[] }) => void);
    expect(res.content[0].text).toContain('noupdate');
    expect(res.content[0].text).toContain('[exit 0]');
  });
});

describe('terminal plugin — configurable outputCap', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-term-cap-')); });
  const bigOutput = (n: number) => `node -e "process.stdout.write('a'.repeat(${n}))"`;
  // The shown output is the tail kept after the "…[truncated: …]\n" hint line, up to the trailing
  // "[exit N]" marker. Its length == the applied cap (bash truncation keeps the END).
  const shownTailLength = (text: string): number => {
    const marker = text.indexOf('…[truncated');
    if (marker < 0) throw new Error('not truncated');
    const start = text.indexOf('\n', marker) + 1; // first char after the hint line
    let end = text.lastIndexOf('[exit ');
    if (text[end - 1] === '\n') end -= 1; // drop the separator newline the plugin inserts before [exit N]
    return end - start;
  };

  it('a configured outputCap (min-clamped 10000) truncates output that the default 60000 would not', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000) }), { identity: owner });
    const text = res.content[0].text;
    expect(text).toContain('…[truncated');
    expect(shownTailLength(text)).toBe(10_000);
  });

  it('unset outputCap reproduces the default 60000-byte cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    const under = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000) }), { identity: owner });
    expect(under.content[0].text).not.toContain('…[truncated'); // below the 60000 default: untouched
    const over = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(65_000) }), { identity: owner });
    const text = over.content[0].text;
    expect(text).toContain('…[truncated');
    expect(shownTailLength(text)).toBe(60_000);
  });

  it('outputCap also bounds the background process rolling buffer', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const scope = { identity: owner, sessionId: 'brain-terminal-output-cap' };
    const started = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000), background: true }), scope);
    const id = /Started background process (\S+):/.exec(started.content[0].text)?.[1];
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500)); // let the short-lived child finish and flush its output
    const out = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'ProcessOutput', { id, all: true }), scope);
    expect(out.content[0].text.length).toBeLessThanOrEqual(10_000 + '\n[exited 0]'.length);
  });
});

// The daemon registry (ctx.processes) is the ONLY store of background children: the plugin keeps no
// parallel map, so a registry-side removal (a deleted conversation → killSession, the web panel's ✕) is
// immediately reflected in what the agent's tools can see, list and count against the cap.
describe('terminal plugin — the process registry is the single source of truth', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-term-registry-'));
  });

  const inSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: owner, sessionId });

  const startBg = async (sessionId: string, command: string): Promise<string> => {
    const res = await inSession(sessionId, 'Bash', { command, background: true });
    const id = /Started background process (\S+):/.exec(res.content[0].text)?.[1];
    expect(id).toBeTruthy();
    return id!;
  };

  it('a registry-side killSession (conversation deleted) clears the plugin view AND frees the cap', async () => {
    const a = 'brain-term-a';
    const b = 'brain-term-b';
    const ids: string[] = [];
    for (let i = 0; i < 16; i += 1) ids.push(await startBg(a, 'sleep 30')); // MAX_BG, per session
    const bId = await startBg(b, 'sleep 30');
    const refused = await inSession(a, 'Bash', { command: 'sleep 30', background: true });
    expect(refused.content[0].text).toMatch(/too many background processes/);

    expect(processRegistry.killSession(a)).toBe(16);

    // No ghost rows and no ghost output buffers left behind for the killed session…
    expect((await inSession(a, 'ListProcesses', {})).content[0].text).toBe('No background processes.');
    expect((await inSession(a, 'ProcessOutput', { id: ids[0] })).content[0].text).toMatch(/no background process/);
    // …the freed slots let new work start again…
    const fresh = await startBg(a, 'sleep 30');
    expect(processRegistry.listForSession(a).map((p) => p.id)).toEqual([fresh]);
    // …and the other session is untouched.
    expect((await inSession(b, 'ListProcesses', {})).content[0].text).toContain(bId);
  }, 20_000);

  it('ProcessOutput returns only NEW output (the daemon panel reading the buffer never consumes it)', async () => {
    const session = 'brain-term-cursor';
    const id = await startBg(session, `node -e "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 500)"`);
    await new Promise((r) => setTimeout(r, 250)); // first write landed, the child is still alive

    const first = await inSession(session, 'ProcessOutput', { id });
    expect(first.content[0].text).toContain('one');
    expect(first.content[0].text).not.toContain('two');
    expect(first.content[0].text).toContain('[still running]');
    // The daemon's own read (web/CLI panel) uses readAll: the whole buffer, cursor untouched.
    expect(processRegistry.output(id)).toBe('one\n');

    await new Promise((r) => setTimeout(r, 600)); // second write + exit
    const second = await inSession(session, 'ProcessOutput', { id });
    expect(second.content[0].text).toContain('two');
    expect(second.content[0].text).not.toContain('one'); // already consumed by the first read
    expect(second.content[0].text).toContain('[exited 0]');
    expect(processRegistry.list().find((p) => p.id === id)).toBeUndefined(); // final read collects the corpse
  }, 15_000);
});

describe('terminal plugin — UTF-8 streaming', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-term-utf8-')); });

  it('does not corrupt multibyte output split across stream chunks', async () => {
    // 70000 × the 3-byte euro sign = 210000 bytes, well past the OS pipe chunk size, so the character
    // lands split across 'data' events at 64KB boundaries (64KB is not a multiple of 3). A per-chunk
    // toString() emits U+FFFD at every such split; the streaming decoder must not. A high outputCap
    // keeps the whole payload so a boundary U+FFFD can't hide in the truncated head.
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 500_000 } },
    });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: `node -e "process.stdout.write('€'.repeat(70000))"` }), { identity: owner });
    const text = res.content[0].text;
    expect(text).not.toContain('�');           // no corruption at any chunk boundary
    expect((text.match(/€/g) ?? []).length).toBe(70001); // 70000 from stdout + 1 in the echoed command
    expect(text).toContain('[exit 0]');
  });
});

// commandTimeoutMs is clamped to a 30000ms floor, and a real child process's 'close' event does not
// reliably fire under vi.useFakeTimers() (Node defers it past the fake clock), so these run in real
// time at the clamp boundary — the fastest a genuine kill can be observed. Both share one `sleep 32`
// duration: the override kills it at ~30s while the (much larger) default lets the same duration
// finish normally, so the pair proves the override actually shortens the wait, without the default
// case needing a full real 120s to prove the constant wasn't shrunk.
describe('terminal plugin — configurable commandTimeoutMs', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-term-timeout-')); });

  it('a configured commandTimeoutMs (min-clamped 30000) kills a command sooner than the default', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { commandTimeoutMs: 30_000 } },
    });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'sleep 32' }), { identity: owner });
    // The kill note names the deadline that fired, so the model can tell "raise the timeout" from
    // "this belongs in the background".
    expect(res.content[0].text).toContain('[killed: timed out after 30s]');
  }, 40_000);

  it('unset commandTimeoutMs keeps the (larger) default: the same duration finishes normally', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'sleep 32' }), { identity: owner });
    expect(res.content[0].text).not.toContain('[killed:');
    expect(res.content[0].text).toContain('[exit 0]');
  }, 40_000);
});

// The per-call `timeout` is what lets a slow-but-finite command (npm install, a full build) run to
// completion in the foreground instead of being pushed to the background purely to survive the clock.
describe('terminal plugin — per-call Bash timeout', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    // A configured 30s default (the floor) — every case below must beat it, proving the per-call value,
    // not the config, decided the outcome.
    reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { commandTimeoutMs: 30_000 } },
    });
    dir = mkdtempSync(join(tmpdir(), 'elowen-term-calltimeout-'));
  });

  it('an explicit timeout overrides the configured default and kills the command at ITS deadline', async () => {
    const started = Date.now();
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'sleep 20', timeout: 1 }), { identity: owner });
    expect(res.content[0].text).toContain('[killed: timed out after 1s]');
    expect(Date.now() - started).toBeLessThan(15_000); // nowhere near the configured 30s default
  }, 30_000);

  it('output produced before the deadline survives the kill', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'echo partial; sleep 20', timeout: 1 }), { identity: owner });
    expect(res.content[0].text).toContain('partial');
    expect(res.content[0].text).toContain('[killed: timed out after 1s]');
  }, 30_000);

  it('a timeout past the 600s ceiling is clamped, not honored verbatim', async () => {
    // Proving the clamp without waiting 10 minutes: the clamped value is what the kill note reports.
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'echo fast', timeout: 99_999 }), { identity: owner });
    expect(res.content[0].text).toContain('[exit 0]');
    const capped = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'sleep 20', timeout: 0 }), { identity: owner });
    expect(capped.content[0].text).toContain('[killed: timed out after 1s]'); // 0 clamps UP to the 1s floor
  }, 30_000);

  it('background=true ignores timeout — a detached process has no deadline to shorten', async () => {
    const scope = { identity: owner, sessionId: 'brain-term-bg-timeout' };
    const started = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'sleep 20', background: true, timeout: 1 }), scope);
    const id = /Started background process (\S+):/.exec(started.content[0].text)?.[1];
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 2_500)); // well past the (ignored) 1s timeout
    expect(processRegistry.list().find((p) => p.id === id)?.running).toBe(true);
  }, 20_000);
});

// Blocking reads exist so the agent stops burning turns polling a build it started. The wait is bounded
// and never destructive: a timed-out wait leaves the process running for a later read.
describe('terminal plugin — ProcessOutput(block)', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-term-block-'));
  });

  const inSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: owner, sessionId });
  const startBg = async (sessionId: string, command: string): Promise<string> => {
    const res = await inSession(sessionId, 'Bash', { command, background: true });
    const id = /Started background process (\S+):/.exec(res.content[0].text)?.[1];
    expect(id).toBeTruthy();
    return id!;
  };

  it('block=true returns as soon as the process exits, with its full final output', async () => {
    const session = 'brain-term-block-exit';
    const id = await startBg(session, `node -e "setTimeout(() => { console.log('finished'); }, 600)"`);
    const started = Date.now();
    const res = await inSession(session, 'ProcessOutput', { id, block: true, timeout: 30 });
    const elapsed = Date.now() - started;

    expect(res.content[0].text).toContain('finished');
    expect(res.content[0].text).toContain('[exited 0]');
    expect(elapsed).toBeGreaterThan(300);  // it really waited for the child…
    expect(elapsed).toBeLessThan(10_000);  // …and returned on the exit, not on the 30s deadline
    expect(processRegistry.list().find((p) => p.id === id)).toBeUndefined(); // the exit read collects it
  }, 20_000);

  it('block=true on an already-finished process returns immediately', async () => {
    const session = 'brain-term-block-done';
    const id = await startBg(session, 'echo instant');
    await new Promise((r) => setTimeout(r, 500)); // let it exit before we read
    const started = Date.now();
    const res = await inSession(session, 'ProcessOutput', { id, block: true, timeout: 60 });
    expect(res.content[0].text).toContain('instant');
    expect(res.content[0].text).toContain('[exited 0]');
    expect(Date.now() - started).toBeLessThan(2_000); // no waiting on a corpse
  }, 20_000);

  it('a timed-out block reports the wait and leaves the process running for a later read', async () => {
    const session = 'brain-term-block-timeout';
    const id = await startBg(session, `node -e "console.log('early'); setTimeout(() => {}, 30000)"`);
    const res = await inSession(session, 'ProcessOutput', { id, block: true, timeout: 1 });

    expect(res.content[0].text).toContain('early');           // output so far is still returned
    expect(res.content[0].text).toContain('[still running after waiting 1s]');
    // Not collected — the caller can block again, or kill it.
    expect(processRegistry.list().find((p) => p.id === id)?.running).toBe(true);
  }, 20_000);

  it('without block the read stays a non-waiting snapshot', async () => {
    const session = 'brain-term-block-off';
    const id = await startBg(session, `node -e "setTimeout(() => { console.log('late'); }, 5000)"`);
    const started = Date.now();
    const res = await inSession(session, 'ProcessOutput', { id });
    expect(res.content[0].text).toContain('[still running]');
    expect(res.content[0].text).not.toContain('after waiting');
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 20_000);

  it('a killed process releases a blocked reader instead of hanging it to the deadline', async () => {
    const session = 'brain-term-block-killed';
    const id = await startBg(session, 'sleep 30');
    const started = Date.now();
    const read = inSession(session, 'ProcessOutput', { id, block: true, timeout: 120 });
    await new Promise((r) => setTimeout(r, 300));
    processRegistry.kill(id); // the web panel's ✕, or the conversation being deleted

    await read;
    expect(Date.now() - started).toBeLessThan(10_000); // released on the kill, not after 120s
  }, 20_000);
});
