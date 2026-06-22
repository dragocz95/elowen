import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import * as p from '@clack/prompts';
import { realRunner, type Runner } from './runner.js';
import { preflight, preflightBlockers } from './preflight.js';
import { ensureServiceUser, userHome, type ServiceUserChoice } from './serviceUser.js';
import { detectAgentClis, installCommand } from './agentClis.js';
import { daemonUnit, webUnit, type UnitParams } from './systemdUnits.js';
import { detectProxy, nginxVhost, apacheVhost, certbotCommand, type ProxyKind } from './proxy.js';
import { applySetup, buildSetupPlan, defaultExecForCli, isFirstRun, type SetupAnswers } from '../setup.js';
import { runSetupWizard } from '../setupWizard.js';
import { INSTALL_INFO_PATH, serializeInstallInfo, type InstallInfo } from '../installInfo.js';

const DAEMON_PORT = Number(process.env.ORCA_PORT ?? 4400);
const WEB_PORT = Number(process.env.ORCA_WEB_PORT ?? 4500);

/** How the web UI is reached. Drives the reverse proxy, the web's bind interface and the canonical URL.
 *   - domain:    nginx/apache vhost + (optional) Let's Encrypt; web bound to 127.0.0.1.
 *   - ip:        no reverse proxy — the web binds 0.0.0.0 and the browser hits http://<host>:<webPort>.
 *   - localhost: no reverse proxy, web bound to 127.0.0.1, reachable only on the box. */
type DeployMode = 'domain' | 'ip' | 'localhost';

interface Deployment {
  mode: DeployMode;
  /** Host shown in the public URL: the domain, the server's public IP, or 'localhost'. */
  host: string;
  /** Domain to certify/proxy — set only in 'domain' mode. */
  domain: string | null;
  proxyPreference: ProxyKind;
  /** Intended TLS (domain mode only); the effective result is returned by execute(). */
  tls: boolean;
  email: string | null;
  /** Interface the web server binds: 0.0.0.0 for 'ip', 127.0.0.1 otherwise. */
  webHost: string;
}

/** Everything `orca install` needs to provision a box, resolved either interactively (clack prompts)
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

/** Canonical public URL for a deployment, given whether TLS actually came up. */
function publicUrl(d: Deployment, tlsOk: boolean): string {
  if (d.mode === 'domain') return `${tlsOk ? 'https' : 'http'}://${d.host}`;
  if (d.mode === 'ip') return `http://${d.host}:${WEB_PORT}`;
  return `http://localhost:${WEB_PORT}`;
}

const localhostDeploy = (): Deployment => ({ mode: 'localhost', host: 'localhost', domain: null, proxyPreference: 'nginx', tls: false, email: null, webHost: '127.0.0.1' });
const ipDeploy = (host: string): Deployment => ({ mode: 'ip', host, domain: null, proxyPreference: 'nginx', tls: false, email: null, webHost: '0.0.0.0' });

// ── package + npm path resolution ────────────────────────────────────────────

/** Absolute paths into the globally-installed package — this file lives at
 *  <pkgRoot>/dist/cli/install/index.js, so the daemon entry and web bundle resolve relative to it. */
function packagePaths(): { daemonEntry: string; webServer: string } {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return { daemonEntry: join(pkgRoot, 'dist', 'daemon', 'index.js'), webServer: join(pkgRoot, 'web-dist', 'server.js') };
}

/** npm's global bin dir (where the `orca` symlink + globally-installed agent CLIs land). */
async function npmGlobalBin(r: Runner): Promise<string> {
  const res = await r.exec('npm', ['prefix', '-g']);
  return join(res.stdout.trim() || '/usr/local', 'bin');
}

// ── small helpers ────────────────────────────────────────────────────────────

const base = `http://127.0.0.1:${DAEMON_PORT}`;

function bail(v: unknown): asserts v is string {
  if (p.isCancel(v)) { p.cancel('Installation cancelled.'); process.exit(1); }
}

/** True for a bare IPv4/IPv6 host. Let's Encrypt only issues for registered domain names, so we never
 *  offer (or attempt) HTTPS for an IP — certbot would fail every time. */
export function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // Off a TTY (unattended / CI / piped logs) a spinner just spams frames — emit one line per step.
  if (!process.stdout.isTTY) {
    try { const out = await fn(); p.log.success(label); return out; }
    catch (e) { p.log.error(`${label} — failed`); throw e; }
  }
  const s = p.spinner();
  s.start(label);
  try { const out = await fn(); s.stop(`${label} ✓`); return out; }
  catch (e) { s.stop(`${label} ✗`); throw e; }
}

/** Run a command and throw with its stderr when it fails — used for the system mutations where a
 *  non-zero exit must abort the wizard rather than silently continue. */
async function must(r: Runner, cmd: string, args: string[], opts?: { user?: string }): Promise<void> {
  const res = await r.exec(cmd, args, opts);
  if (res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim() || res.code}`);
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

async function aptInstall(r: Runner, ...pkgs: string[]): Promise<void> {
  await must(r, 'apt-get', ['update']);
  await must(r, 'apt-get', ['install', '-y', ...pkgs]);
}

/** Write + enable the two systemd units and verify they came active. */
async function provisionSystemd(r: Runner, user: string, home: string, webHost: string): Promise<void> {
  const { daemonEntry, webServer } = packagePaths();
  const params: UnitParams = {
    user, home, nodePath: process.execPath, daemonEntry, webServer,
    npmGlobalBin: await npmGlobalBin(r), daemonPort: DAEMON_PORT, webPort: WEB_PORT, webHost,
  };
  // Ensure the data tree exists and is owned by the service user before first boot.
  await must(r, 'mkdir', ['-p', join(home, '.config', 'orca', 'logs')]);
  await must(r, 'chown', ['-R', `${user}:`, join(home, '.config', 'orca')]);

  await r.writeFile('/etc/systemd/system/orca-daemon.service', daemonUnit(params));
  await r.writeFile('/etc/systemd/system/orca-web.service', webUnit(params));
  await must(r, 'systemctl', ['daemon-reload']);
  await must(r, 'systemctl', ['enable', '--now', 'orca-daemon.service']);
  await must(r, 'systemctl', ['enable', '--now', 'orca-web.service']);

  for (const svc of ['orca-daemon', 'orca-web']) {
    const res = await r.exec('systemctl', ['is-active', svc]);
    if (res.stdout.trim() !== 'active') throw new Error(`${svc} did not start (journalctl -u ${svc})`);
  }
}

/** Detect the installed reverse proxy, installing the preferred one when none is present. */
async function resolveProxy(r: Runner, preference: ProxyKind): Promise<ProxyKind> {
  const existing = await detectProxy(r);
  if (existing) return existing;
  await aptInstall(r, preference === 'nginx' ? 'nginx' : 'apache2');
  return preference;
}

/** Render the vhost for the domain and make the proxy serve it. */
async function configureVhost(r: Runner, kind: ProxyKind, domain: string): Promise<void> {
  if (kind === 'nginx') {
    await r.writeFile('/etc/nginx/sites-available/orca.conf', nginxVhost(domain, WEB_PORT));
    await must(r, 'ln', ['-sf', '/etc/nginx/sites-available/orca.conf', '/etc/nginx/sites-enabled/orca.conf']);
    await must(r, 'nginx', ['-t']);
    await must(r, 'systemctl', ['reload', 'nginx']);
  } else {
    await r.writeFile('/etc/apache2/sites-available/orca.conf', apacheVhost(domain, WEB_PORT));
    await must(r, 'a2enmod', ['proxy', 'proxy_http']);
    await must(r, 'a2ensite', ['orca']);
    await must(r, 'systemctl', ['reload', 'apache2']);
  }
}

/** Install certbot if needed and obtain + install a Let's Encrypt certificate. */
async function obtainTls(r: Runner, kind: ProxyKind, domain: string, email: string | null): Promise<void> {
  if (!(await r.which('certbot'))) {
    await aptInstall(r, 'certbot', kind === 'nginx' ? 'python3-certbot-nginx' : 'python3-certbot-apache');
  }
  const { cmd, args } = certbotCommand(kind, domain, email ?? undefined);
  await must(r, cmd, args);
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
    const { cmd, args } = installCommand({ id, bin: id, pkg: agentPkg(id) });
    await step(`Installing ${id}`, () => must(r, cmd, args));
  }

  await step('Configuring systemd services', () => provisionSystemd(r, plan.user.username, home, plan.deploy.webHost));

  const ready = await step('Waiting for the daemon', () => waitForDaemon());
  if (!ready) throw new Error('daemon did not become reachable — check: journalctl -u orca-daemon');

  const d = plan.deploy;
  let tlsOk = false;
  if (d.mode === 'domain' && d.domain) {
    const kind = await step('Configuring reverse proxy', async () => {
      const k = await resolveProxy(r, d.proxyPreference);
      await configureVhost(r, k, d.domain!);
      return k;
    });
    // TLS is the last, optional, most failure-prone step (DNS not pointed yet, rate limits, IPs). A
    // failure here must NOT abort the install — the site already serves over HTTP and the admin still
    // needs creating — so we warn and carry on rather than throwing.
    if (d.tls) {
      try { await step('Requesting HTTPS certificate', () => obtainTls(r, kind, d.domain!, d.email)); tlsOk = true; }
      catch (e) { p.log.warn(`HTTPS setup failed: ${(e as Error).message}\nThe site is up over HTTP — re-run certbot once the domain's DNS points here.`); }
    }
  }

  if (plan.admin) await step('Creating admin + verifying login', () => provisionAdmin(plan.admin!));

  // Record the deployment so the launcher menu shows the right URL and drives systemd (not a 2nd daemon).
  const info: InstallInfo = { publicUrl: publicUrl(d, tlsOk), mode: d.mode, serviceUser: plan.user.username, daemonPort: DAEMON_PORT, webPort: WEB_PORT };
  await must(r, 'mkdir', ['-p', '/etc/orca']);
  await r.writeFile(INSTALL_INFO_PATH, serializeInstallInfo(info));
  return { tls: tlsOk };
}

/** npm package for an agent CLI id (so the executor needn't carry the full AgentCli around). */
function agentPkg(id: string): string {
  const map: Record<string, string> = { claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai', codex: '@openai/codex' };
  const pkg = map[id];
  if (!pkg) throw new Error(`unknown agent CLI: ${id}`);
  return pkg;
}

// ── unattended front-end ─────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Build a plan from CLI flags for `--unattended`. Resolves create-vs-existing from whether the user
 *  already exists, so the same command is idempotent across re-runs. */
async function planFromArgs(r: Runner, args: string[]): Promise<InstallPlan> {
  const username = flag(args, '--user') ?? 'orca';
  const exists = (await userHome(r, username)) !== null;

  const agentsRaw = flag(args, '--agents');
  const agents = !agentsRaw || agentsRaw === 'none' ? []
    : agentsRaw === 'all' ? ['claude', 'opencode', 'codex']
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
    message: 'Which user should the ORCA services and agents run as?',
    options: [
      { value: 'create', label: 'Create a dedicated "orca" system user', hint: 'recommended' },
      { value: 'existing', label: 'Use an existing user' },
    ],
  });
  bail(mode);
  const name = await p.text({
    message: mode === 'existing' ? 'Existing username' : 'New username',
    initialValue: mode === 'existing' ? '' : 'orca',
    validate: (v) => (mode === 'existing' && !(v ?? '').trim() ? 'Required' : undefined),
  });
  bail(name);
  return { mode: mode as ServiceUserChoice['mode'], username: name.trim() || 'orca' };
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

/** Best-effort public IPv4 of this box, used as the default for the direct-port mode. Prefers the
 *  first global address from `hostname -I`; empty string when none can be determined. */
async function detectPublicIp(r: Runner): Promise<string> {
  const res = await r.exec('hostname', ['-I']);
  const first = res.stdout.trim().split(/\s+/).find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith('127.'));
  return first ?? '';
}

async function chooseDeployment(r: Runner): Promise<Deployment> {
  const mode = await p.select({
    message: 'How will you reach the ORCA web UI?',
    options: [
      { value: 'domain', label: 'A domain name', hint: 'nginx + free HTTPS (Let’s Encrypt)' },
      { value: 'ip', label: 'This server’s IP, on a port', hint: `http://<ip>:${WEB_PORT} — no reverse proxy` },
      { value: 'localhost', label: 'Localhost only', hint: `http://localhost:${WEB_PORT}` },
    ],
  });
  bail(mode);

  if (mode === 'localhost') return localhostDeploy();

  if (mode === 'ip') {
    const guess = await detectPublicIp(r);
    const host = await p.text({ message: 'Public IP / hostname to advertise', initialValue: guess, validate: (v) => ((v ?? '').trim() ? undefined : 'Required') });
    bail(host);
    p.log.info(`The web UI will listen on 0.0.0.0:${WEB_PORT} — make sure port ${WEB_PORT} is open in any firewall.`);
    return ipDeploy(host.trim());
  }

  // domain
  const domain = await p.text({ message: 'Domain name', placeholder: 'orca.example.com', validate: (v) => {
    const t = (v ?? '').trim();
    if (!t) return 'Required';
    if (isIpAddress(t)) return 'That’s an IP — pick the IP option instead (Let’s Encrypt needs a domain name)';
    return undefined;
  } });
  bail(domain);

  let proxyPreference: ProxyKind = 'nginx';
  if (!(await detectProxy(r))) {
    const which = await p.select({
      message: 'No reverse proxy found. Install one?',
      options: [{ value: 'nginx', label: 'nginx', hint: 'recommended' }, { value: 'apache', label: 'apache2' }],
    });
    bail(which);
    proxyPreference = which as ProxyKind;
  }

  const wantTls = await p.confirm({ message: `Obtain a free HTTPS certificate for ${domain.trim()} via Let's Encrypt?` });
  if (p.isCancel(wantTls) || !wantTls) return { mode: 'domain', host: domain.trim(), domain: domain.trim(), proxyPreference, tls: false, email: null, webHost: '127.0.0.1' };
  const email = await p.text({ message: 'Email for renewal notices (blank to register without email)', placeholder: 'you@example.com' });
  bail(email);
  return { mode: 'domain', host: domain.trim(), domain: domain.trim(), proxyPreference, tls: true, email: email.trim() || null, webHost: '127.0.0.1' };
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

/** `orca install` — provision a fresh Debian/Ubuntu box. Run as root. Pass `--unattended` (with flags)
 *  for a non-interactive install; otherwise an interactive wizard collects every answer. */
const INSTALL_HELP = `🐋 orca install — provision a fresh Debian/Ubuntu box as an orca service (run as root)

USAGE
  orca install                    interactive wizard (recommended)
  orca install --unattended [options]

OPTIONS
  --unattended                    run non-interactively from the flags below
  --user <name>                   service user that runs the agents          (default: orca)
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
  p.intro(`🐋 orca install${unattended ? ' (unattended)' : ''}`);

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
    const deploy = await chooseDeployment(r);
    // Admin is created via the shared wizard AFTER the daemon is up, so collect it there instead.
    plan = { installTmux, user, agents, deploy, admin: null };
  }

  // Recap everything before touching the system — last chance to back out.
  p.note(planSummary(plan), 'Install plan');
  if (!unattended) {
    const go = await p.confirm({ message: 'Proceed with installation?' });
    if (p.isCancel(go) || !go) { p.cancel('Nothing was changed.'); process.exit(0); }
  }

  const { tls } = await execute(r, plan);

  // Interactive: now that the daemon is live, run the shared first-run wizard for the admin + LLM.
  let adminUser = plan.admin?.username ?? null;
  if (!unattended) {
    p.log.step('Create the first admin account');
    const creds = await runSetupWizard(base);
    if (creds) { adminUser = creds.username; await step('Verifying login', () => loginSmokeTest(creds.username, creds.password)); }
  }

  const url = publicUrl(plan.deploy, tls);
  const summary = [
    `Open       ${url}`,
    adminUser ? `Sign in    ${adminUser}` : 'Sign in    create an admin in the web UI',
    `Status     systemctl status orca-daemon orca-web`,
    `Logs       journalctl -u orca-daemon -f`,
    `Restart    systemctl restart orca-daemon orca-web`,
  ].join('\n');
  p.note(summary, 'ORCA is ready 🐋');
  p.outro(`Done — ORCA is live at ${url}`);
}
