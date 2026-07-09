import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import * as p from '../ui/prompts.js';
import { realRunner, type Runner } from './runner.js';
import { preflight, preflightBlockers } from './preflight.js';
import { ensureServiceUser, userHome, type ServiceUserChoice } from './serviceUser.js';
import { AGENT_CLIS, detectAgentClis, installCommand } from './agentClis.js';
import { daemonUnit, webUnit, updateService, updateTimer, elowenSudoers, type UnitParams } from './systemdUnits.js';
import { SERVICES } from '../systemd.js';
import { applySetup, buildSetupPlan, defaultExecForCli, isFirstRun, type SetupAnswers } from '../setup.js';
import { selfPrefix, reinstallNpmArgs } from '../update.js';
import { runOnboarding } from '../setup/wizard.js';
import { INSTALL_INFO_PATH, serializeInstallInfo, type InstallInfo } from '../installInfo.js';
import { must, aptInstall, step } from '../provision/exec.js';
import { type Deployment, isIpAddress, publicUrl, localhostDeploy, ipDeploy, chooseDeployment, provisionProxy } from '../provision/deployment.js';
import { beginInstaller } from '../ui/installer.js';

const DAEMON_PORT = Number((process.env.ELOWEN_PORT) ?? 4400);
const WEB_PORT = Number((process.env.ELOWEN_WEB_PORT) ?? 4500);

/** Everything `elowen install` needs to provision a box, resolved either interactively (modal prompts)
 *  or non-interactively (CLI flags). Collecting it up front keeps the two front-ends thin and lets the
 *  executor below stay prompt-free. `admin === null` means "don't create an admin" (e.g. re-run on a
 *  box that already has one). */
interface InstallPlan {
  installTmux: boolean;
  user: ServiceUserChoice;
  agents: string[];
  deploy: Deployment;
  admin: SetupAnswers | null;
}

// ── package + npm path resolution ────────────────────────────────────────────

/** Absolute paths into the globally-installed package — this file lives at
 *  <pkgRoot>/dist/cli/install/index.js, so the daemon entry and web bundle resolve relative to it. */
function packagePaths(): { daemonEntry: string; webServer: string } {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return { daemonEntry: join(pkgRoot, 'dist', 'daemon', 'index.js'), webServer: join(pkgRoot, 'web-dist', 'server.js') };
}

/** npm's global bin dir (where the `elowen` symlink + globally-installed agent CLIs land). */
async function npmGlobalBin(r: Runner): Promise<string> {
  const res = await r.exec('npm', ['prefix', '-g']);
  return join(res.stdout.trim() || '/usr/local', 'bin');
}

// ── small helpers ────────────────────────────────────────────────────────────

const base = `http://127.0.0.1:${DAEMON_PORT}`;

function bail(v: unknown): asserts v is string {
  if (p.isCancel(v)) { p.cancel('Installation cancelled.'); process.exit(1); }
}

/** Poll the daemon's /setup endpoint until it answers (services just came up) or we give up. */
async function waitForDaemon(tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${base}/setup`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/** End-to-end check: the admin can authenticate against the running daemon. */
async function loginSmokeTest(username: string, password: string): Promise<void> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login returned ${res.status}`);
  const body = await res.json() as { token?: string };
  if (!body.token) throw new Error('login returned no token');
}

// ── prompt-free executors (shared by interactive + unattended) ───────────────

/** Best-effort: enable the real-PTY terminal stream. node-pty (an optional dependency) needs a C
 *  toolchain to compile its native addon when no prebuilt binary matches, so ensure python3/make/g++,
 *  then install node-pty into the globally-installed elowen package where the daemon loads it from.
 *  A failure here is non-fatal — the terminal degrades to the snapshot mirror. */
export async function ensureTerminalStreaming(r: Runner): Promise<void> {
  if (!(await r.which('cc')) || !(await r.which('python3'))) await aptInstall(r, 'python3', 'make', 'g++');
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  await must(r, 'bash', ['-lc', `cd '${pkgRoot}' && npm install --no-save --no-audit --no-fund node-pty@1.0.0`]);
}

/** Write + enable the two systemd units and verify they came active. */
async function provisionSystemd(r: Runner, user: string, home: string, deploy: Deployment): Promise<void> {
  const { daemonEntry, webServer } = packagePaths();
  // Proxy-less IP mode is the only one that exposes the daemon: it binds 0.0.0.0 and advertises its
  // port to the browser, so the terminal WebSocket connects straight to it (no nginx `/ws/` hop). Behind
  // a proxy or on localhost the daemon stays private on 127.0.0.1 and the WS rides the web's own origin.
  const direct = deploy.mode === 'ip';
  const params: UnitParams = {
    user, home, nodePath: process.execPath, daemonEntry, webServer,
    npmGlobalBin: await npmGlobalBin(r), daemonPort: DAEMON_PORT, webPort: WEB_PORT, webHost: deploy.webHost,
    daemonHost: direct ? '0.0.0.0' : '127.0.0.1', wsDirectPort: direct ? DAEMON_PORT : undefined,
  };
  // Ensure the data tree exists and is owned by the service user before first boot.
  await must(r, 'mkdir', ['-p', join(home, '.config', 'elowen', 'logs')]);
  await must(r, 'chown', ['-R', `${user}:`, join(home, '.config', 'elowen')]);

  await r.writeFile('/etc/systemd/system/elowen-daemon.service', daemonUnit(params));
  await r.writeFile('/etc/systemd/system/elowen-web.service', webUnit(params));
  // The auto-update timer + its oneshot service ship disabled-by-default behaviour: the timer fires
  // hourly but the service no-ops unless the operator turns auto-update on in Settings.
  await r.writeFile('/etc/systemd/system/elowen-update.service', updateService(params));
  await r.writeFile('/etc/systemd/system/elowen-update.timer', updateTimer());
  await must(r, 'systemctl', ['daemon-reload']);
  for (const svc of SERVICES) await must(r, 'systemctl', ['enable', '--now', `${svc}.service`]);
  await must(r, 'systemctl', ['enable', '--now', 'elowen-update.timer']);

  for (const svc of SERVICES) {
    const res = await r.exec('systemctl', ['is-active', svc]);
    if (res.stdout.trim() !== 'active') throw new Error(`${svc} did not start (journalctl -u ${svc})`);
  }
}

/** Grant the service user passwordless systemctl for its own units, so the auto-update timer (and a
 *  manual `elowen update`) can take a freshly-installed binary live. Validated in a temp file with
 *  `visudo -cf` and only then atomically installed at 0440 — a malformed drop-in would break sudo for
 *  the whole box, so it's never written unchecked. */
async function provisionSudoers(r: Runner, user: string): Promise<void> {
  const tmp = '/tmp/elowen.sudoers';
  // Pin the literal self-reinstall command so `elowen update` (run as the service user) can sudo it.
  // Absolute npm path so sudo matches it; same prefix `elowen update` computes, so the two stay in lockstep.
  const npm = (await r.which('npm')) ?? '/usr/bin/npm';
  const reinstallCmd = [npm, ...reinstallNpmArgs(selfPrefix())].join(' ');
  await r.writeFile(tmp, elowenSudoers(user, reinstallCmd));
  const chk = await r.exec('visudo', ['-cf', tmp]);
  if (chk.code !== 0) { await r.exec('rm', ['-f', tmp]); throw new Error(`visudo rejected the drop-in: ${(chk.stderr || chk.stdout).trim()}`); }
  await must(r, 'install', ['-o', 'root', '-g', 'root', '-m', '0440', tmp, '/etc/sudoers.d/elowen']);
  await r.exec('rm', ['-f', tmp]);
}

/** Create the first admin from the plan (only when the daemon has no users yet) and prove login. */
async function provisionAdmin(answers: SetupAnswers): Promise<void> {
  if (!(await isFirstRun(fetch, base))) { p.log.info('Admin already exists — skipping account creation.'); return; }
  await applySetup(fetch, base, buildSetupPlan(answers));
  await loginSmokeTest(answers.username, answers.password);
}

/** Provision a box from a fully-resolved plan. Used directly by the unattended path; the interactive
 *  path drives the same executors with spinners and inline prompts. Returns whether TLS was obtained,
 *  so the caller can build the final URL (a non-fatal certbot failure leaves the site on HTTP). */
async function execute(r: Runner, plan: InstallPlan): Promise<{ tls: boolean }> {
  if (plan.installTmux) await step('Installing tmux', () => aptInstall(r, 'tmux'));

  const { home } = await step(`Service user "${plan.user.username}"`, () => ensureServiceUser(r, plan.user));

  for (const id of plan.agents) {
    const { cmd, args } = installCommand(agentCli(id));
    await step(`Installing ${id}`, () => must(r, cmd, args));
  }

  // Provision node-pty before the daemon boots, so it can load it on the first terminal WS. Non-fatal:
  // the daemon falls back to the snapshot mirror if this fails.
  await step('Enabling terminal streaming', () => ensureTerminalStreaming(r))
    .catch((e) => p.log.warn(`Terminal streaming unavailable (snapshot fallback stays active): ${(e as Error).message}`));

  await step('Configuring systemd services', () => provisionSystemd(r, plan.user.username, home, plan.deploy));

  // Non-fatal: without the sudoers drop-in the services still run — only in-place self-updates
  // (auto-update timer + manual `elowen update`) lose the ability to restart the units unattended.
  await step('Granting self-update permissions', () => provisionSudoers(r, plan.user.username))
    .catch((e) => p.log.warn(`Self-update permissions not granted (auto-update can't restart units until fixed): ${(e as Error).message}`));

  const ready = await step('Waiting for the daemon', () => waitForDaemon());
  if (!ready) throw new Error('daemon did not become reachable — check: journalctl -u elowen-daemon');

  const d = plan.deploy;
  const { tls: tlsOk } = await provisionProxy(r, d, { web: WEB_PORT, daemon: DAEMON_PORT });

  if (plan.admin) await step('Creating admin + verifying login', () => provisionAdmin(plan.admin!));

  // Record the deployment so the launcher menu shows the right URL and drives systemd (not a 2nd daemon).
  const info: InstallInfo = { publicUrl: publicUrl(d, tlsOk, WEB_PORT), mode: d.mode, serviceUser: plan.user.username, daemonPort: DAEMON_PORT, webPort: WEB_PORT };
  await must(r, 'mkdir', ['-p', '/etc/elowen']);
  await r.writeFile(INSTALL_INFO_PATH, serializeInstallInfo(info));
  return { tls: tlsOk };
}

function agentCli(id: string) {
  const cli = AGENT_CLIS.find((c) => c.id === id);
  if (!cli) throw new Error(`unknown agent CLI: ${id}`);
  return cli;
}

// ── unattended front-end ─────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Build a plan from CLI flags for `--unattended`. Resolves create-vs-existing from whether the user
 *  already exists, so the same command is idempotent across re-runs. */
async function planFromArgs(r: Runner, args: string[]): Promise<InstallPlan> {
  const username = flag(args, '--user') ?? 'elowen';
  const exists = (await userHome(r, username)) !== null;

  const agentsRaw = flag(args, '--agents');
  const agents = !agentsRaw || agentsRaw === 'none' ? []
    : agentsRaw === 'all' ? AGENT_CLIS.map((c) => c.id)
    : agentsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  const adminUser = flag(args, '--admin-user');
  const adminPass = flag(args, '--admin-pass');
  // `--autopilot-cli <claude|opencode|codex>` runs autopilot through an agent CLI (no API key);
  // otherwise the --llm-* flags configure the hosted-API engine.
  const autopilotCli = flag(args, '--autopilot-cli');
  const pilotExec = autopilotCli ? defaultExecForCli(autopilotCli, flag(args, '--autopilot-model')) : undefined;
  const admin: SetupAnswers | null = adminUser && adminPass
    ? { username: adminUser, password: adminPass, pilotExec, apiUrl: flag(args, '--llm-url') ?? 'https://api.openai.com/v1', apiKey: flag(args, '--llm-key') ?? '', model: flag(args, '--llm-model') ?? 'gpt-4o-mini' }
    : null;

  return {
    installTmux: !args.includes('--no-tmux'),
    user: { mode: exists ? 'existing' : 'create', username },
    agents,
    deploy: deploymentFromArgs(args),
    admin,
  };
}

/** Resolve the deployment from flags. `--host <ip>` (or `--ip`) ⇒ direct port mode; a real `--domain`
 *  ⇒ domain+HTTPS; a `--domain` that is actually an IP is treated as direct port mode (Let's Encrypt
 *  can't certify an IP); nothing ⇒ localhost. */
function deploymentFromArgs(args: string[]): Deployment {
  const host = flag(args, '--host');
  const domain = flag(args, '--domain');
  if (args.includes('--localhost')) return localhostDeploy();
  if (host) return ipDeploy(host);
  if (domain && isIpAddress(domain)) return ipDeploy(domain);
  if (domain) {
    return {
      mode: 'domain', host: domain, domain,
      proxyPreference: flag(args, '--proxy') === 'apache' ? 'apache' : 'nginx',
      tls: !args.includes('--no-tls'),
      email: flag(args, '--email') ?? null,
      webHost: '127.0.0.1',
    };
  }
  return localhostDeploy();
}

// ── interactive front-end ────────────────────────────────────────────────────

async function chooseServiceUser(): Promise<ServiceUserChoice> {
  const mode = await p.select({
    message: 'Which user should the ELOWEN services and agents run as?',
    options: [
      { value: 'create', label: 'Create a dedicated "elowen" system user', hint: 'recommended' },
      { value: 'existing', label: 'Use an existing user' },
    ],
  });
  bail(mode);
  const name = await p.text({
    message: mode === 'existing' ? 'Existing username' : 'New username',
    initialValue: mode === 'existing' ? '' : 'elowen',
    validate: (v) => (mode === 'existing' && !(v ?? '').trim() ? 'Required' : undefined),
  });
  bail(name);
  return { mode: mode as ServiceUserChoice['mode'], username: name.trim() || 'elowen' };
}

async function chooseAgents(r: Runner, user: string): Promise<string[]> {
  const detected = await detectAgentClis(r, user);
  const installed = detected.filter((c) => c.installed).map((c) => c.id);
  const missing = detected.filter((c) => !c.installed);
  if (installed.length) p.log.success(`Found agent CLIs: ${installed.join(', ')}`);
  if (!missing.length) return [];

  const pick = await p.multiselect({
    message: 'Install missing agent CLIs? (space to toggle, enter to confirm)',
    required: false,
    options: missing.map((c) => ({ value: c.id, label: c.id, hint: c.pkg })),
  });
  if (p.isCancel(pick)) return [];
  return pick as string[];
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Human recap of what the wizard is about to do — shown for confirmation before anything is touched. */
function planSummary(plan: InstallPlan): string {
  const pad = (s: string) => s.padEnd(9);
  const d = plan.deploy;
  const web = d.mode === 'domain'
    ? `${d.proxyPreference} → ${d.domain}${d.tls ? ' + HTTPS (Let’s Encrypt)' : ' (HTTP only)'}`
    : d.mode === 'ip'
      ? `http://${d.host}:${WEB_PORT} — direct, no reverse proxy`
      : `localhost only — http://localhost:${WEB_PORT}`;
  return [
    `${pad('User')}${plan.user.mode === 'create' ? `create system user "${plan.user.username}"` : `existing user "${plan.user.username}"`}`,
    `${pad('Agents')}${plan.agents.length ? plan.agents.join(', ') : 'none (install later)'}`,
    `${pad('tmux')}${plan.installTmux ? 'install' : 'present / skipped'}`,
    `${pad('Web')}${web}`,
    `${pad('Admin')}${plan.admin ? plan.admin.username : 'create interactively once the daemon is up'}`,
  ].join('\n');
}

/** `elowen install` — provision a fresh Debian/Ubuntu box. Run as root. Pass `--unattended` (with flags)
 *  for a non-interactive install; otherwise an interactive wizard collects every answer. */
const INSTALL_HELP = `elowen install - provision a fresh Debian/Ubuntu box as an elowen service (run as root)

USAGE
  elowen install                    interactive wizard (recommended)
  elowen install --unattended [options]

OPTIONS
  --unattended                    run non-interactively from the flags below
  --user <name>                   service user that runs the agents          (default: elowen)
  --agents <list>                 agent CLIs to install: all | none | claude,opencode,codex
  --no-tmux                       skip installing tmux

  Deployment (pick one; default is localhost):
  --domain <host>                 serve on a domain behind a reverse proxy (+ Let's Encrypt HTTPS)
  --ip <addr> | --host <addr>     serve directly on the public IP and port (no proxy)
  --localhost                     bind to localhost only
  --proxy <nginx|apache|none>     reverse proxy to configure for --domain
  --email <addr>                  contact email for Let's Encrypt renewal notices

  First admin + autopilot:
  --admin-user <name>             create the first admin account
  --admin-pass <pass>             admin password
  --autopilot-cli <cli>           run autopilot through an agent CLI (claude|opencode|codex) — no API key
  --autopilot-model <spec>        model for --autopilot-cli opencode (e.g. anthropic/claude-sonnet-4-5)
  --llm-url <url>                 hosted-API engine: base URL    (default: https://api.openai.com/v1)
  --llm-key <key>                 hosted-API engine: API key
  --llm-model <name>              hosted-API engine: model       (default: gpt-4o-mini)

  -h, --help                      show this help`;

export async function install(args: string[] = []): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(INSTALL_HELP); return; }
  const r = realRunner();
  const unattended = args.includes('--unattended');
  p.mascot();
  p.intro(`elowen install${unattended ? ' (unattended)' : ''}`);

  const pf = await preflight(r);
  const blockers = preflightBlockers(pf);
  if (blockers.length) { blockers.forEach((b) => p.log.error(b)); p.outro('Cannot continue.'); process.exit(1); }
  if (pf.tmux) p.log.success('tmux present');

  let plan: InstallPlan;
  if (unattended) {
    plan = await planFromArgs(r, args);
  } else {
    let installTmux = false;
    if (!pf.tmux) {
      const wantTmux = await p.confirm({ message: 'tmux is required to run agents and is not installed. Install it now?' });
      installTmux = !p.isCancel(wantTmux) && wantTmux === true;
      if (!installTmux) p.log.warn('Continuing without tmux — agents will not run until it is installed.');
    }
    const user = await chooseServiceUser();
    const agents = await chooseAgents(r, user.username);
    const deploy = await chooseDeployment(r, WEB_PORT);
    if (!deploy) { p.cancel('Installation cancelled.'); process.exit(1); }
    // Admin is created via the shared wizard AFTER the daemon is up, so collect it there instead.
    plan = { installTmux, user, agents, deploy, admin: null };
  }

  // Recap everything before touching the system — last chance to back out.
  p.note(planSummary(plan), 'Install plan');
  if (!unattended) {
    const go = await p.confirm({ message: 'Proceed with installation?' });
    if (p.isCancel(go) || !go) { p.cancel('Nothing was changed.'); process.exit(0); }
  }

  // All execute() progress paints into one persistent framed panel (spinner/log routed there) instead of
  // scrolling past as bare lines; on a non-TTY this is a no-op and steps stay plain log lines. Always tear
  // the panel down — even on failure — so a thrown step leaves the terminal in a clean state.
  const installer = beginInstaller('Installing Elowen');
  let tls: boolean;
  try {
    ({ tls } = await execute(r, plan));
  } finally {
    installer.stop();
  }

  // Interactive: now that the daemon is live, run the shared onboarding wizard (account, project, AI
  // provider, memory) — the SAME one as `elowen setup`, embedded so install frames the intro/outro. This
  // is the single onboarding path; there is no separate install wizard. The unattended path above already
  // created the admin from flags, so it skips this.
  let adminUser = plan.admin?.username ?? null;
  if (!unattended) adminUser = (await runOnboarding(base, process.env, { embedded: true })) ?? adminUser;

  const url = publicUrl(plan.deploy, tls, WEB_PORT);
  const summary = [
    `Open       ${url}`,
    adminUser ? `Sign in    ${adminUser}` : 'Sign in    create an admin in the web UI',
    `Status     systemctl status elowen-daemon elowen-web`,
    `Logs       journalctl -u elowen-daemon -f`,
    `Restart    systemctl restart elowen-daemon elowen-web`,
  ].join('\n');
  const doneBody = [...summary.split('\n'), '', `ELOWEN is live at ${url}`];
  // Interactive install ends on a distinct terminal DONE screen, held until the operator dismisses it
  // (enter/esc) — success is its own frame, not more scrollback. An unattended run must never block on a
  // keypress, so it just prints the frame.
  if (unattended) p.note(doneBody.join('\n'), 'ELOWEN is ready');
  else await p.doneScreen('ELOWEN is ready', doneBody);
}
