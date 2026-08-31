import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import * as p from '../ui/prompts.js';
import { realRunner, type Runner } from './runner.js';
import { preflight, preflightBlockers } from './preflight.js';
import { currentUser, ensureServiceUser, userHome, type ServiceUserChoice } from './serviceUser.js';
import { AGENT_CLIS, detectAgentClis, installCommand } from './agentClis.js';
import { daemonUnit, webUnit, updateService, updateTimer, elowenSudoers, type UnitParams } from './systemdUnits.js';
import { LAUNCHD_DAEMON_LABEL, LAUNCHD_UPDATE_LABEL, LAUNCHD_WEB_LABEL, agentPlistPath, daemonAgent, updateAgent, webAgent, type LaunchdParams } from './launchdUnits.js';
import { detectProxy } from './proxy.js';
import { SERVICES } from '../systemd.js';
import { applySetup, buildSetupPlan, isFirstRun, type SetupAnswers } from '../setup.js';
import { selfPrefix, reinstallNpmArgs } from '../update.js';
import { runOnboarding } from '../setup/wizard.js';
import { ELOWEN_CLI_VERSION } from '../version.js';
import { INSTALL_INFO_PATH, buildInstallInfo, serializeInstallInfo, type InstallArtifacts, type InstallUnit } from '../installInfo.js';
import { SITE_GATEWAY_DEPLOYMENT_PATH, SITE_GATEWAY_HELPER_PATH } from '../../shared/siteGateway.js';
import { must, aptInstall, step } from '../provision/exec.js';
import { type Deployment, isIpAddress, publicUrl, localhostDeploy, ipDeploy, chooseDeployment, provisionProxy } from '../provision/deployment.js';
import { beginInstaller } from '../ui/installer.js';
import { waitHealthy } from '../launcher.js';
import { flagValue as flag, requireFlagValues } from '../flags.js';

const DAEMON_PORT = Number((process.env.ELOWEN_PORT) ?? 4400);
const WEB_PORT = Number((process.env.ELOWEN_WEB_PORT) ?? 4500);
const SITE_GATEWAY_HELPER_SOURCE = fileURLToPath(new URL('../../../scripts/elowen-site-gateway.mjs', import.meta.url));

/** macOS provisions per-user launchd agents (current user, localhost, no sudo) instead of the Linux
 *  root+systemd+service-user model — the platform picks the whole provisioning shape, not one step. */
const MAC = process.platform === 'darwin';

/** Everything `elowen install` needs to provision a box, resolved either interactively (modal prompts)
 *  or non-interactively (CLI flags). Collecting it up front keeps the two front-ends thin and lets the
 *  executor below stay prompt-free. `admin === null` means "don't create an admin" (e.g. re-run on a
 *  box that already has one). */
export interface InstallPlan {
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

/** Poll the daemon's /setup endpoint until it answers (services just came up) or the budget runs out.
 *  Uses the shared readiness wait (launcher, `ensureDaemon`, `elowen setup`), so the 20s is a real
 *  deadline rather than 40 attempts that may each stall for their own timeout. */
async function waitForDaemon(budgetMs = 20_000): Promise<boolean> {
  const [ready = false] = await waitHealthy([`${base}/setup`], { budgetMs, pollMs: 500 });
  return ready;
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

/** Install the bounded content-search engine used by the bundled Files plugin. Search/Grep deliberately
 * fail closed without it: the former JS fallback read arbitrary whole files into the daemon heap. */
export async function ensureRipgrep(r: Runner, platform = process.platform): Promise<void> {
  if (await r.which('rg')) return;
  if (platform === 'darwin') await must(r, 'brew', ['install', 'ripgrep']);
  else await aptInstall(r, 'ripgrep');
}

/** Best-effort: enable the real-PTY terminal stream. node-pty (an optional dependency) needs a C
 *  toolchain to compile its native addon when no prebuilt binary matches, so ensure python3/make/g++,
 *  then install node-pty into the globally-installed elowen package where the daemon loads it from.
 *  A failure here is non-fatal — the terminal degrades to the snapshot mirror. */
export async function ensureTerminalStreaming(r: Runner, platform = process.platform): Promise<void> {
  // macOS ships python3 and gets cc from the Xcode CLT; there is no apt to fill a gap with, and npm can
  // still land a prebuilt binary — so only Linux tries to install the toolchain first.
  if (platform !== 'darwin' && (!(await r.which('cc')) || !(await r.which('python3')))) await aptInstall(r, 'python3', 'make', 'g++');
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  await must(r, 'bash', ['-lc', `cd '${pkgRoot}' && npm install --no-save --no-audit --no-fund node-pty@1.0.0`]);
}

/** Provision the Linux namespace launcher used by the bundled Sandbox plugin. Runtime readiness still runs
 * a real namespace probe because package presence alone cannot prove the host policy permits it. */
export async function ensureSandboxSupport(r: Runner, platform = process.platform): Promise<void> {
  if (platform === 'darwin' || await r.which('bwrap')) return;
  await aptInstall(r, 'bubblewrap');
}

/** Write + bootstrap the three launchd LaunchAgents (daemon, web, hourly update) in the invoking
 *  user's gui domain — the macOS counterpart of provisionSystemd. Idempotent: a stale bootstrap from a
 *  previous run is booted out first, so a re-install replaces rather than fails. Returns the plists it
 *  wrote (all three bootstrapped), which become part of the install record. */
async function provisionLaunchd(r: Runner, home: string): Promise<InstallUnit[]> {
  const { daemonEntry, webServer } = packagePaths();
  const params: LaunchdParams = {
    home, nodePath: process.execPath, daemonEntry, webServer,
    npmGlobalBin: await npmGlobalBin(r), daemonPort: DAEMON_PORT, webPort: WEB_PORT,
  };
  await must(r, 'mkdir', ['-p', join(home, '.config', 'elowen', 'logs')]);
  await must(r, 'mkdir', ['-p', join(home, 'Library', 'LaunchAgents')]);
  const uid = (await r.exec('id', ['-u'])).stdout.trim();
  const agents: [string, string][] = [
    [LAUNCHD_DAEMON_LABEL, daemonAgent(params)],
    [LAUNCHD_WEB_LABEL, webAgent(params)],
    [LAUNCHD_UPDATE_LABEL, updateAgent(params)],
  ];
  const written: InstallUnit[] = [];
  for (const [label, body] of agents) {
    const path = agentPlistPath(home, label);
    await r.writeFile(path, body);
    await r.exec('launchctl', ['bootout', `gui/${uid}/${label}`]); // expected to fail on a first install
    await must(r, 'launchctl', ['bootstrap', `gui/${uid}`, path]);
    written.push({ path, enabled: true });
  }
  return written;
}

/** Write + enable the two systemd units and verify they came active. Returns the unit files it wrote
 *  with their enabled state — the same literals the writes and `enable --now` calls use, so the record
 *  can never drift from what was actually enabled. */
async function provisionSystemd(r: Runner, user: string, home: string, deploy: Deployment): Promise<InstallUnit[]> {
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
  const paths = {
    daemon: '/etc/systemd/system/elowen-daemon.service',
    web: '/etc/systemd/system/elowen-web.service',
    update: '/etc/systemd/system/elowen-update.service',
    timer: '/etc/systemd/system/elowen-update.timer',
  };
  // Ensure the data tree exists and is owned by the service user before first boot.
  await must(r, 'mkdir', ['-p', join(home, '.config', 'elowen', 'logs')]);
  await must(r, 'chown', ['-R', `${user}:`, join(home, '.config', 'elowen')]);

  await r.writeFile(paths.daemon, daemonUnit(params));
  await r.writeFile(paths.web, webUnit(params));
  // The auto-update timer + its oneshot service ship disabled-by-default behaviour: the timer fires
  // hourly but the service no-ops unless the operator turns auto-update on in Settings.
  await r.writeFile(paths.update, updateService(params));
  await r.writeFile(paths.timer, updateTimer());
  await must(r, 'systemctl', ['daemon-reload']);
  for (const svc of SERVICES) await must(r, 'systemctl', ['enable', '--now', `${svc}.service`]);
  await must(r, 'systemctl', ['enable', '--now', 'elowen-update.timer']);

  for (const svc of SERVICES) {
    const res = await r.exec('systemctl', ['is-active', svc]);
    if (res.stdout.trim() !== 'active') throw new Error(`${svc} did not start (journalctl -u ${svc})`);
  }
  // The update service is never enabled directly — only its timer is; the daemon/web pair both are.
  return [
    { path: paths.daemon, enabled: true },
    { path: paths.web, enabled: true },
    { path: paths.update, enabled: false },
    { path: paths.timer, enabled: true },
  ];
}

/** Install the root-owned helper and its immutable deployment facts. The service user can later invoke
 * the helper, but cannot modify either file; the helper accepts no arguments and validates the bounded
 * JSON request arriving on stdin. Domain-independent paths and upstreams remain inside the helper. */
async function provisionSiteGatewayHelper(r: Runner, deploy: Deployment): Promise<boolean> {
  if (deploy.mode !== 'domain' || !deploy.domain) return false;
  const source = await readFile(SITE_GATEWAY_HELPER_SOURCE, 'utf8');
  const helperTmp = '/tmp/elowen-site-gateway';
  const deploymentTmp = '/tmp/elowen-site-gateway.json';
  await r.writeFile(helperTmp, source);
  await r.writeFile(deploymentTmp, `${JSON.stringify({ appHost: deploy.domain.toLowerCase(), daemonPort: DAEMON_PORT }, null, 2)}\n`);
  await must(r, 'mkdir', ['-p', dirname(SITE_GATEWAY_HELPER_PATH), dirname(SITE_GATEWAY_DEPLOYMENT_PATH)]);
  await must(r, 'install', ['-o', 'root', '-g', 'root', '-m', '0755', helperTmp, SITE_GATEWAY_HELPER_PATH]);
  await must(r, 'install', ['-o', 'root', '-g', 'root', '-m', '0644', deploymentTmp, SITE_GATEWAY_DEPLOYMENT_PATH]);
  await r.exec('rm', ['-f', helperTmp, deploymentTmp]);
  return true;
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
  if (plan.installTmux) await step('Installing tmux', () => (MAC ? must(r, 'brew', ['install', 'tmux']) : aptInstall(r, 'tmux')));
  await step('Installing ripgrep', () => ensureRipgrep(r));

  // serviceUserCreated is tri-state — created by useradd / pre-existing / macOS (invoking user, N/A) —
  // and must come from the executor's own result: the plan's create-vs-existing intent is not what ran
  // (mode=create on an already-present user never runs useradd, so nothing was created).
  let username: string;
  let home: string;
  let serviceUserCreated: boolean | null;
  if (MAC) {
    const me = await step('Resolving the current user', () => currentUser(r));
    username = me.username; home = me.home; serviceUserCreated = null;
  } else {
    const su = await step(`Service user "${plan.user.username}"`, () => ensureServiceUser(r, plan.user));
    username = su.username; home = su.home; serviceUserCreated = su.created;
  }

  for (const id of plan.agents) {
    const { cmd, args } = installCommand(agentCli(id));
    await step(`Installing ${id}`, () => must(r, cmd, args));
  }

  // The bundled Sandbox is the security boundary for every non-operator shell on Linux. Installation is
  // required here; readiness separately proves the host kernel/profile can actually create a namespace.
  await step('Installing Sandbox isolation', () => ensureSandboxSupport(r));

  // Provision node-pty before the daemon boots, so it can load it on the first terminal WS. Non-fatal:
  // the daemon falls back to the snapshot mirror if this fails.
  await step('Enabling terminal streaming', () => ensureTerminalStreaming(r))
    .catch((e) => p.log.warn(`Terminal streaming unavailable (snapshot fallback stays active): ${(e as Error).message}`));

  let units: InstallUnit[] = [];
  let sudoersCreated = false;
  let siteGatewayHelperCreated = false;
  if (MAC) {
    units = await step('Configuring launchd agents', () => provisionLaunchd(r, home));
  } else {
    units = await step('Configuring systemd services', () => provisionSystemd(r, plan.user.username, home, plan.deploy));

    await step('Installing published-sites gateway helper', () => provisionSiteGatewayHelper(r, plan.deploy))
      .then((created) => { siteGatewayHelperCreated = created; })
      .catch((e) => p.log.warn(`Published-sites gateway helper unavailable: ${(e as Error).message}`));

    // Non-fatal: without the sudoers drop-in the services still run — self-updates cannot restart units,
    // and a sites plugin cannot ask the root-owned gateway helper to apply its wildcard vhost.
    // macOS needs none of this: the agents run as the invoking user, who can already restart them.
    await step('Granting service permissions', () => provisionSudoers(r, plan.user.username))
      .then(() => { sudoersCreated = true; })
      .catch((e) => p.log.warn(`Service permissions not granted (self-update and published-sites gateway unavailable): ${(e as Error).message}`));
  }

  const ready = await step('Waiting for the daemon', () => waitForDaemon());
  if (!ready) throw new Error(`daemon did not become reachable — check: ${MAC ? `${home}/.config/elowen/logs/launchd-daemon.log` : 'journalctl -u elowen-daemon'}`);

  const d = plan.deploy;
  const { tls: tlsOk } = await provisionProxy(r, d, { web: WEB_PORT, daemon: DAEMON_PORT });

  if (plan.admin) await step('Creating admin + verifying login', () => provisionAdmin(plan.admin!));

  // provisionProxy resolves the proxy kind inside (detected-over-preference) and never reports it, so
  // re-detect at record time: the server it ends up configuring is exactly what `which` finds now, and
  // any failure in that phase aborts before this line — the detected kind is the one whose vhost exists.
  const proxyKind = d.mode === 'domain' ? await detectProxy(r) : null;
  const artifacts: InstallArtifacts = {
    version: ELOWEN_CLI_VERSION,
    installedAt: new Date().toISOString(),
    units,
    sudoers: sudoersCreated,
    siteGatewayHelper: siteGatewayHelperCreated,
    // Only a domain deployment writes a vhost; the path mirrors configureVhost's writes verbatim.
    proxy: proxyKind
      ? { kind: proxyKind, vhostPath: proxyKind === 'nginx' ? '/etc/nginx/sites-available/elowen.conf' : '/etc/apache2/sites-available/elowen.conf', tls: tlsOk }
      : undefined,
    serviceUserCreated,
    // Every CLI in the plan went through must() above — a failure would have aborted the run, so what
    // remains in the plan is exactly what was installed.
    agentClis: plan.agents,
  };

  // Record the deployment so the launcher menu shows the right URL and drives the provisioned services
  // (systemd units / launchd agents), never a second, port-conflicting daemon.
  const info = buildInstallInfo({ publicUrl: publicUrl(d, tlsOk, WEB_PORT), mode: d.mode, serviceUser: username, daemonPort: DAEMON_PORT, webPort: WEB_PORT }, artifacts);
  await must(r, 'mkdir', ['-p', dirname(INSTALL_INFO_PATH)]);
  await r.writeFile(INSTALL_INFO_PATH, serializeInstallInfo(info));
  return { tls: tlsOk };
}

function agentCli(id: string) {
  const cli = AGENT_CLIS.find((c) => c.id === id);
  if (!cli) throw new Error(`unknown agent CLI: ${id}`);
  return cli;
}

// ── unattended front-end ─────────────────────────────────────────────────────

/** Every `elowen install` flag that carries a value. Listed so a valueless one dies in the parser rather
 *  than provisioning a box from defaults nobody asked for. */
const VALUE_FLAGS = [
  '--user', '--agents', '--domain', '--ip', '--host', '--proxy', '--email',
  '--admin-user', '--admin-pass',
  '--llm-url', '--llm-key', '--llm-model',
] as const;

/** Build a plan from CLI flags for `--unattended`. Resolves create-vs-existing from whether the user
 *  already exists, so the same command is idempotent across re-runs. Throws on a malformed flag list:
 *  nobody is watching an unattended install, so a typo must stop it, not reshape it. */
export async function planFromArgs(r: Runner, args: string[]): Promise<InstallPlan> {
  requireFlagValues(args, VALUE_FLAGS);
  const username = flag(args, '--user') ?? 'elowen';
  const exists = MAC ? true : (await userHome(r, username)) !== null;

  const agentsRaw = flag(args, '--agents');
  const agents = !agentsRaw || agentsRaw === 'none' ? []
    : agentsRaw === 'all' ? AGENT_CLIS.map((c) => c.id)
    : agentsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  const adminUser = flag(args, '--admin-user');
  const adminPass = flag(args, '--admin-pass');
  // Half a credential pair is a typo, not a decision to skip the admin: creating no account at all while
  // reporting a successful install leaves a box nobody can sign in to.
  if ((adminUser === undefined) !== (adminPass === undefined)) {
    throw new Error('elowen install: --admin-user and --admin-pass must be given together (pass both to create the first admin, or neither to create it later)');
  }
  // The --llm-* flags connect the ASSISTANT's model provider. Only when at least one was passed: the
  // defaults below are a convenience for filling in the other two, never a reason to save an OpenAI
  // endpoint on a box whose operator never mentioned one.
  const llmUrl = flag(args, '--llm-url');
  const llmKey = flag(args, '--llm-key');
  const llmModel = flag(args, '--llm-model');
  const llm = (llmUrl || llmKey || llmModel)
    ? { apiUrl: llmUrl ?? 'https://api.openai.com/v1', apiKey: llmKey ?? '', model: llmModel ?? 'gpt-4o-mini' }
    : undefined;
  const admin: SetupAnswers | null = adminUser && adminPass
    ? { username: adminUser, password: adminPass, ...(llm ? { llm } : {}) }
    : null;

  // macOS: everything runs as the invoking user on localhost — a --user/--domain/--ip flag has nothing
  // to configure there, so say so instead of silently honouring half of it.
  if (MAC && (flag(args, '--user') || flag(args, '--domain') || flag(args, '--ip') || flag(args, '--host'))) {
    p.log.warn('macOS installs run as the current user on localhost — ignoring --user/--domain/--ip.');
  }
  return {
    installTmux: !args.includes('--no-tmux'),
    user: { mode: exists ? 'existing' : 'create', username },
    agents,
    deploy: MAC ? localhostDeploy() : deploymentFromArgs(args),
    admin,
  };
}

/** Resolve the deployment from flags. `--host <ip>` (or `--ip`) ⇒ direct port mode; a real `--domain`
 *  ⇒ domain+HTTPS; a `--domain` that is actually an IP is treated as direct port mode (Let's Encrypt
 *  can't certify an IP); nothing ⇒ localhost. */
function deploymentFromArgs(args: string[]): Deployment {
  const host = flag(args, '--host') ?? flag(args, '--ip');
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
  const user = MAC ? `current user "${plan.user.username}" — launchd agents, no sudo`
    : plan.user.mode === 'create' ? `create system user "${plan.user.username}"` : `existing user "${plan.user.username}"`;
  return [
    `${pad('User')}${user}`,
    `${pad('Agents')}${plan.agents.length ? plan.agents.join(', ') : 'none (install later)'}`,
    `${pad('tmux')}${plan.installTmux ? `install${MAC ? ' (brew)' : ''}` : 'present / skipped'}`,
    `${pad('Web')}${web}`,
    `${pad('Admin')}${plan.admin ? plan.admin.username : 'create interactively once the daemon is up'}`,
  ].join('\n');
}

/** `elowen install` — provision a fresh box. Linux (Debian/Ubuntu, run as root): systemd services and a
 *  dedicated service user. macOS (run as yourself, NO sudo): per-user launchd agents on localhost. Pass
 *  `--unattended` (with flags) for a non-interactive install; otherwise a wizard collects every answer. */
const INSTALL_HELP = `elowen install - provision this machine as an elowen service
  Linux (Debian/Ubuntu)  run as root: systemd services + a dedicated service user
  macOS                  run as yourself (no sudo): per-user launchd agents, localhost only

USAGE
  elowen install                    interactive wizard (recommended)
  elowen install --unattended [options]

OPTIONS
  A flag that takes a value REQUIRES one: a bare \`--flag\` is a parse error, never a silent default.
  Write \`--flag=value\` when the value itself starts with \`--\` (e.g. a password).

  --unattended                    run non-interactively from the flags below
  --user <name>                   service user that runs the agents          (Linux only; default: elowen)
  --agents <list>                 agent CLIs to install: all | none | claude,opencode,codex
  --no-tmux                       skip installing tmux

  Deployment (Linux only — macOS is always localhost; default is localhost):
  --domain <host>                 serve on a domain behind a reverse proxy (+ Let's Encrypt HTTPS)
  --ip <addr> | --host <addr>     serve directly on the public IP and port (no proxy)
  --localhost                     bind to localhost only
  --proxy <nginx|apache>          reverse proxy to configure for --domain
  --email <addr>                  contact email for Let's Encrypt renewal notices

  First admin + the assistant's model access:
  --admin-user <name>             create the first admin account   (with --admin-pass; both or neither)
  --admin-pass <pass>             admin password
  --llm-url <url>                 OpenAI-compatible base URL     (default: https://api.openai.com/v1)
  --llm-key <key>                 API key (omit for a keyless local endpoint)
  --llm-model <name>              default model                  (default: gpt-4o-mini)

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
      const wantTmux = await p.confirm({ message: `tmux is required to run agents and is not installed. Install it now${MAC ? ' (brew)' : ''}?` });
      installTmux = !p.isCancel(wantTmux) && wantTmux === true;
      if (!installTmux) p.log.warn('Continuing without tmux — agents will not run until it is installed.');
    }
    // macOS has neither question: the agents run as the invoking user (launchd gui domain) and the box
    // is a personal machine, so the deployment is localhost by definition.
    const user = MAC ? await currentUser(r).then(({ username }): ServiceUserChoice => ({ mode: 'existing', username })) : await chooseServiceUser();
    const agents = await chooseAgents(r, user.username);
    const deploy = MAC ? localhostDeploy() : await chooseDeployment(r, WEB_PORT);
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
    ...serviceSummary(MAC),
  ].join('\n');
  const doneBody = [...summary.split('\n'), '', `ELOWEN is live at ${url}`];
  // Interactive install ends on a distinct terminal DONE screen, held until the operator dismisses it
  // (enter/esc) — success is its own frame, not more scrollback. An unattended run must never block on a
  // keypress, so it just prints the frame.
  if (unattended) p.note(doneBody.join('\n'), 'ELOWEN is ready');
  else await p.doneScreen('ELOWEN is ready', doneBody);
}

/** Platform-specific service commands printed on the installer's final screen. Linux restart guidance
 *  goes through the CLI so an operator copying it from inside an Elowen turn cannot reintroduce the
 *  blocking self-restart deadlock. Kept pure for the summary contract test. */
export function serviceSummary(mac: boolean): string[] {
  return mac ? [
    `Status     launchctl print gui/$(id -u)/io.elowen.daemon`,
    `Logs       tail -f ~/.config/elowen/logs/launchd-daemon.log`,
    `Restart    launchctl kickstart -k gui/$(id -u)/io.elowen.daemon`,
  ] : [
    `Status     systemctl status elowen-daemon elowen-web`,
    `Logs       journalctl -u elowen-daemon -f`,
    `Restart    elowen restart all`,
  ];
}
