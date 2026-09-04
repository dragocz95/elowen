import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ungrantedPluginTools } from '../../src/plugins/toolGrants.js';
import { processRegistry } from '../../src/brain/processRegistry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true };
const terminalModule = await import(resolve(repoRoot, 'plugins/terminal/index.mjs')) as {
  mapReportedCwd(reported: string, prepared: { workspace?: { path: string } | null }, assertAllowed: (path: string) => string): string;
};

const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('t', params);
};

// The process registry is a module-level singleton shared across every test in this run. Background
// commands (and any handle a test registers) survive into later tests and other files, so clear it after
// each test. kill() is idempotent and safe on both fake and real handles.
afterEach(() => { for (const p of processRegistry.list()) processRegistry.kill(p.id); });

// Every describe's beforeAll creates ONE shared dir for all its tests, so the dirs must survive until the
// whole file is done — and they must outlive the afterEach that kills the registry's background processes:
// those commands run with the dir as their cwd, so deleting it under a still-running process would break
// the run nondeterministically. Removing them here, after every test (and its kill hook) has settled, is
// the only safe point.
let dirs: string[] = [];
const allDirs = new Set<string>();
const cleanupDirs = () => {
  for (const process of processRegistry.list()) processRegistry.kill(process.id);
  for (const p of dirs) rmSync(p, { recursive: true, force: true });
  dirs = [];
};
const tmpDir = (tag: string): string => {
  const p = mkdtempSync(join(tmpdir(), `elowen-${tag}-`));
  dirs.push(p);
  allDirs.add(p);
  return p;
};
const markerExecutable = (dir: string, name: string, marker: string): string => {
  const executable = join(dir, name);
  writeFileSync(executable, `#!/bin/sh\nprintf reached > ${JSON.stringify(marker)}\n`);
  chmodSync(executable, 0o755);
  return executable;
};
process.once('exit', cleanupDirs);
afterAll(() => {
  process.off('exit', cleanupDirs);
  cleanupDirs();
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
      parameters: { properties: Record<string, { description?: string; maximum?: number }> };
    };
    expect(Object.keys(bash.parameters.properties).sort()).toEqual([
      'backgroundMode', 'command', 'cwd', 'dangerouslyDisableSandbox', 'description', 'run_in_background', 'timeout',
    ]);
    expect(bash.parameters.properties).not.toHaveProperty('background');
    expect(bash.parameters.properties).not.toHaveProperty('timeout_seconds');
    expect(bash.parameters.properties.timeout.maximum).toBe(600_000);
    expect(bash.parameters.properties.timeout.description).toMatch(/milliseconds/i);
  });

  it('maps a workspace guest cwd back to the host workspace and revalidates it', () => {
    const workspace = join(dir, 'workspace-host');
    mkdirSync(join(workspace, 'nested'), { recursive: true });
    const checked: string[] = [];
    const mapped = terminalModule.mapReportedCwd('/workspace/nested', { workspace: { path: workspace } }, (path) => {
      checked.push(path);
      return realpathSync(path);
    });
    expect(mapped).toBe(realpathSync(join(workspace, 'nested')));
    expect(checked).toEqual([join(workspace, 'nested')]);
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

  it('does not persist cwd changes from background or timed-out calls', async () => {
    const sub = join(dir, 'nonpersistent-subdir');
    mkdirSync(sub, { recursive: true });
    const scope = { identity: owner, sessionId: 'brain-cwd-nonpersist' };
    const bg = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'cd nonpersistent-subdir; sleep 20', run_in_background: true,
    }), scope);
    expect(bg.content[0].text).toContain('Started background process');
    const afterBg = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'pwd' }), scope);
    expect(afterBg.content[0].text).toContain(realpathSync(dir));
    expect(afterBg.content[0].text).not.toContain(realpathSync(sub));

    const timedOut = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', {
      command: 'cd nonpersistent-subdir; sleep 20', timeout: 100,
    }), scope);
    expect(timedOut.content[0].text).toContain('timed out after 100ms');
    const afterTimeout = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'pwd' }), scope);
    expect(afterTimeout.content[0].text).toContain(realpathSync(dir));
    expect(afterTimeout.content[0].text).not.toContain(realpathSync(sub));
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
    ) as { userGrantable?: boolean; provides?: { tools?: string[] } };
    expect(manifest.userGrantable).toBe(true);
    // Every tool this plugin ships rides on that one flag, so none of them may be added without it.
    expect(manifest.provides?.tools).toEqual(['Bash', 'ListProcesses', 'ProcessOutput', 'KillProcess']);
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
    expect(out.content[0].text.length).toBeLessThanOrEqual(10_000 + '\n[exited 0]'.length);
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

    expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(10_000 + '\n[exited 0]'.length);
    expect(out.content[0].text).toContain('\u20ac');
    expect(out.content[0].text).not.toContain('\uFFFD'); // cut on a character boundary, not mid-character
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
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Bash', { command: 'sleep 20', timeout: 100 }), { identity: owner });
    expect(res.content[0].text).toContain('[killed: timed out after 100ms]');
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
// running and nudges the conversation on exit — the exact lifecycle Bash(background=true) already has.
describe('terminal plugin — foreground detach (Ctrl+B backgrounds a running command)', () => {
  let reg: PluginRegistry;
  let dir: string;
  // A real operator identity carries elowenUserId; the plugin captures principal `elowen:<id>` at spawn,
  // which is what the daemon's detach control matches on.
  const uidOwner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, elowenUserId: 1 };
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
    expect(nudgedId).toBe(id); // the detached run's exit wakes the conversation, like Bash(background)
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
    const p = inSession(session, 'Bash', { command: 'sleep 10', timeout: 2_000 }); // would be killed at 2s
    await settle(500);
    expect(control().detachForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ detached: 1 });
    const res = await p;
    const id = /Moved to background as process (\S+):/.exec(res.content[0].text)?.[1];
    await settle(2200); // past the original 2s deadline
    expect(processRegistry.listForSession(session).find((x) => x.id === id)?.running).toBe(true);
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
    const fg = inSession(session, 'Bash', { command: 'sleep 8' }); // foreground, in flight
    await settle(200);
    expect(processRegistry.listForSession(session).some((x) => x.completionMode === 'foreground')).toBe(true);
    for (let i = 0; i < 16; i += 1) { // all MAX_BG slots still free — the foreground run is excluded
      const r = await inSession(session, 'Bash', { command: 'sleep 8', run_in_background: true });
      expect(r.content[0].text).toMatch(/Started background process/);
    }
    const refused = await inSession(session, 'Bash', { command: 'sleep 8', run_in_background: true });
    expect(refused.content[0].text).toMatch(/too many background processes/);
    control().detachForeground({ sessionId: session, principal: 'elowen:1' }); // resolve the fg run cleanly
    await fg;
  }, 25_000);
});

// The stop escalation (a further Esc / repeat Ctrl+C after the graceful interrupt): the daemon's
// killForeground control SIGKILLs a still-foreground run so the aborted turn parked on the Bash tool can
// unwind — PI's agent loop only re-checks its abort signal between tool calls, so a long command would
// otherwise pin the turn until it exits on its own. The settled run must read as [killed].
describe('terminal plugin — foreground kill (stop escalation)', () => {
  let reg: PluginRegistry;
  let dir: string;
  const uidOwner: TurnIdentity = { platform: 'elowen', userId: '1', admin: true, owner: true, elowenUserId: 1 };
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
    const p = inSession(session, 'Bash', { command: 'sleep 30' });
    await settle(300); // spawned and registered as foreground
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 1 });
    const res = await p;
    expect(res.content[0].text).toContain('[killed]');
    expect(res.details.exitCode).toBeUndefined(); // no structural exit code — the run was killed, not finished
    expect(processRegistry.listForSession(session)).toHaveLength(0); // same settle path as a normal finish
    expect(nudged).toBe(0); // a killed foreground command never wakes the conversation
    // The entry is gone with the settle, so a repeat escalation press kills nothing (idempotent).
    expect(control().killForeground({ sessionId: session, principal: 'elowen:1' })).toEqual({ killed: 0 });
  }, 15_000);

  it('a double-fire before the run settles counts the kill once (already-aborted entries are skipped)', async () => {
    const session = 'brain-fgkill-twice';
    const p = inSession(session, 'Bash', { command: 'sleep 30' });
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
    const p = inSession(session, 'Bash', { command: 'sleep 8' });
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
