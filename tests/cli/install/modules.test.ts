import { describe, it, expect } from 'vitest';
import { AGENT_CLIS, detectAgentClis, installCommand } from '../../../src/cli/install/agentClis.js';
import { preflight, preflightBlockers } from '../../../src/cli/install/preflight.js';
import { currentUser, userHome, ensureServiceUser } from '../../../src/cli/install/serviceUser.js';
import { ensureRipgrep, ensureSandboxSupport, ensureTerminalStreaming, planFromArgs } from '../../../src/cli/install/index.js';
import { isIpAddress } from '../../../src/cli/provision/deployment.js';
import type { Runner, ExecResult } from '../../../src/cli/install/runner.js';

function runner(over: Partial<Runner> = {}): Runner {
  return {
    exec: async (): Promise<ExecResult> => ({ code: 0, stdout: '', stderr: '' }),
    which: async () => null,
    writeFile: async () => {},
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

describe('install/ensureRipgrep', () => {
  it('installs ripgrep through the platform package manager when rg is missing', async () => {
    const linuxCalls: { cmd: string; args: string[] }[] = [];
    const linux = runner({
      which: async () => null,
      exec: async (cmd, args) => { linuxCalls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; },
    });
    await ensureRipgrep(linux, 'linux');
    expect(linuxCalls.map((call) => `${call.cmd} ${call.args.join(' ')}`)).toContain('apt-get install -y ripgrep');

    const macCalls: { cmd: string; args: string[] }[] = [];
    const mac = runner({
      which: async () => null,
      exec: async (cmd, args) => { macCalls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; },
    });
    await ensureRipgrep(mac, 'darwin');
    expect(macCalls.map((call) => `${call.cmd} ${call.args.join(' ')}`)).toContain('brew install ripgrep');
  });

  it('does nothing when rg already resolves', async () => {
    const calls: string[] = [];
    const present = runner({ which: async (cmd) => cmd === 'rg' ? '/usr/bin/rg' : null, exec: async (cmd) => { calls.push(cmd); return { code: 0, stdout: '', stderr: '' }; } });
    await ensureRipgrep(present, 'linux');
    expect(calls).toEqual([]);
  });
});

describe('install/ensureSandboxSupport', () => {
  it('installs bubblewrap on Linux when the launcher is missing', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const r = runner({
      which: async () => null,
      exec: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; },
    });
    await ensureSandboxSupport(r, 'linux');
    expect(calls.map((call) => `${call.cmd} ${call.args.join(' ')}`).some((line) => line.includes('apt-get install -y bubblewrap'))).toBe(true);
  });

  it('does nothing when bubblewrap exists or the platform is macOS', async () => {
    const calls: string[] = [];
    const present = runner({ which: async (cmd) => cmd === 'bwrap' ? '/usr/bin/bwrap' : null, exec: async (cmd) => { calls.push(cmd); return { code: 0, stdout: '', stderr: '' }; } });
    await ensureSandboxSupport(present, 'linux');
    await ensureSandboxSupport(present, 'darwin');
    expect(calls).toEqual([]);
  });
});

describe('install/ensureTerminalStreaming', () => {
  function recordingRunner(present: string[]) {
    const calls: { cmd: string; args: string[] }[] = [];
    const r: Runner = {
      exec: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; },
      which: async (cmd) => (present.includes(cmd) ? `/usr/bin/${cmd}` : null),
      writeFile: async () => {},
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

describe('install/planFromArgs (unattended flags)', () => {
  // getent finds nobody, so the plan always resolves mode=create — keeps these focused on parsing.
  const noUsers = runner({ exec: async () => ({ code: 2, stdout: '', stderr: '' }) });

  it('reads the flags it is given', async () => {
    const plan = await planFromArgs(noUsers, ['--unattended', '--user', 'deploy', '--agents', 'claude,codex', '--admin-user', 'root', '--admin-pass', 'hunter2']);
    expect(plan.user).toEqual({ mode: 'create', username: 'deploy' });
    expect(plan.agents).toEqual(['claude', 'codex']);
    expect(plan.admin?.username).toBe('root');
    expect(plan.admin?.password).toBe('hunter2');
  });

  // Every flag the help declares as taking a value. A valueless one used to read as absent, so
  // `--user --agents all` provisioned the DEFAULT user, `--domain --no-tls` quietly demoted the box to
  // localhost and half an admin pair skipped account creation — all reported as a successful install.
  // Nobody is watching an unattended run, so the parse has to die instead.
  const VALUE_FLAGS = [
    '--user', '--agents', '--domain', '--ip', '--host', '--proxy', '--email',
    '--admin-user', '--admin-pass',
    '--llm-url', '--llm-key', '--llm-model',
  ];

  it.each(VALUE_FLAGS)('rejects %s when it is written without a value', async (flag) => {
    await expect(planFromArgs(noUsers, ['--unattended', flag])).rejects.toThrow(`missing value for ${flag}`);
    // …and when the "value" is the next flag rather than the end of argv
    await expect(planFromArgs(noUsers, ['--unattended', flag, '--no-tmux'])).rejects.toThrow(`missing value for ${flag}`);
  });

  it('names every offending flag at once', async () => {
    await expect(planFromArgs(noUsers, ['--unattended', '--user', '--agents', '--email', 'a@b.c']))
      .rejects.toThrow('missing value for --user, --agents');
  });

  it('requires --admin-user and --admin-pass together, and creates no admin when neither is given', async () => {
    await expect(planFromArgs(noUsers, ['--unattended', '--admin-user', 'root'])).rejects.toThrow(/must be given together/);
    await expect(planFromArgs(noUsers, ['--unattended', '--admin-pass', 'hunter2'])).rejects.toThrow(/must be given together/);
    expect((await planFromArgs(noUsers, ['--unattended'])).admin).toBeNull();
  });

  // The swallow guard makes a value starting with `--` unreachable in the `--flag value` form; without
  // this escape a password like `--secret` simply could not be passed to an unattended install.
  it('accepts a value starting with -- through the `--flag=value` form', async () => {
    const plan = await planFromArgs(noUsers, ['--unattended', '--admin-user=root', '--admin-pass=--secret']);
    expect(plan.admin?.username).toBe('root');
    expect(plan.admin?.password).toBe('--secret');
  });

  it('reads the --llm-* flags into the admin answers, filling the other two from defaults', async () => {
    const plan = await planFromArgs(noUsers, [
      '--unattended', '--admin-user', 'root', '--admin-pass', 'hunter2',
      '--llm-url', 'https://llm.example/v1', '--llm-key', 'sk-test', '--llm-model', 'gpt-5',
    ]);
    expect(plan.admin?.llm).toEqual({ apiUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'gpt-5' });

    const keyOnly = await planFromArgs(noUsers, ['--unattended', '--admin-user', 'root', '--admin-pass', 'hunter2', '--llm-key', 'sk-test']);
    expect(keyOnly.admin?.llm).toEqual({ apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' });
  });

  it('saves no provider when the operator named none — the defaults are not a decision', async () => {
    // An install with no --llm-* flag used to still write an OpenAI endpoint (as the autopilot relay),
    // so a box provisioned for a local model came up pointing at api.openai.com.
    const plan = await planFromArgs(noUsers, ['--unattended', '--admin-user', 'root', '--admin-pass', 'hunter2']);
    expect(plan.admin?.llm).toBeUndefined();
  });

  it('--no-tmux is the only way to skip tmux', async () => {
    expect((await planFromArgs(noUsers, ['--unattended'])).installTmux).toBe(true);
    expect((await planFromArgs(noUsers, ['--unattended', '--no-tmux'])).installTmux).toBe(false);
  });

  describe.skipIf(process.platform === 'darwin')('deployment flags', () => {
    it('--host and its documented --ip alias both select direct port mode', async () => {
      // `--ip` is in the help and in the macOS warning, but deploymentFromArgs only ever read --host:
      // a documented `--ip 203.0.113.9` install silently came up on localhost.
      for (const flag of ['--host', '--ip']) {
        const plan = await planFromArgs(noUsers, ['--unattended', flag, '203.0.113.9']);
        expect(plan.deploy).toMatchObject({ mode: 'ip', host: '203.0.113.9' });
      }
    });

    it('--domain selects domain mode with its proxy, TLS and email flags', async () => {
      const plan = await planFromArgs(noUsers, ['--unattended', '--domain', 'elowen.example.com', '--proxy', 'apache', '--email', 'ops@example.com']);
      expect(plan.deploy).toMatchObject({ mode: 'domain', domain: 'elowen.example.com', proxyPreference: 'apache', tls: true, email: 'ops@example.com' });
      const noTls = await planFromArgs(noUsers, ['--unattended', '--domain', 'elowen.example.com', '--no-tls']);
      expect(noTls.deploy).toMatchObject({ mode: 'domain', tls: false, proxyPreference: 'nginx' });
    });

    it('a --domain that is really an IP becomes direct port mode (Let’s Encrypt cannot certify an IP)', async () => {
      expect((await planFromArgs(noUsers, ['--unattended', '--domain', '203.0.113.9'])).deploy).toMatchObject({ mode: 'ip' });
    });

    it('--localhost and no deployment flag at all both mean localhost', async () => {
      expect((await planFromArgs(noUsers, ['--unattended'])).deploy.mode).toBe('localhost');
      expect((await planFromArgs(noUsers, ['--unattended', '--localhost', '--domain', 'elowen.example.com'])).deploy.mode).toBe('localhost');
    });
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

  it('mode=existing returns the resolved HOME, created=false, and never calls useradd', async () => {
    const calls: string[] = [];
    const r = runner({ exec: async (cmd) => { calls.push(cmd); return passwd('/home/deploy'); } });
    const res = await ensureServiceUser(r, { mode: 'existing', username: 'deploy' });
    expect(res).toEqual({ username: 'deploy', home: '/home/deploy', created: false });
    expect(calls).not.toContain('useradd');
  });

  it('mode=existing throws when the user does not exist', async () => {
    const r = runner({ exec: async () => ({ code: 2, stdout: '', stderr: '' }) });
    await expect(ensureServiceUser(r, { mode: 'existing', username: 'ghost' })).rejects.toThrow(/does not exist/);
  });

  it('mode=create runs useradd --system with its own HOME when absent, and reports created=true', async () => {
    let useraddArgs: string[] = [];
    const r = runner({
      exec: async (cmd, args) => {
        if (cmd === 'getent') return { code: 2, stdout: '', stderr: '' };
        if (cmd === 'useradd') { useraddArgs = args; return { code: 0, stdout: '', stderr: '' }; }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const res = await ensureServiceUser(r, { mode: 'create', username: 'elowen' });
    expect(res).toEqual({ username: 'elowen', home: '/var/lib/elowen', created: true });
    expect(useraddArgs).toContain('--system');
    expect(useraddArgs).toContain('elowen');
  });

  // mode=create on an already-present user must NOT report created=true: no useradd ran, so the
  // uninstall must never treat the account as something this install made.
  it('mode=create on an existing user never runs useradd and reports created=false', async () => {
    const calls: string[] = [];
    const r = runner({ exec: async (cmd) => { calls.push(cmd); return passwd('/var/lib/elowen'); } });
    const res = await ensureServiceUser(r, { mode: 'create', username: 'elowen' });
    expect(res).toEqual({ username: 'elowen', home: '/var/lib/elowen', created: false });
    expect(calls).not.toContain('useradd');
  });
});
