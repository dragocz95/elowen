import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

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

describe('terminal plugin', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-term-'));
  });

  it('registers run_command + background process tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['kill_process', 'list_processes', 'read_process_output', 'run_command']);
  });

  it('runs a command in an allowed repo (default cwd = first root)', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: 'echo terminaltest' }), { identity: owner });
    expect(res.content[0].text).toContain('terminaltest');
    expect(res.content[0].text).toContain('[exit 0]');
  });

  it('a turn bound to a project defaults the cwd to that project path, not the first root', async () => {
    const bound = join(dir, 'bound');
    mkdirSync(bound, { recursive: true });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: 'pwd' }), { identity: owner, workDir: bound });
    expect(res.content[0].text).toContain(join(realpathSync(dir), 'bound'));
    expect(res.content[0].text).toContain('[exit 0]');
  });

  it('refuses a cwd outside the allowed roots', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: 'echo x', cwd: '/etc' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('admin all-access runs with no roots (defaults to process cwd)', async () => {
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'run_command', { command: 'echo adminok' }), { identity: owner });
    expect(res.content[0].text).toContain('adminok');
  });

  it('a user with no repos cannot run anything', async () => {
    const res = await runWithPolicy(userPolicy([]), () => runTool(reg, 'run_command', { command: 'echo nope' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('refuses ALL terminal tools for a role-scoped (non-owner) caller, even with an admin role', async () => {
    for (const [name, params] of [
      ['run_command', { command: 'cat /etc/hostname' }],
      ['list_processes', {}],
      ['read_process_output', { id: 'x' }],
      ['kill_process', { id: 'x' }],
    ] as const) {
      const res = await runWithPolicy(adminPolicy, () => runTool(reg, name, params), { identity: scoped });
      expect(res.content[0].text).toMatch(/only available to the operator/);
    }
  });

  it('denies terminal tools when there is no identity (outside a turn)', async () => {
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'run_command', { command: 'echo x' }));
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
    const tool = reg.tools.find((t) => t.name === 'run_command');
    if (!tool) throw new Error('run_command not registered');
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
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: bigOutput(15_000) }), { identity: owner });
    const text = res.content[0].text;
    expect(text).toContain('…[truncated');
    expect(shownTailLength(text)).toBe(10_000);
  });

  it('unset outputCap reproduces the default 60000-byte cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    const under = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: bigOutput(15_000) }), { identity: owner });
    expect(under.content[0].text).not.toContain('…[truncated'); // below the 60000 default: untouched
    const over = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: bigOutput(65_000) }), { identity: owner });
    const text = over.content[0].text;
    expect(text).toContain('…[truncated');
    expect(shownTailLength(text)).toBe(60_000);
  });

  it('outputCap also bounds the background process rolling buffer', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const started = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: bigOutput(15_000), background: true }), { identity: owner });
    const id = /Started background process (\S+):/.exec(started.content[0].text)?.[1];
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500)); // let the short-lived child finish and flush its output
    const out = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'read_process_output', { id, all: true }), { identity: owner });
    expect(out.content[0].text.length).toBeLessThanOrEqual(10_000 + '\n[exited 0]'.length);
  });
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
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: `node -e "process.stdout.write('€'.repeat(70000))"` }), { identity: owner });
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
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: 'sleep 32' }), { identity: owner });
    expect(res.content[0].text).toContain('[killed: timeout]');
  }, 40_000);

  it('unset commandTimeoutMs keeps the (larger) default: the same duration finishes normally', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: 'sleep 32' }), { identity: owner });
    expect(res.content[0].text).not.toContain('[killed: timeout]');
    expect(res.content[0].text).toContain('[exit 0]');
  }, 40_000);
});
