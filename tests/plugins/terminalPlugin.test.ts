import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPathAllowed } from '../../src/plugins/pathGuard.js';
import { createWorkspacePathView } from '../../src/plugins/pathView.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithApprovedCall, runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ENVIRONMENT_CONTROL_METHODS, SITE_ENVIRONMENT_CONTROL_METHODS } from '../../src/plugins/environmentTypes.js';
import { ungrantedPluginTools } from '../../src/plugins/toolGrants.js';
import { processRegistry } from '../../src/brain/processRegistry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, conversation: 'own' };
const terminalModule = await import(resolve(repoRoot, 'plugins/terminal/index.mjs')) as {
  mapReportedCwd(reported: string, prepared: { workspace?: { path: string } | null }, assertAllowed: (path: string) => string, workspacePathView?: boolean): string;
  getDefaultBashTimeoutMs(env?: Record<string, string | undefined>): number;
  getMaxBashTimeoutMs(env?: Record<string, string | undefined>): number;
};

const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('t', params);
};

// The process registry is a module-level singleton shared across every test in this run. Background
// commands (and any handle a test registers) survive into later tests and other files, so clear it after
// each test. The sweep is AWAITED: a kill confirms the plugin's own teardown asynchronously, so a hook
// that returns first lets a still-dying process run into the next test. `killWhere` also drops handles
// that already exited and reports an unconfirmed kill instead of throwing out of the hook.
const sweepRegistry = () => processRegistry.killWhere(() => true);
afterEach(async () => { await sweepRegistry(); });

// Every describe's beforeAll creates ONE shared dir for all its tests, so the dirs must survive until the
// whole file is done — and they must outlive the afterEach that kills the registry's background processes:
// those commands run with the dir as their cwd, so deleting it under a still-running process would break
// the run nondeterministically. Removing them here, after every test (and its kill hook) has settled, is
// the only safe point.
let dirs: string[] = [];
const allDirs = new Set<string>();
const removeDirs = () => {
  for (const p of dirs) rmSync(p, { recursive: true, force: true });
  dirs = [];
};
const cleanupDirs = async () => { await sweepRegistry(); removeDirs(); };
// On `exit` nothing asynchronous can still run, so the sweep's synchronous half (the process-group kill)
// is all that lands and the dirs must go in the same tick.
const cleanupDirsOnExit = () => { void sweepRegistry(); removeDirs(); };
const tmpDir = (tag: string): string => {
  const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`));
  dirs.push(p);
  allDirs.add(p);
  return p;
};
/** A command that just occupies the foreground for a while. `sleep N` with N >= 2 as the first command
 *  of a line is refused as a polling pattern (see the sleep-rejection tests), so every test that needs a
 *  long-running FOREGROUND process spells the wait out instead. Background runs may still use `sleep`. */
const idle = (seconds: number): string => `node -e "setTimeout(() => {}, ${seconds * 1000})"`;
const markerExecutable = (dir: string, name: string, marker: string): string => {
  const executable = join(dir, name);
  writeFileSync(executable, `#!/bin/sh\nprintf reached > ${JSON.stringify(marker)}\n`);
  chmodSync(executable, 0o755);
  return executable;
};
process.once('exit', cleanupDirsOnExit);
afterAll(async () => {
  process.off('exit', cleanupDirsOnExit);
  await cleanupDirs();
  expect([...allDirs].filter(existsSync), 'terminal plugin tests left temporary directories behind').toEqual([]);
});

describe('terminal plugin', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term');
  });

  it('registers Bash + background process tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['Bash', 'KillProcess', 'ListProcesses', 'ProcessOutput']);
  });

  it('exposes one canonical argument per Bash concept plus unique Elowen features', () => {
    const bash = reg.tools.find((tool) => tool.name === 'Bash') as unknown as {
      parameters: { properties: Record<string, { description?: string; maximum?: number }>; additionalProperties?: boolean };
    };
    expect(Object.keys(bash.parameters.properties).sort()).toEqual([
      'backgroundMode', 'command', 'cwd', 'dangerouslyDisableSandbox', 'description', 'run_in_background', 'timeout',
    ]);
    expect(bash.parameters.properties).not.toHaveProperty('background');
    expect(bash.parameters.properties).not.toHaveProperty('timeout_seconds');
    expect(bash.parameters.properties.timeout.maximum).toBe(600_000);
    expect(bash.parameters.properties.timeout.description).toMatch(/milliseconds/i);
    expect(bash.parameters.additionalProperties).toBe(false);
  });

  it('tells the model how to run several commands: parallel calls, && for dependent, no newlines', () => {
    const bash = reg.tools.find((tool) => tool.name === 'Bash') as unknown as { description: string };
    expect(bash.description).toContain('if the commands are independent and can run in parallel, make multiple Bash tool calls in a single message');
    expect(bash.description).toContain("use a single Bash call with '&&' to chain them together");
    expect(bash.description).toContain('DO NOT use newlines to separate commands (newlines are ok in quoted strings).');
  });

  it('does not send the model to mkdir a parent directory that Write now creates itself', () => {
    const bash = reg.tools.find((tool) => tool.name === 'Bash') as unknown as { description: string };
    expect(bash.description).not.toContain('Write refuses a missing directory');
    expect(bash.description).toContain("Write and Edit create a file's missing parent directories themselves");
  });

  it('maps a workspace guest cwd through the real workspace PathView contract', () => {
    const workspace = join(dir, 'workspace-host');
    mkdirSync(join(workspace, 'nested'), { recursive: true });
    const pathView = createWorkspacePathView({
      accountUserId: 1, workspaceId: 'ws_terminal_cwd', projectId: 1, path: workspace,
    });
    const checked: string[] = [];
    const mapped = terminalModule.mapReportedCwd('/workspace/nested', { workspace: { path: workspace } }, (path) => {
      checked.push(path);
      return pathView.resolve(path);
    }, true);
    expect(mapped).toBe(realpathSync(join(workspace, 'nested')));
    expect(checked).toEqual(['nested']);
  });

  it('fails closed before spawn when sandbox bypass is requested, while false is a no-op', async () => {
    const marker = join(dir, 'sandbox-bypass-marker');
    const refused = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: `touch ${JSON.stringify(marker)}`,
      dangerouslyDisableSandbox: true,
    }), { identity: owner });
    expect(refused.content[0].text).toMatch(/sandbox bypass.*refused/i);
    expect(existsSync(marker)).toBe(false);

    const allowed = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'echo sandboxed',
      dangerouslyDisableSandbox: false,
    }), { identity: owner });
    expect(allowed.content[0].text).toContain('sandboxed');
  });

  it('runs a command in an allowed repo (default cwd = first root)', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'echo terminaltest' }), { identity: owner });
    expect(res.content[0].text).toContain('terminaltest');
    // The `[exit N]` marker in the TEXT is framing for the model and must stay; the display path reads
    // the exit code structurally from details.
    expect(res.content[0].text).toContain('[exit 0]');
    expect(res.details.exitCode).toBe(0);
  });

  it('reports a non-zero exit code structurally in details as well as in the model-facing text', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'exit 3' }), { identity: owner });
    expect(res.content[0].text).toContain('[exit 3]');
    expect(res.details.exitCode).toBe(3);
  });

  it('a turn bound to a project defaults the cwd to that project path, not the first root', async () => {
    const bound = join(dir, 'bound');
    mkdirSync(bound, { recursive: true });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'pwd' }), { identity: owner, workDir: bound });
    expect(res.content[0].text).toContain(join(realpathSync(dir), 'bound'));
    expect(res.content[0].text).toContain('[exit 0]');
  });

  it('persists a successful foreground cwd per session', async () => {
    const sub = join(dir, 'persistent-subdir');
    mkdirSync(sub, { recursive: true });
    const scope = { identity: owner, sessionId: 'brain-cwd-persist' };
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'cd persistent-subdir' }), scope);
    const next = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'pwd' }), scope);
    expect(next.content[0].text).toContain(realpathSync(sub));
  });

  it('persists cwd only after a normal zero exit, never background, nonzero, or timeout', async () => {
    const sub = join(dir, 'nonpersistent-subdir');
    mkdirSync(sub, { recursive: true });
    const scope = { identity: owner, sessionId: 'brain-cwd-nonpersist' };
    const expectDefaultCwd = async () => {
      const next = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'pwd' }), scope);
      expect(next.content[0].text).toContain(realpathSync(dir));
      expect(next.content[0].text).not.toContain(realpathSync(sub));
    };

    const bg = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'cd nonpersistent-subdir; sleep 20', run_in_background: true,
    }), scope);
    expect(bg.content[0].text).toContain('Started background process');
    await expectDefaultCwd();

    const failed = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'cd nonpersistent-subdir; exit 7',
    }), scope);
    expect(failed.content[0].text).toContain('[exit 7]');
    await expectDefaultCwd();

    // In an interactive conversation the deadline moves the run to the background instead of killing it;
    // either way the run never finished a zero exit here, so its cwd must not be persisted.
    const timedOut = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'cd nonpersistent-subdir; sleep 20', timeout: 100,
    }), scope);
    const movedId = /Moved to background as process (\S+):/.exec(timedOut.content[0].text)?.[1];
    expect(movedId, timedOut.content[0].text).toBeTruthy();
    await expectDefaultCwd();
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'KillProcess', { id: movedId! }), scope);
  }, 20_000);

  it('refuses a cwd outside the allowed roots', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'echo x', cwd: '/etc' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('admin all-access runs with no roots (defaults to process cwd)', async () => {
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', { command: 'echo adminok' }), { identity: owner });
    expect(res.content[0].text).toContain('adminok');
  });

  it('refuses a blocking restart of its own daemon before the command can execute', async () => {
    const reached = join(dir, 'blocking-restart-executed');
    const fakeSudo = markerExecutable(dir, 'sudo', reached);

    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `${fakeSudo} systemctl restart elowen-daemon elowen-web`,
    }), { identity: owner });

    expect(res.content[0].text).toMatch(/refused.*elowen restart all/i);
    expect(existsSync(reached)).toBe(false);
  });

  it('allows the standalone non-blocking self-restart form to execute', async () => {
    const reached = join(dir, 'nonblocking-restart-executed');
    const fakeSudo = markerExecutable(dir, 'sudo', reached);

    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `${fakeSudo} systemctl restart --no-block elowen-daemon elowen-web`,
    }), { identity: owner });

    expect(res.content[0].text).toContain('[exit 0]');
    expect(existsSync(reached)).toBe(true);
  });

  it('does not mistake a quoted compound SSH restart for a local self-restart', async () => {
    const reached = join(dir, 'remote-restart-executed');
    const fakeSsh = markerExecutable(dir, 'ssh', reached);

    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `${fakeSsh} prod 'cd /var/www/elowen && sudo systemctl restart elowen-daemon'`,
    }), { identity: owner });

    expect(res.content[0].text).toContain('[exit 0]');
    expect(existsSync(reached)).toBe(true);
  });

  it('allows systemctl remote-host restarts to execute', async () => {
    const reached = join(dir, 'host-restart-executed');
    const fakeSystemctl = markerExecutable(dir, 'systemctl', reached);

    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `${fakeSystemctl} --host prod restart elowen-daemon`,
    }), { identity: owner });

    expect(res.content[0].text).toContain('[exit 0]');
    expect(existsSync(reached)).toBe(true);
  });

  it('refuses a blocking self-restart behind a pipeline and env wrapper', async () => {
    const reached = join(dir, 'wrapped-restart-executed');
    const fakeSudo = markerExecutable(dir, 'sudo', reached);

    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `printf ready | env ${fakeSudo} systemctl restart elowen-daemon`,
    }), { identity: owner });

    expect(res.content[0].text).toMatch(/refused.*elowen restart all/i);
    expect(existsSync(reached)).toBe(false);
  });

  it('refuses the systemctl restart family before any local command path executes', async () => {
    for (const action of ['restart', 'try-restart', 'reload-or-restart', 'reload-or-try-restart']) {
      const reached = join(dir, `restart-family-${action}`);
      const fakeSudo = markerExecutable(dir, 'sudo', reached);
      const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
        command: `${fakeSudo} systemctl ${action} elowen-daemon`,
      }), { identity: owner });
      expect(res.content[0].text, action).toMatch(/refused.*elowen restart all/i);
      expect(existsSync(reached), action).toBe(false);
    }
  });

  it('refuses local self-restarts inside command substitutions before the substituted path executes', async () => {
    const reached = join(dir, 'substitution-restart-executed');
    const fakeSystemctl = markerExecutable(dir, 'systemctl', reached);
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `printf '%s' "$(${fakeSystemctl} reload-or-restart elowen-daemon)"`,
    }), { identity: owner });

    expect(res.content[0].text).toMatch(/refused.*elowen restart all/i);
    expect(existsSync(reached)).toBe(false);
  });

  it.each(['bash', 'sh'])('refuses a blocking self-restart hidden behind local %s -c', async (shell) => {
    const reached = join(dir, `${shell}-c-restart-executed`);
    const fakeSystemctl = markerExecutable(dir, 'systemctl', reached);
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `${shell} -c '${fakeSystemctl} restart elowen-daemon'`,
    }), { identity: owner });

    expect(res.content[0].text).toMatch(/refused.*elowen restart all/i);
    expect(existsSync(reached)).toBe(false);
  });

  it('refuses a blocking self-restart inside local process substitution', async () => {
    const reached = join(dir, 'process-substitution-restart-executed');
    const fakeSystemctl = markerExecutable(dir, 'systemctl', reached);
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'Bash', {
      command: `cat <(${fakeSystemctl} restart elowen-daemon)`,
    }), { identity: owner });

    expect(res.content[0].text).toMatch(/refused.*elowen restart all/i);
    expect(existsSync(reached)).toBe(false);
  });

  it('a user with no repos cannot run anything', async () => {
    const res = await runWithPolicy(userPolicy([]), () => runTool(reg, 'Bash', { command: 'echo nope' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  // WHO may run a shell is no longer decided inside this plugin. The tools carried their own owner gate
  // until the permission model was unified; now the account's grant decides, exactly as it does for every
  // other tool, and it decides BEFORE the tool is ever composed into the session.
  //
  // That makes one manifest line load-bearing: `userGrantable`. Without it `isPluginAllowedForUser` treats
  // the plugin as ungated and hands a shell — the whole host, secrets included — to every account on the
  // daemon. It is the only thing standing between "grant required" and "everyone", so pin it mechanically
  // against the real manifest rather than a fixture.
  it('keeps the shell behind a grant: the manifest must stay userGrantable', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../plugins/terminal/elowen-plugin.json', import.meta.url), 'utf8'),
    ) as { userGrantable?: boolean; provides?: { tools?: string[] }; configSchema?: Array<{ key?: string; hint?: string }> };
    expect(manifest.userGrantable).toBe(true);
    // Every tool this plugin ships rides on that one flag, so none of them may be added without it.
    expect(manifest.provides?.tools).toEqual(['Bash', 'ListProcesses', 'ProcessOutput', 'KillProcess']);
    const limitHint = manifest.configSchema?.find((field) => field.key === 'maxBackgroundProcesses')?.hint ?? '';
    expect(limitHint).not.toMatch(/until one is killed/i);
    expect(limitHint).toMatch(/exits|finishes|collected/i);
  });

  it('withholds every terminal tool from an account without the grant, and hands them over with it', () => {
    const registry = new PluginRegistry();
    for (const tool of ['Bash', 'ListProcesses', 'ProcessOutput', 'KillProcess']) registry.toolOwner.set(tool, 'terminal');
    registry.userGrantable.add('terminal');
    const ungranted = { is_admin: false, granted_plugins: [] };
    expect(ungrantedPluginTools(ungranted, registry).sort())
      .toEqual(['Bash', 'KillProcess', 'ListProcesses', 'ProcessOutput']);
    expect(ungrantedPluginTools({ is_admin: false, granted_plugins: ['terminal'] }, registry)).toEqual([]);
    // An administrator needs no grant — they already reach every byte on the box through the file tools.
    expect(ungrantedPluginTools({ is_admin: true, granted_plugins: [] }, registry)).toEqual([]);
  });
});

describe('terminal plugin — live foreground output (onUpdate streaming)', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term-live');
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
  beforeAll(() => { dir = tmpDir('term-cap'); });
  const bigOutput = (n: number) => `node -e "process.stdout.write('a'.repeat(${n}))"`;
  /** The kept output either side of the "…[truncated: …]" banner, which now sits in the MIDDLE: the head
   *  runs from the `(cwd: …)` line to the banner, the tail from the banner to the trailing `[exit N]`.
   *  Their sum is what the configured cap bounds. */
  const shownParts = (text: string): { head: number; tail: number } => {
    const marker = text.indexOf('…[truncated');
    if (marker < 0) throw new Error('not truncated');
    const bodyStart = text.indexOf('\n', text.indexOf('(cwd: ')) + 1;
    const tailStart = text.indexOf('\n', marker) + 1;
    let end = text.lastIndexOf('[exit ');
    if (text[end - 1] === '\n') end -= 1; // drop the separator newline the plugin inserts before [exit N]
    return { head: marker - 1 - bodyStart, tail: end - tailStart }; // -1: the newline before the banner
  };

  it('a configured outputCap (min-clamped 10000) truncates output that the default 60000 would not', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000) }), { identity: owner });
    const text = res.content[0].text;
    expect(text).toContain('…[truncated');
    const { head, tail } = shownParts(text);
    // Both ends survive and are the same size. A tail-only cut kept 10000 bytes of the END and threw away
    // the command's echo and everything printed before the bulk.
    // Halved to the byte, give or take the odd byte an odd budget cannot split evenly.
    expect(Math.abs(head - tail)).toBeLessThanOrEqual(1);
    expect(head).toBeGreaterThan(4_000);
    // The cap bounds the WHOLE result — echo, banner and exit marker included — because a result over the
    // operator's inline-result threshold is spilled and replaced by a HEAD-ONLY preview, which would throw
    // away the tail this cut exists to keep.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(10_000);
    // The banner names the ORIGINAL size, not the size of what survived.
    expect(text).toContain('of 14.6KB');
  });

  it('unset outputCap reproduces the default 60000-byte cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    const under = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000) }), { identity: owner });
    expect(under.content[0].text).not.toContain('…[truncated'); // below the 60000 default: untouched
    const over = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(65_000) }), { identity: owner });
    const text = over.content[0].text;
    expect(text).toContain('…[truncated');
    const { head, tail } = shownParts(text);
    expect(Math.abs(head - tail)).toBeLessThanOrEqual(1);
    // Regression: with the budget applied to the output alone, a truncated result at the 60 kB default
    // overshot 60 kB by its own framing — and `toolResultInlineBytes` also defaults to 60 kB, so every
    // truncated command was spilled to disk and shown as a head-only preview. The feature defeated itself
    // on the settings almost everyone runs.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(head + tail).toBeGreaterThan(59_000);
  });

  // One enormous line terminated by a newline used to lose its whole tail: the only newline inside the
  // tail budget was the trailing one, so the line-aligned cut started the tail at the very end and
  // head+tail silently degraded back to head-only.
  it('keeps a tail for one oversized line that ends in a newline', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const command = 'node -e "process.stdout.write(\'S\' + \'x\'.repeat(19998) + \'E\\n\')"';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command }), { identity: owner });
    const text = res.content[0].text;
    const { head, tail } = shownParts(text);

    expect(head).toBeGreaterThan(0);
    expect(tail).toBeGreaterThan(0);
    expect(head + tail).toBeLessThanOrEqual(10_000);
  });

  // A raw byte cut through multi-byte text used to decode each half on its own, so the character sitting
  // on the seam came back as U+FFFD on both sides.
  it('never cuts a multi-byte character in half', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    // One line of 3-byte characters, 15000 bytes total. Both cut points (5000 and 10000) fall INSIDE a
    // character rather than between two, which is the case a byte offset gets wrong.
    const command = 'node -e "process.stdout.write(\'\\u5b57\'.repeat(5000))"';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command }), { identity: owner });
    const text = res.content[0].text;

    expect(text).toContain('…[truncated');
    expect(text).not.toContain('\uFFFD');
  });

  it('caps the complete foreground result when multibyte command framing alone exceeds the budget', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const longComment = '€'.repeat(9_000); // 9000 characters but 27000 UTF-8 bytes
    // The marker text is encoded in the command, not repeated verbatim in its echo, so these assertions
    // prove both ends of the PROCESS OUTPUT survived rather than merely finding them in the framing.
    const command = `printf '\\110\\105\\101\\104\\055\\117\\125\\124\\120\\125\\124'; `
      + `printf %020000d 0; printf '\\124\\101\\111\\114\\055\\117\\125\\124\\120\\125\\124' # ${longComment}`;
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command }), { identity: owner });
    const text = res.content[0].text;

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(10_000);
    expect(text).toContain('HEAD-OUTPUT');
    expect(text).toContain('TAIL-OUTPUT');
    expect(text).toContain('[exit 0]');
    expect(text).not.toContain('\uFFFD');
  });

  // The rolling buffer used to drop from the FRONT at twice the cap, so anything past that arrived here
  // already missing its beginning — the head half of a head+tail cut would then show the middle of the
  // run and call it the start. The buffer now drops from the middle too, and counts what it lost so the
  // banner can state the run's real size rather than the size of what survived.
  it('keeps the true beginning of a run far larger than the buffer, and says how much was lost', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    // 300 kB, far past the 20 kB buffer limit, with a distinct first and last line.
    const command = 'node -e "process.stdout.write(\'FIRST-LINE\\n\' + \'x\'.repeat(300000) + \'\\nLAST-LINE\\n\')"';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command }), { identity: owner });
    // Read past the `$ <command>` echo, which repeats both marker strings verbatim.
    const full = res.content[0].text;
    const body = full.slice(full.indexOf('\n', full.indexOf('(cwd: ')) + 1);

    expect(body).toContain('FIRST-LINE');
    expect(body).toContain('LAST-LINE');
    expect(body.indexOf('FIRST-LINE')).toBeLessThan(body.indexOf('…[truncated'));
    expect(body.indexOf('LAST-LINE')).toBeGreaterThan(body.indexOf('…[truncated'));
    // ~293 KB: the buffer's own drops are counted into the total, not silently excluded from it.
    expect(body).toMatch(/of 29\d(\.\d)?KB;/);
    const { head, tail } = shownParts(full);
    expect(head + tail).toBeLessThanOrEqual(10_000);
  });

  it('does not corrupt a multibyte character when the other stream writes between its bytes', async () => {
    // stdout and stderr had ONE shared StringDecoder. It holds the bytes of an incomplete UTF-8 character
    // until the next write completes it — and the next write can come from the other stream, so a
    // character split across stdout chunks was finished with stderr's bytes and both came out mojibake.
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    // Writes the three bytes of € to stdout one at a time, with a stderr write wedged in between.
    const command = 'node -e "'
      + 'const b=Buffer.from(\'€\',\'utf8\');'
      + 'process.stdout.write(b.subarray(0,1));'
      + 'process.stderr.write(\'ERR\');'
      + 'process.stdout.write(b.subarray(1));'
      + 'process.stdout.write(\'|DONE\')"';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command }), { identity: owner });
    const body = res.content[0].text.slice(res.content[0].text.indexOf('(cwd: '));

    expect(body).toContain('€');
    expect(body).toContain('ERR');
    expect(body).not.toContain('\uFFFD');
  });

  it('measures the rolling buffer in bytes, so non-Latin output cannot hold three times the cap', async () => {
    // The buffer compared `output.length` — UTF-16 code units — against a cap the operator sets in kB and
    // the final cut applies in bytes, so a run printing multibyte text kept far more than it was given.
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    // 45 kB of three-byte characters: 15000 code units, comfortably under a character-based 20 kB limit.
    const command = 'node -e "process.stdout.write(\'\\u20ac\'.repeat(15000))"';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command }), { identity: owner });
    const text = res.content[0].text;

    expect(text).toContain('…[truncated');
    expect(text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(10_000);
    // …and the banner still names the run's real size rather than what the buffer happened to keep.
    expect(text).toContain('of 43.9KB');
  });

  it('outputCap also bounds the background process rolling buffer', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const scope = { identity: owner, sessionId: 'brain-terminal-output-cap' };
    const started = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000), run_in_background: true }), scope);
    const id = /Started background process (\S+):/.exec(started.content[0].text)?.[1];
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500)); // let the short-lived child finish and flush its output
    const out = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'ProcessOutput', { id, all: true }), scope);
    expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(10_000 + 200 + '\n[exited 0]'.length);
  });

  it('bounds that buffer in BYTES even when its character count is below the cap', async () => {
    // ProcessOutput hands the raw buffer to the model. A cheap `output.length > outputCap` guard skipped
    // the byte count entirely, so 9000 three-byte characters sat below a 10000-character threshold while
    // returning 27 kB of context.
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { outputCap: 10_000 } },
    });
    const scope = { identity: owner, sessionId: 'brain-terminal-output-cap-bytes' };
    const command = 'node -e "process.stdout.write(\'\\u20ac\'.repeat(9000))"';
    const started = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command, run_in_background: true }), scope);
    const id = /Started background process (\S+):/.exec(started.content[0].text)?.[1];
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    const out = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'ProcessOutput', { id, all: true }), scope);

    expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(10_000 + 200 + '\n[exited 0]'.length);
    expect(out.content[0].text).toContain('\u20ac');
    expect(out.content[0].text).not.toContain('\uFFFD'); // cut on a character boundary, not mid-character
    expect(out.content[0].text).toContain('dropped from the beginning');
  });

  it('describes all=true as the whole retained tail, never the whole output from process start', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    const output = reg.tools.find((tool) => tool.name === 'ProcessOutput') as unknown as { description: string };
    expect(output.description).toMatch(/whole retained buffer/i);
    expect(output.description).toMatch(/tail/i);
    expect(output.description).not.toMatch(/whole buffer from process start/i);
  });
});

// A truncated result used to be the only copy of the run: the middle was dropped and unrecoverable. The
// complete output now goes to the host's tool-result spill store — the same directory the context cleaner
// uses, so the session can Read it back and deleting the conversation removes it.
describe('terminal plugin — the full output of a truncated foreground run', () => {
  let dir: string;
  let home: string;
  let previousHome: string | undefined;
  beforeAll(() => {
    dir = tmpDir('term-spill');
    // The spill root is derived from HOME (dataDir). Point it at a temp dir so the test writes nowhere
    // near the real instance's tool-results, and restore it before any later describe runs.
    home = tmpDir('term-spill-home');
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const cappedReg = () => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
    config: { terminal: { outputCap: 10_000 } },
  });
  const bigOutput = (n: number) => `node -e "process.stdout.write('a'.repeat(${n}))"`;
  const savedPath = (text: string): string => {
    const match = /saved to (\S+\.txt)/.exec(text);
    if (!match) throw new Error(`no stored path in the result: ${text.slice(0, 400)}`);
    return match[1];
  };
  const spillRoot = () => join(home, '.config', 'elowen', 'tool-results');
  const spillDirs = () => (existsSync(spillRoot()) ? readdirSync(spillRoot()).sort() : []);

  it('stores the whole output, names it with its size, and keeps the inline excerpt inside the cap', async () => {
    const reg = await cappedReg();
    // Deliberately long: the stored path goes INTO the truncation banner, so the excerpt's budget has to
    // pay for it. Budgeting only the fixed banner reserve lands within a byte of the cap for a short id
    // and overshoots it here, which is what makes the cap assertion below pin that subtraction.
    const sessionId = `brain-terminal-spill-over-${'x'.repeat(60)}`;
    // Over the inline cap, under the rolling buffer's own 2× limit — the range where the run is
    // reproduced byte for byte instead of losing its middle.
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000) }), { identity: owner, sessionId });
    const text = res.content[0].text;

    expect(text).toContain('…[truncated');
    const stored = savedPath(text);
    // The middle is no longer lost: every byte the run produced is in the file, not just the two ends.
    expect(readFileSync(stored, 'utf8')).toBe('a'.repeat(15_000));
    expect(text).toContain('full output (14.6KB)');
    expect(text).toMatch(/read it with the Read tool/);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(10_000);
  });

  // The promise the banner makes — "read it with the Read tool" — only holds if the ordinary path guard
  // admits that exact path for THIS conversation and no other.
  it('lands under the spill root the owning session may read, and no other session may', async () => {
    const reg = await cappedReg();
    const sessionId = 'brain-terminal-spill-guard';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(30_000) }), { identity: owner, sessionId });
    const stored = savedPath(res.content[0].text);

    expect(stored.startsWith(realpathSync(join(spillRoot(), sessionId)) + '/')).toBe(true);
    expect(runWithPolicy(userPolicy([dir]), () => assertPathAllowed(stored), { identity: owner, sessionId })).toBe(stored);
    expect(() => runWithPolicy(userPolicy([dir]), () => assertPathAllowed(stored), { identity: owner, sessionId: 'brain-someone-else' }))
      .toThrow(/not allowed/);
  });

  it('writes nothing when the result fits inline', async () => {
    const reg = await cappedReg();
    const sessionId = 'brain-terminal-spill-under';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(5_000) }), { identity: owner, sessionId });

    expect(res.content[0].text).not.toContain('…[truncated');
    expect(res.content[0].text).not.toContain('saved to');
    expect(existsSync(join(spillRoot(), sessionId))).toBe(false);
  });

  // Past twice the cap the rolling buffer has already dropped bytes mid-run, so the file is everything
  // that survived rather than everything the process wrote — and it says so instead of claiming to be the
  // full output.
  it('calls the stored file retained, not full, once the mid-run buffer has dropped bytes', async () => {
    const reg = await cappedReg();
    const sessionId = 'brain-terminal-spill-huge';
    const command = 'node -e "process.stdout.write(\'FIRST-LINE\\n\' + \'x\'.repeat(300000) + \'\\nLAST-LINE\\n\')"';
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command }), { identity: owner, sessionId });
    const text = res.content[0].text;

    expect(text).toContain('retained output (');
    expect(text).not.toContain('full output (');
    const contents = readFileSync(savedPath(text), 'utf8');
    expect(contents).toContain('FIRST-LINE');
    expect(contents).toContain('LAST-LINE');
    expect(contents).toContain('was dropped from the middle of this output while the process ran');
    // Far more than the inline excerpt could carry — the point of storing it at all.
    expect(contents.length).toBeGreaterThan(19_000);
  });

  // Worker and cron runs own no conversation, so there is no spill directory to write into. The run must
  // still report what it did.
  it('still returns a truncated result outside a prompt turn, without storing anything', async () => {
    const reg = await cappedReg();
    const before = spillDirs();
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: bigOutput(15_000) }), { identity: owner });

    expect(res.content[0].text).toContain('…[truncated');
    expect(res.content[0].text).not.toContain('saved to');
    expect(spillDirs()).toEqual(before); // no conversation, so no new spill directory
  });
});

describe('terminal plugin — atomic background capacity', () => {
  let dir: string;
  beforeAll(() => { dir = tmpDir('term-capacity'); });

  const prepared = (command: string, cwd: string) => ({
    mode: 'direct', cwd, displayCwd: cwd, home: dir, roots: [dir], workspace: null,
    launch: { type: 'shell', command, env: { ...process.env } },
    lease: { id: 'lease', accountUserId: 1, workspaceId: null, homeGeneration: null, heartbeat() {}, release() {} },
    sanitizeOutput: (text: unknown) => String(text),
  });

  it('reserves the last slot before async prepare so concurrent starts cannot oversubscribe it', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { maxBackgroundProcesses: 1 } },
    });
    let releasePrepare!: () => void;
    let markPreparing!: () => void;
    const preparing = new Promise<void>((resolvePreparing) => { markPreparing = resolvePreparing; });
    const gate = new Promise<void>((resolveGate) => { releasePrepare = resolveGate; });
    let prepares = 0;
    reg.controls.set('sandbox', {
      ...Object.fromEntries([...ENVIRONMENT_CONTROL_METHODS, ...SITE_ENVIRONMENT_CONTROL_METHODS].map(name => [name, () => { throw new Error(`unexpected ${name}`); }])),
      workspaceRoots: () => [], resolveWorkspace: () => { throw new Error('unused'); },
      acquireDelegationLease: () => { throw new Error('unused'); }, workspacesFor: () => [], activeWorkspace: () => null,
      prepareExecution: async ({ command, cwd }: { command: { command: string }; cwd: string }) => {
        prepares += 1;
        markPreparing();
        await gate;
        return prepared(command.command, cwd);
      },
    } as never);
    reg.controlOwner.set('sandbox', 'sandbox');
    const scope = { identity: owner, sessionId: 'brain-capacity-atomic' };
    const first = runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'sleep 20', run_in_background: true,
    }), scope);
    await preparing;

    const refused = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'sleep 20', run_in_background: true,
    }), scope);
    expect(refused.content[0].text).toMatch(/too many background processes/);
    expect(prepares).toBe(1);

    releasePrepare();
    expect((await first).content[0].text).toContain('Started background process');
  });

  it('releases a reservation when prepare fails, so the next start can use the slot', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { maxBackgroundProcesses: 1 } },
    });
    let fail = true;
    reg.controls.set('sandbox', {
      ...Object.fromEntries([...ENVIRONMENT_CONTROL_METHODS, ...SITE_ENVIRONMENT_CONTROL_METHODS].map(name => [name, () => { throw new Error(`unexpected ${name}`); }])),
      workspaceRoots: () => [], resolveWorkspace: () => { throw new Error('unused'); },
      acquireDelegationLease: () => { throw new Error('unused'); }, workspacesFor: () => [], activeWorkspace: () => null,
      prepareExecution: async ({ command, cwd }: { command: { command: string }; cwd: string }) => {
        if (fail) { fail = false; throw new Error('prepare failed'); }
        return prepared(command.command, cwd);
      },
    } as never);
    reg.controlOwner.set('sandbox', 'sandbox');
    const scope = { identity: owner, sessionId: 'brain-capacity-release' };
    const failed = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'sleep 20', run_in_background: true,
    }), scope);
    expect(failed.content[0].text).toContain('prepare failed');

    const next = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'sleep 20', run_in_background: true,
    }), scope);
    expect(next.content[0].text).toContain('Started background process');
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
    dir = tmpDir('term-registry');
  });

  const inSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: owner, sessionId });

  const startBg = async (sessionId: string, command: string): Promise<string> => {
    const res = await inSession(sessionId, 'Bash', { command, run_in_background: true });
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
    const refused = await inSession(a, 'Bash', { command: 'sleep 30', run_in_background: true });
    expect(refused.content[0].text).toMatch(/too many background processes/);

    // killSession is async and reports the sweep: every one of the 16 stops CONFIRMED, none unresolved.
    await expect(processRegistry.killSession(a)).resolves.toEqual({ killed: 16, failed: [] });

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
    // Wait for the first write to be OBSERVABLE, not for a fixed pause to elapse: starting a node child
    // takes longer than 250 ms on a loaded host, and the read below then correctly reported "(no new
    // output)" against a test that had assumed otherwise. `output()` is the daemon's readAll, so waiting
    // on it leaves the tool's cursor exactly where the assertions need it.
    await vi.waitFor(() => expect(processRegistry.output(id)).toContain('one'));

    const first = await inSession(session, 'ProcessOutput', { id, block: false });
    expect(first.content[0].text).toContain('one');
    expect(first.content[0].text).not.toContain('two');
    expect(first.content[0].text).toContain('[still running]');
    // The daemon's own read (web/CLI panel) uses readAll: the whole buffer, cursor untouched.
    expect(processRegistry.output(id)).toBe('one\n');

    // Same again for the second write. The read itself blocks until the child exits, so this only has to
    // establish that 'two' was produced — never that a chosen number of milliseconds passed.
    await vi.waitFor(() => expect(processRegistry.output(id)).toContain('two'));
    const second = await inSession(session, 'ProcessOutput', { id });
    expect(second.content[0].text).toContain('two');
    expect(second.content[0].text).not.toContain('one'); // already consumed by the first read
    expect(second.content[0].text).toContain('[exited 0]');
    expect(processRegistry.list().find((p) => p.id === id)).toBeUndefined(); // final read collects the corpse
  }, 15_000);
});

describe('terminal plugin — direct-host process termination', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term-direct-kill');
  });

  it.skipIf(process.platform !== 'linux')('redacts the descendant-tracking token in command output', async () => {
    const result = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'env' }), {
      identity: owner, sessionId: 'brain-direct-token-redaction',
    });
    expect(result.content[0].text).toContain('ELOWEN_TERMINAL_PROCESS_TOKEN=[REDACTED]');
    expect(result.content[0].text).not.toMatch(/ELOWEN_TERMINAL_PROCESS_TOKEN=[a-f0-9]{48}/u);
  });

  it.skipIf(process.platform !== 'linux')('KillProcess also terminates descendants that created a new session', async () => {
    const session = 'brain-direct-descendant';
    const pidFile = join(dir, 'escaped.pid');
    const scope = { identity: owner, sessionId: session };
    const script = `const {spawn}=require('child_process'); const fs=require('fs');`
      + `const child=spawn('setsid',['sleep','30'],{stdio:'ignore'});`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setTimeout(()=>{},30000)`;
    const command = `node -e ${JSON.stringify(script)}`;
    const started = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command, run_in_background: true,
    }), scope);
    const id = /Started background process (\S+):/.exec(started.content[0].text)?.[1];
    expect(id).toBeTruthy();
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const escapedPid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(escapedPid, 0)).not.toThrow();

    try {
      const killed = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'KillProcess', { id }), scope);
      expect(killed.content[0].text).toContain(`Killed ${id}`);
      let alive = true;
      for (let i = 0; i < 100 && alive; i += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        try { process.kill(escapedPid, 0); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      try { process.kill(escapedPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15_000);
});

describe('terminal plugin — UTF-8 streaming', () => {
  let dir: string;
  beforeAll(() => { dir = tmpDir('term-utf8'); });

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

describe('terminal plugin — per-call Bash timeout', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term-calltimeout');
  });

  it('interprets canonical timeout in milliseconds', async () => {
    const started = Date.now();
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: idle(20), timeout: 100 }), { identity: owner });
    expect(res.content[0].text).toContain('[killed: timed out after 100ms]');
    expect(res.content[0].text).not.toContain('[exit null]');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('output produced before the millisecond deadline survives the kill', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'echo partial; sleep 20', timeout: 100 }), { identity: owner });
    expect(res.content[0].text).toContain('partial');
    expect(res.content[0].text).toContain('[killed: timed out after 100ms]');
  }, 20_000);

  it('keeps one millisecond timeout argument with a safe 10-minute ceiling', async () => {
    const tooLong = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'echo nope', timeout: 600_001,
    }), { identity: owner });
    expect(tooLong.content[0].text).toMatch(/timeout.*between 1 and 600000 milliseconds/i);
    const fast = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'echo milliseconds', timeout: 30_000,
    }), { identity: owner });
    expect(fast.content[0].text).toContain('milliseconds');
    expect(fast.content[0].text).toContain('[exit 0]');
  });

  it('defaults to the reference two-minute deadline with a ten-minute ceiling, and honours the env seams', () => {
    const { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } = terminalModule;
    expect(getDefaultBashTimeoutMs({})).toBe(120_000);
    expect(getMaxBashTimeoutMs({})).toBe(600_000);
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '5000' })).toBe(5_000);
    expect(getMaxBashTimeoutMs({ BASH_MAX_TIMEOUT_MS: '900000' })).toBe(900_000);
    // The ceiling is never allowed below the default, and garbage falls back rather than disabling either.
    expect(getMaxBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '800000' })).toBe(800_000);
    expect(getMaxBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '800000', BASH_MAX_TIMEOUT_MS: '10000' })).toBe(800_000);
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: 'soon' })).toBe(120_000);
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '0' })).toBe(120_000);

    // The model is told both numbers, in the description and on the parameter.
    const bash = reg.tools.find((t) => t.name === 'Bash') as unknown as {
      description: string; parameters: { properties: { timeout: { description: string; maximum: number } } };
    };
    expect(bash.description).toContain('defaults to 120000 (120s), and may not exceed 600000 (600s)');
    expect(bash.parameters.properties.timeout.maximum).toBe(600_000);
    expect(bash.parameters.properties.timeout.description).toContain('default 120000');
    // …and what the deadline actually does: it is how long the call waits, not a hard kill in a chat.
    expect(bash.parameters.properties.timeout.description).toContain('how long the call waits in the foreground');
    expect(bash.description).toContain('pass a longer `timeout`');
    expect(bash.description).toContain('Ctrl+B');
  });

  it('run_in_background ignores timeout and runtime-only legacy background conflicts safely', async () => {
    const scope = { identity: owner, sessionId: 'brain-term-bg-timeout' };
    const started = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'sleep 20', run_in_background: true, timeout: 100,
    }), scope);
    const id = /Started background process (\S+):/.exec(started.content[0].text)?.[1];
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(processRegistry.list().find((p) => p.id === id)?.running).toBe(true);

    const conflict = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'echo nope', run_in_background: true, background: false,
    }), scope);
    expect(conflict.content[0].text).toMatch(/run_in_background.*conflicts.*background/i);
  }, 20_000);
});

// Ctrl+B backgrounds a still-running foreground command: the plugin registers each foreground run as the
// transient `foreground` mode, and the daemon's detach control flips it to an ordinary `job` that keeps
// running and nudges the conversation on exit — the exact lifecycle Bash(run_in_background=true) already has.
describe('terminal plugin — foreground detach (Ctrl+B backgrounds a running command)', () => {
  let reg: PluginRegistry;
  let dir: string;
  // A real operator identity carries elowenUserId; the plugin captures principal `elowen:<id>` at spawn,
  // which is what the daemon's detach control matches on.
  const uidOwner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' };
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term-detach');
  });
  // The exit listener is a singleton on the shared registry; reset it so a test's counter never leaks.
  afterEach(() => { processRegistry.setExitListener(() => {}); });

  const control = () => {
    const c = reg.controls.get('terminal');
    if (!c) throw new Error('terminal control not registered');
    return c as unknown as {
      detachForeground: (i: { sessionId: string; principal: string }) => { detached: number };
      killForeground: (i: { sessionId: string; principal: string }) => { killed: number };
    };
  };
  const inSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: uidOwner, sessionId });
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('registers a foreground handle while running and removes it on completion with no nudge', async () => {
    const session = 'brain-fg-plain';
    let nudged = 0;
    processRegistry.setExitListener(() => { nudged += 1; });
    const p = inSession(session, 'Bash', { command: `node -e "setTimeout(() => process.stdout.write('done'), 400)"` });
    await settle(150);
    const live = processRegistry.listForSession(session);
    expect(live.map((x) => x.completionMode)).toEqual(['foreground']);
    const res = await p;
    expect(res.content[0].text).toContain('done');
    expect(res.content[0].text).toContain('[exit 0]');
    expect(processRegistry.listForSession(session)).toHaveLength(0); // removed on completion
    expect(nudged).toBe(0); // a foreground command that finished on its own never wakes the conversation
  }, 15_000);

  it('detach moves the running command to the background as a job, then nudges on its exit', async () => {
    const session = 'brain-fg-detach';
    let nudgedId = '';
    processRegistry.setExitListener((info) => { nudgedId = info.id; });
    const p = inSession(session, 'Bash', { command: `node -e "console.log('early'); setTimeout(() => console.log('late'), 1200)"` });
    await settle(300); // 'early' printed, still running
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 1 });
    const res = await p;
    const id = /Moved to background as process (\S+):/.exec(res.content[0].text)?.[1];
    expect(id).toBeTruthy();
    const listed = processRegistry.listForSession(session).find((x) => x.id === id);
    expect(listed?.completionMode).toBe('job'); // now an ordinary background job
    expect(listed?.running).toBe(true);
    const out = await inSession(session, 'ProcessOutput', { id: id!, all: true });
    expect(out.content[0].text).toContain('early');
    await settle(1500); // let the detached process finish
    expect(nudgedId).toBe(id); // the detached run's exit wakes the conversation, like Bash(run_in_background)
  }, 15_000);

  it('tells a detached run’s FIRST incremental read that its middle was dropped', async () => {
    // The notice was gated on `all`, but the first incremental read of a detached run starts at offset
    // zero and returns the whole surviving buffer — so a head and a tail with 300 kB missing between them
    // came back silently glued, reading as one continuous run that never happened.
    const session = 'brain-fg-seam';
    const command = 'node -e "process.stdout.write(\'FIRST\\n\' + \'x\'.repeat(300000) + \'\\nLAST\\n\');'
      + 'setTimeout(() => {}, 1500)"';
    const p = inSession(session, 'Bash', { command });
    await settle(400); // the bulk is printed and the rolling buffer has dropped its middle
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 1 });
    const res = await p;
    const id = /Moved to background as process (\S+):/.exec(res.content[0].text)?.[1];
    expect(id).toBeTruthy();

    // No `all`: the default incremental read, which is what a model actually calls.
    const out = await inSession(session, 'ProcessOutput', { id: id! });
    expect(out.content[0].text).toContain('was dropped from the middle');

    // …and a later read that starts AFTER the seam must not claim a loss it does not show.
    const again = await inSession(session, 'ProcessOutput', { id: id! });
    expect(again.content[0].text).not.toContain('was dropped from the middle');
  }, 15_000);

  it('detaching cancels the deadline: the command survives past its per-call timeout', async () => {
    const session = 'brain-fg-deadline';
    const p = inSession(session, 'Bash', { command: idle(10), timeout: 2_000 }); // would be killed at 2s
    await settle(500);
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 1 });
    const res = await p;
    const id = /Moved to background as process (\S+):/.exec(res.content[0].text)?.[1];
    await settle(2200); // past the original 2s deadline
    expect(processRegistry.listForSession(session).find((x) => x.id === id)?.running).toBe(true);
  }, 15_000);

  it('does not persist cwd from a detached foreground run', async () => {
    const session = 'brain-fg-detached-cwd';
    const sub = join(dir, 'detached-cwd');
    mkdirSync(sub, { recursive: true });
    const p = inSession(session, 'Bash', { command: 'cd detached-cwd; sleep 10' });
    await settle(250);
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 1 });
    expect((await p).content[0].text).toContain('Moved to background');
    const next = await inSession(session, 'Bash', { command: 'pwd' });
    expect(next.content[0].text).toContain(realpathSync(dir));
    expect(next.content[0].text).not.toContain(realpathSync(sub));
  }, 15_000);

  it('does not persist cwd from a killed foreground run', async () => {
    const session = 'brain-fg-killed-cwd';
    const sub = join(dir, 'killed-cwd');
    mkdirSync(sub, { recursive: true });
    const p = inSession(session, 'Bash', { command: 'cd killed-cwd; sleep 10', timeout: 2_0000 });
    await settle(250);
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 1 });
    expect((await p).content[0].text).toContain('[killed]');
    const next = await inSession(session, 'Bash', { command: 'pwd' });
    expect(next.content[0].text).toContain(realpathSync(dir));
    expect(next.content[0].text).not.toContain(realpathSync(sub));
  }, 15_000);

  it('a session or principal mismatch detaches nothing and the command completes in the foreground', async () => {
    const session = 'brain-fg-mismatch';
    const p = inSession(session, 'Bash', { command: `node -e "setTimeout(() => process.stdout.write('ok'), 400)"` });
    await settle(150);
    expect(control().detachForeground({ sessionId: 'brain-other', principal: 'elowen:1' })).toEqual({ detached: 0 });
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:999' })).toEqual({ detached: 0 });
    const res = await p;
    expect(res.content[0].text).toContain('ok');
    expect(res.content[0].text).toContain('[exit 0]'); // finished normally, not "moved to background"
  }, 15_000);

  it('an in-flight foreground command does not consume a background slot', async () => {
    const session = 'brain-fg-cap';
    const fg = inSession(session, 'Bash', { command: idle(8) }); // foreground, in flight
    await settle(200);
    expect(processRegistry.listForSession(session).some((x) => x.completionMode === 'foreground')).toBe(true);
    for (let i = 0; i < 16; i += 1) { // all MAX_BG slots still free — the foreground run is excluded
      const r = await inSession(session, 'Bash', { command: 'sleep 8', run_in_background: true });
      expect(r.content[0].text).toMatch(/Started background process/);
    }
    const refused = await inSession(session, 'Bash', { command: 'sleep 8', run_in_background: true });
    expect(refused.content[0].text).toMatch(/too many background processes/);
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 0 });
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 1 });
    await fg;
  }, 25_000);

  it('leaves Ctrl+B foreground when the background limit is already full', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log,
      config: { terminal: { maxBackgroundProcesses: 1 } },
    });
    const terminal = reg.controls.get('terminal') as unknown as {
      detachForeground: (i: { sessionId: string; principal: string }) => { detached: number };
    };
    const session = 'brain-fg-cap-one';
    const scope = { identity: uidOwner, sessionId: session };
    const bg = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'sleep 8', run_in_background: true,
    }), scope);
    expect(bg.content[0].text).toContain('Started background process');
    const fg = runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: `node -e "setTimeout(() => console.log('foreground-finished'), 500)"`,
    }), scope);
    await settle(150);

    expect(terminal.detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 0 });
    const result = await fg;
    expect(result.content[0].text).toContain('foreground-finished');
    expect(result.content[0].text).toContain('[exit 0]');
    expect(result.content[0].text).not.toContain('Moved to background');
  }, 15_000);
});

// The stop escalation (a further Esc / repeat Ctrl+C after the graceful interrupt): the daemon's
// killForeground control SIGKILLs a still-foreground run so the aborted turn parked on the Bash tool can
// unwind — PI's agent loop only re-checks its abort signal between tool calls, so a long command would
// otherwise pin the turn until it exits on its own. The settled run must read as [killed].
describe('terminal plugin — foreground kill (stop escalation)', () => {
  let reg: PluginRegistry;
  let dir: string;
  const uidOwner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' };
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term-kill');
  });
  afterEach(() => { processRegistry.setExitListener(() => {}); });

  const control = () => {
    const c = reg.controls.get('terminal');
    if (!c) throw new Error('terminal control not registered');
    return c as unknown as {
      detachForeground: (i: { sessionId: string; principal: string }) => { detached: number };
      killForeground: (i: { sessionId: string; principal: string }) => { killed: number };
    };
  };
  const inSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: uidOwner, sessionId });
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('kills a running foreground command: the tool settles as [killed] and the handle is collected', async () => {
    const session = 'brain-fgkill-basic';
    let nudged = 0;
    processRegistry.setExitListener(() => { nudged += 1; });
    const p = inSession(session, 'Bash', { command: idle(30) });
    await settle(300); // spawned and registered as foreground
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 1 });
    const res = await p;
    expect(res.content[0].text).toContain('[killed]');
    expect(res.content[0].text).not.toContain('[exit null]');
    expect(res.details.exitCode).toBeUndefined(); // no structural exit code — the run was killed, not finished
    expect(processRegistry.listForSession(session)).toHaveLength(0); // same settle path as a normal finish
    expect(nudged).toBe(0); // a killed foreground command never wakes the conversation
    // The entry is gone with the settle, so a repeat escalation press kills nothing (idempotent).
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 0 });
  }, 15_000);

  it('a double-fire before the run settles counts the kill once (already-aborted entries are skipped)', async () => {
    const session = 'brain-fgkill-twice';
    const p = inSession(session, 'Bash', { command: idle(30) });
    await settle(300);
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 1 });
    // The abort is synchronous but the settle is not — the entry may still be in the map, already dying.
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 0 });
    expect((await p).content[0].text).toContain('[killed]');
  }, 15_000);

  it('a session or principal mismatch kills nothing and the command completes normally', async () => {
    const session = 'brain-fgkill-mismatch';
    const p = inSession(session, 'Bash', { command: `node -e "setTimeout(() => process.stdout.write('ok'), 500)"` });
    await settle(200);
    expect(control().killForeground({ sessionId: 'brain-other', principal: 'elowen:1' })).toEqual({ killed: 0 });
    expect(control().killForeground({ sessionId: session, principal: 'elowen:999' })).toEqual({ killed: 0 });
    const res = await p;
    expect(res.content[0].text).toContain('ok');
    expect(res.content[0].text).toContain('[exit 0]');
  }, 15_000);

  it('spares detached and background runs — only a run still blocking the turn is killable', async () => {
    const session = 'brain-fgkill-spares';
    const bg = await inSession(session, 'Bash', { command: 'sleep 8', run_in_background: true });
    const bgId = /Started background process (\S+):/.exec(bg.content[0].text)?.[1];
    expect(bgId).toBeTruthy();
    const p = inSession(session, 'Bash', { command: idle(8) });
    await settle(300);
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 1 });
    await p; // the detach resolved the tool; the process itself keeps running as a job
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 0 });
    expect(processRegistry.listForSession(session).filter((x) => x.running)).toHaveLength(2); // both alive
  }, 15_000);
});

// Blocking reads exist so the agent stops burning turns polling a build it started. The wait is bounded
// and never destructive: a timed-out wait leaves the process running for a later read.
describe('terminal plugin — ProcessOutput(block)', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term-block');
  });

  const inSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: owner, sessionId });
  // The detach control matches on `elowen:<id>`, which only an identity carrying elowenUserId produces.
  const uidOwner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' };
  const asUid = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: uidOwner, sessionId });
  const startBgAsUid = async (sessionId: string, command: string): Promise<string> => {
    const res = await asUid(sessionId, 'Bash', { command, run_in_background: true });
    const id = /Started background process (\S+):/.exec(res.content[0].text)?.[1];
    expect(id).toBeTruthy();
    return id!;
  };
  const startBg = async (sessionId: string, command: string): Promise<string> => {
    const res = await inSession(sessionId, 'Bash', { command, run_in_background: true });
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

  // A model that got "(no new output) [still running]" back instantly called ProcessOutput again at
  // once, step after step, after a run was auto-backgrounded. Waiting is therefore the default.
  it('waits for the exit by default; block=false is the immediate peek', async () => {
    const session = 'brain-term-block-default';
    const id = await startBg(session, `node -e "setTimeout(() => { console.log('later'); }, 600)"`);
    const peek = await inSession(session, 'ProcessOutput', { id, block: false });
    expect(peek.content[0].text).toContain('(no new output)');
    expect(peek.content[0].text).toContain('[still running]');
    const started = Date.now();
    const res = await inSession(session, 'ProcessOutput', { id });
    expect(res.content[0].text).toContain('later');
    expect(res.content[0].text).toContain('[exited 0]');
    expect(Date.now() - started).toBeGreaterThan(300);
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

  // Ctrl+B has to reach a blocked read as well: it holds the turn exactly like a foreground command, and
  // before this it was invisible to the clients ("nothing running in the foreground to background") and
  // unreachable by the control, so the user could only wait the deadline out.
  it('Ctrl+B releases a blocked read: the flag is visible while waiting and the tool returns the output so far', async () => {
    const session = 'brain-term-block-release';
    const control = reg.controls.get('terminal') as unknown as {
      detachForeground: (i: { sessionId: string; principal: string }) => { detached: number };
    };
    const id = await startBgAsUid(session, `node -e "console.log('early'); setTimeout(() => {}, 30000)"`);
    const read = asUid(session, 'ProcessOutput', { id, block: true, timeout: 600 });
    await new Promise((r) => setTimeout(r, 400));
    // The clients learn about the wait through the process list they already read.
    expect(processRegistry.list().find((p) => p.id === id)?.blockedRead).toBe(true);

    expect(control.detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 1 });
    const res = await read;
    expect(res.content[0].text).toContain('early');
    expect(res.content[0].text).toContain('[still running — wait released by the user]');
    // The process is untouched and readable again; the flag is gone with the wait.
    const listed = processRegistry.list().find((p) => p.id === id);
    expect(listed?.running).toBe(true);
    expect(listed?.blockedRead).toBeUndefined();
    await asUid(session, 'KillProcess', { id });
  }, 20_000);

  it('a session or principal mismatch releases no blocked read', async () => {
    const session = 'brain-term-block-release-mismatch';
    const control = reg.controls.get('terminal') as unknown as {
      detachForeground: (i: { sessionId: string; principal: string }) => { detached: number };
    };
    const id = await startBgAsUid(session, `node -e "setTimeout(() => {}, 30000)"`);
    const read = asUid(session, 'ProcessOutput', { id, block: true, timeout: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(control.detachForeground({ sessionId: 'brain-other', principal: 'elowen:1' })).toEqual({ detached: 0 });
    expect(control.detachForeground({ sessionId: session, principal: 'elowen:999' })).toEqual({ detached: 0 });
    const res = await read;
    expect(res.content[0].text).toContain('[still running after waiting 1s]'); // its own deadline, not a release
    await asUid(session, 'KillProcess', { id });
  }, 20_000);

  it('block=false is a non-waiting snapshot', async () => {
    const session = 'brain-term-block-off';
    const id = await startBg(session, `node -e "setTimeout(() => { console.log('late'); }, 5000)"`);
    const started = Date.now();
    const res = await inSession(session, 'ProcessOutput', { id, block: false });
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
    await processRegistry.kill(id); // the web panel's ✕, or the conversation being deleted

    await read;
    expect(Date.now() - started).toBeLessThan(10_000); // released on the kill, not after 120s
  }, 20_000);
});

// A foreground run holds the whole turn. Two rules bound that: a leading `sleep N` is refused outright
// (the wait belongs to ProcessOutput, which can do it properly), and the run waits for exactly the
// `timeout` its caller asked for — at which point it is MOVED to the background rather than killed with
// its output thrown away. The move may not touch a command the user approved at a permission prompt or a
// delegated turn, whose caller can never read a process id.
describe('terminal plugin — foreground deadline and sleep polling', () => {
  let reg: PluginRegistry;
  let dir: string;
  const uidOwner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, elowenUserId: 1, conversation: 'own' };
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = tmpDir('term-budget');
  });
  // A sub-agent or workflow node: a turn with no conversation of its own, whose caller sees only the
  // final answer and can never be handed a process id to read later.
  const delegated: TurnIdentity = { platform: 'subagent', userId: 'subagent', admin: true, owner: true, conversation: 'delegated' };
  const inSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: uidOwner, sessionId });
  const inDelegatedSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runTool(reg, name, params), { identity: delegated, sessionId, contributionUserId: 1 });
  const approvedInSession = (sessionId: string, name: string, params: Record<string, unknown>) =>
    runWithPolicy(userPolicy([dir]), () => runWithApprovedCall(() => runTool(reg, name, params)), { identity: uidOwner, sessionId });

  it('refuses a bare `sleep N` in the foreground and names the blocking read instead', async () => {
    const res = await inSession('brain-sleep-block', 'Bash', { command: 'sleep 30' });
    expect(res.content[0].text).toMatch(/refused a bare sleep of 30s/);
    expect(res.content[0].text).toContain('ProcessOutput(id)');
    expect(processRegistry.listForSession('brain-sleep-block')).toHaveLength(0); // refused BEFORE anything was spawned
  }, 20_000);

  // The command that waits and then READS is the polling idiom this codebase itself documents for a long
  // run started as a transient unit. It ends the turn with output, so refusing it taught nothing and cost
  // the agent its result.
  it('allows a sleep that is followed by the command it is waiting for', async () => {
    const marker = join(dir, 'sleep-then-read');
    writeFileSync(marker, 'build finished\n');
    const res = await inSession('brain-sleep-then-read', 'Bash', {
      command: `sleep 2; cat ${JSON.stringify(marker)}`,
    });
    expect(res.content[0].text).not.toMatch(/refused a bare sleep/);
    expect(res.content[0].text).toContain('build finished');
  }, 20_000);

  it('judges the DURATION, not the spelling, so the honest form is not the only one refused', async () => {
    // A rule that catches `sleep 5` and waves through `sleep 5m` teaches evasion instead of the habit it
    // exists to teach, so every resolvable spelling of "wait two seconds or more" is refused alike.
    for (const command of ['sleep 5m', 'sleep 2.0', 'sleep 1h', '/bin/sleep 30']) {
      const res = await inSession('brain-sleep-units', 'Bash', { command });
      expect(res.content[0].text, command).toMatch(/refused a bare sleep/);
    }
  }, 20_000);

  it('leaves every sleep that is not a foreground poll alone', async () => {
    const session = 'brain-sleep-ok';
    // A short pause is pacing, not a poll.
    expect((await inSession(session, 'Bash', { command: 'sleep 1; echo paced' })).content[0].text).toContain('paced');
    // Under the threshold however it is spelled.
    expect((await inSession(session, 'Bash', { command: 'sleep 1.5; echo fractional' })).content[0].text).toContain('fractional');
    // An unexpanded variable is not a duration this can resolve, and refusing on a hunch is worse than
    // missing one — the shell has not substituted anything yet.
    expect((await inSession(session, 'Bash', { command: 'WAIT=1; sleep $WAIT; echo variable' })).content[0].text).toContain('variable');
    // The readiness-wait shape the refusal message itself recommends has to be allowed.
    expect((await inSession(session, 'Bash', { command: 'until [ -e /nonexistent ]; do sleep 1; done', timeout: 1_000 })).content[0].text)
      .not.toMatch(/refused a bare sleep/);
    // Not the only command: part of somebody's script, not a turn spent on nothing.
    expect((await inSession(session, 'Bash', { command: 'echo first; sleep 5' , timeout: 1_000 })).content[0].text).toContain('first');
    // Backgrounded: it blocks no turn, and it is a legitimate way to hold a process slot.
    expect((await inSession(session, 'Bash', { command: 'sleep 20', run_in_background: true })).content[0].text)
      .toMatch(/Started background process/);
  }, 30_000);

  // Regression: a separate 30 s blocking budget used to decide this, so a call that asked for a SHORT
  // deadline was killed at it (300ms < budget) while a call that asked for a long one was cut short at
  // 30 s. There is one deadline now — the caller's — and reaching it moves the run instead of killing it.
  it('honours the call’s own deadline and moves the run at it, however short', async () => {
    const session = 'brain-deadline-short';
    const started = Date.now();
    const res = await inSession(session, 'Bash', { command: idle(20), timeout: 800 });
    const text = res.content[0].text;
    expect(text).toContain('Moved to background as process');
    expect(text).toContain('reached its 800ms timeout');
    expect(text).not.toContain('timed out after'); // preserved, not killed
    expect(Date.now() - started).toBeGreaterThan(600); // it really waited for the deadline it was given
    const id = /Moved to background as process (\S+):/.exec(text)?.[1];
    expect(processRegistry.listForSession(session).find((x) => x.id === id)?.completionMode).toBe('job');
  }, 20_000);

  it('never detaches a run whose kill is already in flight', async () => {
    // The window this closes: a killed run keeps `exitCode === null` (that is what makes it read as
    // `[killed]` rather than `[exit N]`), so it still looks RUNNING for the whole SIGKILL-to-settle
    // window. A detach landing in that window — from the budget timer, or from a Ctrl+B pressed at the
    // same moment — would reserve a background slot and report the command the user had just stopped as
    // "moved to background". Driven through the control here because it is the same detachRun guard and
    // does not cost a 30s budget to reach.
    const session = 'brain-budget-killrace';
    const control = reg.controls.get('terminal') as unknown as {
      detachForeground: (i: { sessionId: string; principal: string }) => { detached: number };
      killForeground: (i: { sessionId: string; principal: string }) => { killed: number };
    };
    const p = inSession(session, 'Bash', { command: idle(30), timeout: 45_000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(control.killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 1 });
    expect(control.detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 0 });
    const res = await p;
    expect(res.content[0].text).toContain('[killed]');
    expect(res.content[0].text).not.toContain('Moved to background');
    expect(processRegistry.listForSession(session)).toHaveLength(0);
  }, 30_000);

  it('lets a fast command with a long timeout finish in the foreground and leaves nothing behind', async () => {
    // The deadline hook is installed here but must never fire: the run settles in well under a second and
    // the result is an ordinary foreground completion.
    const session = 'brain-budget-fast';
    const res = await inSession(session, 'Bash', { command: 'echo quick', timeout: 45_000 });
    expect(res.content[0].text).toContain('quick');
    expect(res.content[0].text).toContain('[exit 0]');
    expect(res.content[0].text).not.toContain('Moved to background');
    expect(processRegistry.listForSession(session)).toHaveLength(0);
  }, 20_000);

  // The exclusions, against the same deadline the moved run above gets. All three run concurrently.
  it('moves a run at its deadline, but never one the user approved or a delegated one', async () => {
    const moved = 'brain-deadline-moved';
    const held = 'brain-deadline-held';
    const child = 'brain-deadline-delegated';
    // Prints immediately, then again well after the deadline the calls below set.
    const chatty = `node -e "console.log('early'); setTimeout(() => console.log('late'), 2500)"`;
    const movedRun = inSession(moved, 'Bash', { command: chatty, timeout: 800 });
    // Same shape, but approved at an ask prompt: it must stay in the foreground and die at its deadline.
    const heldRun = approvedInSession(held, 'Bash', { command: idle(60), timeout: 800 });
    // Same shape again, from a sub-agent or workflow node. Its caller reads the final answer and nothing
    // else, so a process id in place of the test output is the result thrown away.
    const childRun = inDelegatedSession(child, 'Bash', { command: chatty, timeout: 5_000 });

    const movedRes = await movedRun;
    const text = movedRes.content[0].text;
    const id = /Moved to background as process (\S+):/.exec(text)?.[1];
    expect(id, text).toBeTruthy();
    expect(text).toContain('reached its 800ms timeout');
    expect(text).toContain(`ProcessOutput("${id}")`);
    // It really is an ordinary background job now, not a foreground run wearing a new label.
    const listed = processRegistry.listForSession(moved).find((x) => x.id === id);
    expect(listed?.completionMode).toBe('job');
    expect(listed?.running).toBe(true);

    // …and the REST of the output is still collectable, which is the whole point of moving instead of killing.
    const rest = await inSession(moved, 'ProcessOutput', { id: id!, block: true, timeout: 30 });
    expect(rest.content[0].text).toContain('late');
    expect(rest.content[0].text).toContain('[exited 0]');

    const heldText = (await heldRun).content[0].text;
    expect(heldText).not.toContain('Moved to background');
    expect(heldText).toContain('[killed: timed out after 800ms; a command you approved is never moved to the background on its own]');
    expect(processRegistry.listForSession(held)).toHaveLength(0);

    // The delegated run stayed in the foreground and came back with what it was waiting for.
    const childText = (await childRun).content[0].text;
    expect(childText).not.toContain('Moved to background');
    expect(childText).toContain('late');
    expect(childText).toContain('[exit 0]');
    expect(processRegistry.listForSession(child)).toHaveLength(0);
  }, 30_000);
});

describe('process ids — collision safety across registries', () => {
  it('mints full UUIDs, unique across calls', async () => {
    // The id is the only handle every kill/list surface keys on, across the daemon AND sub-agent runner
    // registries whose clocks are independent — a timestamp+3-char id could collide and route one
    // session's kill onto another's process.
    const { newProcessId } = await import('../../plugins/terminal/index.mjs');
    const ids = new Set(Array.from({ length: 5_000 }, () => newProcessId()));
    expect(ids.size).toBe(5_000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });
});
