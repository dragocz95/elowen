import { describe, it, expect } from 'vitest';
import { AGENT_CLIS, detectAgentClis, installCommand } from '../../../src/cli/install/agentClis.js';
import { preflight, preflightBlockers } from '../../../src/cli/install/preflight.js';
import { currentUser, userHome, ensureServiceUser } from '../../../src/cli/install/serviceUser.js';
import { ensureTerminalStreaming } from '../../../src/cli/install/index.js';
import { isIpAddress } from '../../../src/cli/provision/deployment.js';
import type { Runner, ExecResult } from '../../../src/cli/install/runner.js';

function runner(over: Partial<Runner> = {}): Runner {
  return {
    exec: async (): Promise<ExecResult> => ({ code: 0, stdout: '', stderr: '' }),
    which: async () => null,
    writeFile: async () => {},
    exists: async () => false,
    ...over,
  };
}

describe('install/agentClis', () => {
  it('covers every supported agent CLI with its npm package', () => {
    expect(AGENT_CLIS.map((c) => c.id).sort()).toEqual(['claude', 'codex', 'kilo', 'omp', 'opencode', 'pi']);
    expect(AGENT_CLIS.find((c) => c.id === 'claude')!.pkg).toBe('@anthropic-ai/claude-code');
    expect(AGENT_CLIS.find((c) => c.id === 'kilo')!.pkg).toBe('@kilocode/cli');
    expect(AGENT_CLIS.find((c) => c.id === 'pi')!.pkg).toBe('@earendil-works/pi-coding-agent');
    expect(AGENT_CLIS.find((c) => c.id === 'omp')!.pkg).toBe('@oh-my-pi/pi-coding-agent');
  });
  it('detects which CLIs are installed for the service user', async () => {
    const r = runner({ which: async (cmd) => (cmd === 'claude' ? '/u/bin/claude' : null) });
    const found = await detectAgentClis(r, 'elowen');
    expect(found.find((c) => c.id === 'claude')!.installed).toBe(true);
    expect(found.find((c) => c.id === 'opencode')!.installed).toBe(false);
  });
  it('installs a missing CLI via its official npm package', () => {
    const { cmd, args } = installCommand(AGENT_CLIS[1]!);
    expect(cmd).toBe('npm');
    expect(args).toEqual(['install', '-g', 'opencode-ai']);
  });
});

describe('install/preflight', () => {
  const ok = runner({
    exec: async (cmd, _args) => {
      if (cmd === 'id') return { code: 0, stdout: '0\n', stderr: '' };
      if (cmd === 'node') return { code: 0, stdout: 'v22.22.2\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    which: async (cmd) => (cmd === 'apt-get' || cmd === 'tmux' ? `/usr/bin/${cmd}` : null),
  });

  it('passes on a root apt box with node ≥22 and tmux', async () => {
    const p = await preflight(ok, 'linux');
    expect(p.isRoot).toBe(true);
    expect(p.pkgManager).toBe('apt');
    expect(p.node.ok).toBe(true);
    expect(p.tmux).toBe(true);
    expect(p.buildTools).toBe(false); // cc/python3 not on the fake box
    expect(preflightBlockers(p)).toEqual([]); // buildTools is informational, never a blocker
  });
  it('reports buildTools when cc and python3 are present', async () => {
    const withTools = runner({
      exec: async (cmd) => (cmd === 'id' ? { code: 0, stdout: '0\n', stderr: '' } : cmd === 'node' ? { code: 0, stdout: 'v22.0.0\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      which: async (cmd) => (['cc', 'python3', 'apt-get'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    });
    expect((await preflight(withTools, 'linux')).buildTools).toBe(true);
  });
  it('blocks when not root and node is too old', async () => {
    const bad = runner({
      exec: async (cmd) => (cmd === 'id' ? { code: 0, stdout: '1000\n', stderr: '' } : cmd === 'node' ? { code: 0, stdout: 'v18.0.0\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      which: async () => null,
    });
    const p = await preflight(bad, 'linux');
    const blockers = preflightBlockers(p);
    expect(p.isRoot).toBe(false);
    expect(blockers.join(' ')).toMatch(/root/i);
    expect(blockers.join(' ')).toMatch(/Node/i);
    expect(blockers.join(' ')).toMatch(/apt/i);
  });

  // macOS inverts the Linux contract: brew is the package manager, and root is REFUSED (Homebrew and
  // the gui launchd domain are both per-user — sudo would provision the wrong user).
  it('macOS: passes as a normal user with brew, and blocks under sudo', async () => {
    const macRunner = (uid: string) => runner({
      exec: async (cmd) => (cmd === 'id' ? { code: 0, stdout: `${uid}\n`, stderr: '' } : cmd === 'node' ? { code: 0, stdout: 'v22.0.0\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      which: async (cmd) => (cmd === 'brew' ? '/opt/homebrew/bin/brew' : null),
    });
    const user = await preflight(macRunner('501'), 'darwin');
    expect(user.platform).toBe('darwin');
    expect(user.pkgManager).toBe('brew');
    expect(preflightBlockers(user)).toEqual([]);

    const root = await preflight(macRunner('0'), 'darwin');
    expect(preflightBlockers(root).join(' ')).toMatch(/without sudo/i);
  });

  it('macOS: missing brew blocks only while tmux is also missing', async () => {
    const base = (tmux: boolean) => runner({
      exec: async (cmd) => (cmd === 'id' ? { code: 0, stdout: '501\n', stderr: '' } : cmd === 'node' ? { code: 0, stdout: 'v22.0.0\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      which: async (cmd) => (tmux && cmd === 'tmux' ? '/usr/local/bin/tmux' : null),
    });
    expect(preflightBlockers(await preflight(base(false), 'darwin')).join(' ')).toMatch(/Homebrew/);
    expect(preflightBlockers(await preflight(base(true), 'darwin'))).toEqual([]);
  });
});

describe('install/ensureTerminalStreaming', () => {
  function recordingRunner(present: string[]) {
    const calls: { cmd: string; args: string[] }[] = [];
    const r: Runner = {
      exec: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; },
      which: async (cmd) => (present.includes(cmd) ? `/usr/bin/${cmd}` : null),
      writeFile: async () => {},
      exists: async () => false,
    };
    return { r, calls };
  }

  it('apt-installs the toolchain when missing, then installs node-pty into the package', async () => {
    const { r, calls } = recordingRunner([]); // no cc/python3
    await ensureTerminalStreaming(r);
    const flat = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(flat.some((s) => s.includes('apt-get install -y python3 make g++'))).toBe(true);
    expect(flat.some((s) => s.startsWith('bash -lc') && s.includes('npm install') && s.includes('node-pty@'))).toBe(true);
  });

  it('skips the toolchain install when cc and python3 are already present', async () => {
    const { r, calls } = recordingRunner(['cc', 'python3']);
    await ensureTerminalStreaming(r);
    const flat = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(flat.some((s) => s.includes('apt-get'))).toBe(false);
    expect(flat.some((s) => s.includes('node-pty@'))).toBe(true);
  });

  it('never reaches for apt on macOS — there is none, and npm may still land a prebuilt binary', async () => {
    const { r, calls } = recordingRunner([]); // no cc/python3, worst case
    await ensureTerminalStreaming(r, 'darwin');
    const flat = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(flat.some((s) => s.includes('apt-get'))).toBe(false);
    expect(flat.some((s) => s.includes('node-pty@'))).toBe(true);
  });
});

describe('install/currentUser (macOS per-user install)', () => {
  it('resolves the invoking user and HOME without touching passwd databases', async () => {
    const r = runner({ exec: async (cmd, args) => (cmd === 'id' && args[0] === '-un' ? { code: 0, stdout: 'filip\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }) });
    expect(await currentUser(r, { HOME: '/Users/filip' })).toEqual({ username: 'filip', home: '/Users/filip' });
  });
});

describe('install/isIpAddress (no Let’s Encrypt for IPs)', () => {
  it('detects IPv4 and IPv6 addresses', () => {
    for (const ip of ['188.130.140.172', '127.0.0.1', '10.0.0.1', '::1', '2001:db8::1']) expect(isIpAddress(ip)).toBe(true);
  });
  it('treats domain names as non-IP', () => {
    for (const d of ['elowen.example.com', 'example.com', 'my-host.dev']) expect(isIpAddress(d)).toBe(false);
  });
});

describe('install/serviceUser', () => {
  const passwd = (home: string): ExecResult => ({ code: 0, stdout: `elowen:x:998:998::${home}:/bin/bash\n`, stderr: '' });

  it('reads HOME from getent passwd, null when the user is absent', async () => {
    const present = runner({ exec: async () => passwd('/var/lib/elowen') });
    const absent = runner({ exec: async () => ({ code: 2, stdout: '', stderr: '' }) });
    expect(await userHome(present, 'elowen')).toBe('/var/lib/elowen');
    expect(await userHome(absent, 'elowen')).toBeNull();
  });

  it('mode=existing returns the resolved HOME and never calls useradd', async () => {
    const calls: string[] = [];
    const r = runner({ exec: async (cmd) => { calls.push(cmd); return passwd('/home/deploy'); } });
    const res = await ensureServiceUser(r, { mode: 'existing', username: 'deploy' });
    expect(res).toEqual({ username: 'deploy', home: '/home/deploy' });
    expect(calls).not.toContain('useradd');
  });

  it('mode=existing throws when the user does not exist', async () => {
    const r = runner({ exec: async () => ({ code: 2, stdout: '', stderr: '' }) });
    await expect(ensureServiceUser(r, { mode: 'existing', username: 'ghost' })).rejects.toThrow(/does not exist/);
  });

  it('mode=create runs useradd --system with its own HOME when absent', async () => {
    let useraddArgs: string[] = [];
    const r = runner({
      exec: async (cmd, args) => {
        if (cmd === 'getent') return { code: 2, stdout: '', stderr: '' };
        if (cmd === 'useradd') { useraddArgs = args; return { code: 0, stdout: '', stderr: '' }; }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const res = await ensureServiceUser(r, { mode: 'create', username: 'elowen' });
    expect(res).toEqual({ username: 'elowen', home: '/var/lib/elowen' });
    expect(useraddArgs).toContain('--system');
    expect(useraddArgs).toContain('elowen');
  });
});
