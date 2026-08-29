import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import * as p from './ui/prompts.js';
import { realRunner, type Runner } from './install/runner.js';
import { userHome } from './install/serviceUser.js';
import { INSTALL_INFO_PATH, readInstallInfo, sanitizeInstallInfo, type InstallInfo } from './installInfo.js';
import { LAUNCHD_DAEMON_LABEL, LAUNCHD_UPDATE_LABEL, LAUNCHD_WEB_LABEL, agentPlistPath } from './install/launchdUnits.js';
import { AGENT_CLIS } from './install/agentClis.js';
import { SITE_GATEWAY_DEPLOYMENT_PATH, SITE_GATEWAY_HELPER_PATH } from '../shared/siteGateway.js';

/** One teardown action. `label` feeds the plan, the confirmation and `--dry-run`; `run` performs the
 *  mutation; `manual` is the exact command to run by hand when `run` fails — so a partially-failed
 *  uninstall always ends with a usable recipe instead of a dead end. */
interface Step {
  label: string;
  run: () => Promise<void>;
  manual: string;
}

export interface UninstallDeps {
  /** Every system mutation goes through here; tests inject a recording fake and never touch the host. */
  runner: Runner;
  /** Returns true to proceed. Default wraps prompts.confirm (a cancel reads as "no"). */
  confirm: (message: string) => Promise<boolean>;
  out: (msg: string) => void;
  err: (msg: string) => void;
  /** Reads the install record; injectable so tests never touch /etc/elowen. */
  readInfo: (path: string) => InstallInfo | null;
  installInfoPath: string;
  platform: NodeJS.Platform;
  /** Invoking user's HOME — where launchd plists and the macOS data dir live. */
  home: string;
}

/** systemctl/launchctl/userdel errors that mean "already gone". A second `elowen uninstall` — or a unit
 *  somebody removed by hand — must read as a met goal, not a failure; the idempotence contract depends on
 *  it. Anything else is a real error and fails the step. */
//  `Boot-out failed: 5: Input/output error` is launchctl's own way of saying "that agent is not
//  loaded" on Sonoma and newer — it reports the generic errno rather than the older "Could not find
//  service" text, so without it a second run on a current Mac ends with three failed steps.
const ALREADY_GONE = /could not be found|could not find|not loaded|no such file|does not exist|no such user|boot-out failed: 5/i;

async function execTolerate(deps: UninstallDeps, cmd: string, args: string[]): Promise<void> {
  const res = await deps.runner.exec(cmd, args);
  if (res.code === 0 || ALREADY_GONE.test(`${res.stdout}\n${res.stderr}`)) return;
  throw new Error(`${cmd} ${args.join(' ')} failed: ${`${res.stdout}\n${res.stderr}`.trim() || res.code}`);
}

async function execOk(deps: UninstallDeps, cmd: string, args: string[]): Promise<void> {
  const res = await deps.runner.exec(cmd, args);
  if (res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${`${res.stdout}\n${res.stderr}`.trim() || res.code}`);
}

/** rm -f: a missing file is success by construction, so no tolerance pattern is needed here. */
async function rm(deps: UninstallDeps, path: string): Promise<void> {
  const res = await deps.runner.exec('rm', ['-f', path]);
  if (res.code !== 0) throw new Error(`rm -f ${path} failed: ${`${res.stdout}\n${res.stderr}`.trim() || res.code}`);
}

async function rmRf(deps: UninstallDeps, path: string): Promise<void> {
  const res = await deps.runner.exec('rm', ['-rf', path]);
  if (res.code !== 0) throw new Error(`rm -rf ${path} failed: ${`${res.stdout}\n${res.stderr}`.trim() || res.code}`);
}

/** The sudoers drop-in `elowen install` writes (provisionSudoers' literal). Removed only when the record
 *  proves this install wrote it — never by name alone. */
const SUDOERS_PATH = '/etc/sudoers.d/elowen';

/** The unit files `elowen install` writes — provisionSystemd's literals (install/index.ts), mirrored here
 *  for the no-record fallback. A record with artifacts always wins over this list; keep the two in lockstep. */
const KNOWN_LINUX_UNITS: { path: string; enabled: boolean }[] = [
  { path: '/etc/systemd/system/elowen-daemon.service', enabled: true },
  { path: '/etc/systemd/system/elowen-web.service', enabled: true },
  { path: '/etc/systemd/system/elowen-update.service', enabled: false },
  { path: '/etc/systemd/system/elowen-update.timer', enabled: true },
];

/** Only ever remove a unit whose path looks like the elowen units install writes. install.json is
 *  root-writable, so a corrupted record must not turn `elowen uninstall` into `rm` of an arbitrary path —
 *  the record is our inventory, but the shapes it may name are unit files, not anything. */
function unitName(path: string): string | null {
  const name = basename(path);
  return path.startsWith('/') && /^elowen-[a-z0-9-]+\.(service|timer)$/.test(name) ? name : null;
}

/** The sites-enabled link configureVhost creates next to the vhost (ln -sf). Derived from the recorded
 *  vhost path, never guessed: the link lives in the sibling sites-enabled dir of whatever the record names. */
function enabledLinkFor(vhostPath: string): string | null {
  const marker = '/sites-available/';
  const idx = vhostPath.lastIndexOf(marker);
  return idx === -1 ? null : `${vhostPath.slice(0, idx)}/sites-enabled/${vhostPath.slice(idx + marker.length)}`;
}

interface Plan { steps: Step[]; kept: string[] }

/** Turn the record (or the fallback guess) into an ordered teardown plan. The order is the contract: stop
 *  and disable every unit BEFORE deleting its file, reload systemd while the units are gone, and only then
 *  touch the surrounding artifacts — the reverse order is exactly the crash-loop this command exists to undo. */
function buildPlan(deps: UninstallDeps, info: InstallInfo | null, purge: boolean): Plan {
  const mac = deps.platform === 'darwin';
  const steps: Step[] = [];
  const kept: string[] = [];

  if (mac) {
    // macOS: per-user launchd agents — bootout (stop+unload) then remove the plists. No sudoers, no proxy,
    // no service user: the agents run as the invoking user, who is never removed.
    const labels = [LAUNCHD_DAEMON_LABEL, LAUNCHD_WEB_LABEL, LAUNCHD_UPDATE_LABEL];
    for (const label of labels) {
      steps.push({
        label: `stop agent ${label}`,
        run: async () => {
          const uid = (await deps.runner.exec('id', ['-u'])).stdout.trim();
          await execTolerate(deps, 'launchctl', ['bootout', `gui/${uid}/${label}`]);
        },
        manual: `launchctl bootout gui/$(id -u)/${label}`,
      });
    }
    for (const label of labels) {
      const path = agentPlistPath(deps.home, label);
      steps.push({ label: `remove ${path}`, run: () => rm(deps, path), manual: `rm -f ${path}` });
    }
  } else {
    const artifacts = info?.artifacts;
    const units = artifacts ? artifacts.units : KNOWN_LINUX_UNITS;
    // Validate every recorded path ONCE — a corrupted record must never get a stop/rm of an arbitrary
    // file, so the same verdict (recognized / refused) drives both the stop and the removal loops.
    const validated = units.map((u) => ({ unit: u, name: unitName(u.path) }));
    for (const { unit: u, name } of validated) {
      if (name === null) {
        steps.push({
          label: `remove unit ${u.path}`,
          run: async () => { throw new Error('refusing: not a recognizable elowen unit path'); },
          manual: `inspect ${u.path} before removing it`,
        });
        continue;
      }
      steps.push({ label: `stop ${name}`, run: () => execTolerate(deps, 'systemctl', ['stop', name]), manual: `systemctl stop ${name}` });
      if (u.enabled) steps.push({ label: `disable ${name}`, run: () => execTolerate(deps, 'systemctl', ['disable', name]), manual: `systemctl disable ${name}` });
    }
    for (const { unit: u, name } of validated) {
      if (name === null) continue; // already refused above
      steps.push({ label: `remove ${u.path}`, run: () => rm(deps, u.path), manual: `rm -f ${u.path}` });
    }
    steps.push({ label: 'reload systemd', run: () => execOk(deps, 'systemctl', ['daemon-reload']), manual: 'systemctl daemon-reload' });
  }

  // The wildcard gateway must fail closed before its helper is removed. The deny vhost and certificate
  // intentionally remain as a tombstone: deleting them could make an old DNS hostname fall through to an
  // unrelated default vhost on a machine nginx still serves for something else.
  if (!mac && info?.artifacts?.siteGatewayHelper === true) {
    steps.push({
      label: 'deny published-sites wildcard gateway and remove its broker',
      run: async () => {
        const res = await deps.runner.exec(SITE_GATEWAY_HELPER_PATH, [], { input: '{"op":"deny"}\n' });
        if (res.code !== 0) {
          throw new Error(`site gateway deny failed: ${`${res.stdout}\n${res.stderr}`.trim() || res.code}`);
        }
        // Keep the helper until the very last mutation. If removing the deployment record fails, a rerun can
        // still re-assert the deny tombstone; the unsafe order would delete the only broker first.
        await rm(deps, SITE_GATEWAY_DEPLOYMENT_PATH);
        await rm(deps, SITE_GATEWAY_HELPER_PATH);
      },
      manual: `printf '%s\\n' '{"op":"deny"}' | ${SITE_GATEWAY_HELPER_PATH} && rm -f ${SITE_GATEWAY_DEPLOYMENT_PATH} ${SITE_GATEWAY_HELPER_PATH}`,
    });
    kept.push('/etc/nginx/conf.d/elowen-sites-gateway.conf and /etc/elowen/sites-tls (deny tombstone for stale wildcard DNS)');
  }

  // Globally-installed agent CLIs — only when the record proves this install ran their `npm install -g`.
  const agentClis = info?.artifacts?.agentClis ?? [];
  for (const id of agentClis) {
    const pkg = AGENT_CLIS.find((c) => c.id === id)?.pkg ?? id;
    steps.push({ label: `npm uninstall -g ${pkg}`, run: () => execOk(deps, 'npm', ['uninstall', '-g', pkg]), manual: `npm uninstall -g ${pkg}` });
  }

  if (!mac && info?.artifacts?.sudoers) {
    steps.push({ label: `remove ${SUDOERS_PATH}`, run: () => rm(deps, SUDOERS_PATH), manual: `rm -f ${SUDOERS_PATH}` });
  }

  const proxy = info?.artifacts?.proxy;
  if (!mac && proxy) {
    if (!proxy.vhostPath.startsWith('/') || !proxy.vhostPath.includes('/sites-available/')) {
      steps.push({
        label: `remove vhost ${proxy.vhostPath}`,
        run: async () => { throw new Error('refusing: not a recognizable elowen vhost path'); },
        manual: `inspect ${proxy.vhostPath} before removing it`,
      });
    } else {
      const svc = proxy.kind === 'nginx' ? 'nginx' : 'apache2';
      steps.push({ label: `remove ${proxy.vhostPath}`, run: () => rm(deps, proxy.vhostPath), manual: `rm -f ${proxy.vhostPath}` });
      const link = enabledLinkFor(proxy.vhostPath);
      if (link) steps.push({ label: `remove ${link}`, run: () => rm(deps, link), manual: `rm -f ${link}` });
      // Without a reload the proxy keeps serving the (now-deleted) vhost from memory — remove it from the
      // live config too. Best-effort: a broken config elsewhere fails this step, which is reported.
      steps.push({ label: `reload ${svc}`, run: () => execOk(deps, 'systemctl', ['reload', svc]), manual: `systemctl reload ${svc}` });
    }
    if (proxy.tls) kept.push("Let's Encrypt certificates in /etc/letsencrypt (bound to the domain, not to elowen — left in place)");
  }

  // Only an account THIS install created (useradd ran) may be removed. An account it merely adopted may
  // run other things on the box; without the record (fallback) nobody can tell, so nobody gets removed.
  if (!mac && info?.artifacts?.serviceUserCreated === true) {
    const user = info.serviceUser;
    steps.push({
      label: `remove service user '${user}'`,
      // userdel WITHOUT -r: the home dir and anything in it survives — data is removed only through the
      // explicit --purge step. -r would also take whatever else accumulated in that home.
      run: () => execTolerate(deps, 'userdel', [user]),
      manual: `userdel ${user}`,
    });
  }

  // User data (~/.config/elowen: DB, logs, config) is never removed by default — only on explicit --purge.
  if (purge) {
    if (mac) {
      // macOS has no service-user indirection: the data dir is the invoking user's, the path is certain.
      const data = join(deps.home, '.config', 'elowen');
      steps.push({ label: `remove ${data}`, run: () => rmRf(deps, data), manual: `rm -rf ${data}` });
    } else if (info?.artifacts) {
      const user = info.serviceUser;
      steps.push({
        label: `remove data (~/.config/elowen of '${user}')`,
        run: async () => {
          // userHome first; a created user whose account is already gone falls back to the home
          // `useradd --create-home` built (/var/lib/<user>) — the exact path ensureServiceUser used.
          let home = await userHome(deps.runner, user);
          if (home === null && info.artifacts?.serviceUserCreated === true) home = `/var/lib/${user}`;
          // Not resolving the home is a FAILED step, not a quiet success: --purge was asked for
          // explicitly, so reporting "done" while the database is still on disk would be the summary
          // lying about the one irreversible thing the user opted into.
          if (home === null) throw new Error(`cannot resolve the home directory of '${user}' — data not removed`);
          await rmRf(deps, join(home, '.config', 'elowen'));
        },
        manual: `rm -rf <home of ${user}>/.config/elowen`,
      });
    } else {
      kept.push('data (~/.config/elowen) — no artifact record, cannot prove this install created it; remove manually with: rm -rf <service-user-home>/.config/elowen');
    }
  } else {
    kept.push('data (~/.config/elowen — database, logs, config) — pass --purge to delete it');
  }

  // The record itself is always ours (written by install); it goes last so a crash mid-run leaves it in
  // place for the next attempt to re-read.
  if (info !== null) {
    steps.push({ label: `remove ${deps.installInfoPath}`, run: () => rm(deps, deps.installInfoPath), manual: `rm -f ${deps.installInfoPath}` });
  }

  return { steps, kept };
}

const KNOWN_FLAGS = new Set(['--yes', '--purge', '--dry-run', '--help', '-h']);

function uninstallHelp(): string {
  return `elowen uninstall - remove what 'elowen install' created from this machine
  Linux  run as root: systemd units, sudoers drop-in, reverse-proxy vhost, service user
  macOS  run as yourself: per-user launchd agents (no sudoers/proxy/service user)

USAGE
  elowen uninstall [--yes] [--purge] [--dry-run]

  Removes, in order: stops and disables the services, deletes the unit files and reloads systemd,
  uninstalls the agent CLIs the install put on the box, then the sudoers drop-in, the vhost and the
  service user — but ONLY what the install record proves this install created. The data directory
  (~/.config/elowen: database, logs, config) is always kept unless --purge is given.

OPTIONS
  --yes       skip the confirmation prompt (--purge still asks separately)
  --purge     also DELETE the data directory — irreversible
  --dry-run   print what would be done without touching anything
  -h, --help  show this help`;
}

function defaultDeps(): UninstallDeps {
  return {
    runner: realRunner(),
    confirm: async (message) => {
      const answer = await p.confirm({ message });
      return !p.isCancel(answer) && answer === true;
    },
    out: (m) => console.log(m),
    err: (m) => console.error(m),
    readInfo: (path) => readInstallInfo(path),
    installInfoPath: INSTALL_INFO_PATH,
    platform: process.platform,
    home: homedir(),
  };
}

/** `elowen uninstall` — returns a process exit code: 0 = done (or nothing to do), 1 = some steps failed
 *  (the rest ran; the summary names what to fix by hand), 2 = usage error. */
export async function runUninstall(args: string[], partial?: Partial<UninstallDeps>): Promise<number> {
  const deps: UninstallDeps = { ...defaultDeps(), ...partial };
  if (args.includes('--help') || args.includes('-h')) { deps.out(uninstallHelp()); return 0; }
  const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    deps.err(`elowen uninstall: unknown option '${unknown[0]}'`);
    deps.err(uninstallHelp());
    return 2;
  }

  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  const purge = args.includes('--purge');

  // Sanitized here rather than trusted from the reader: the reader is injectable, and a record whose
  // artifacts do not have the shape this walks would otherwise throw halfway through a teardown.
  const info = sanitizeInstallInfo(deps.readInfo(deps.installInfoPath));
  if (info?.artifacts === undefined) {
    deps.err('elowen uninstall: no install record with an artifact inventory (install.json is missing or predates artifact tracking) — proceeding by ESTIMATE from the known unit names. The service user, sudoers drop-in, reverse-proxy vhost and data are left untouched; see the summary at the end.');
  }

  const { steps, kept } = buildPlan(deps, info, purge);

  if (dryRun) {
    for (const s of steps) deps.out(`would  ${s.label}`);
    for (const k of kept) deps.out(`keep  ${k}`);
    return 0;
  }

  if (!yes) {
    const planText = steps.map((s) => `  - ${s.label}`).join('\n');
    const keptText = kept.length > 0 ? `\nKept (not removed):\n${kept.map((k) => `  - ${k}`).join('\n')}\n` : '';
    const go = await deps.confirm(`This will remove elowen from this machine:\n${planText}${keptText}\nProceed?`);
    if (!go) { deps.out('Aborted — nothing was changed.'); return 0; }
  }
  if (purge) {
    // --purge always confirms separately, even after --yes — deleting user data is the one irreversible
    // decision here and must survive a scripted `--yes` that silenced everything else.
    const go = await deps.confirm('--purge: this permanently DELETES the elowen data directory (database, logs, configuration). This cannot be undone. Continue?');
    if (!go) { deps.out('Aborted — nothing was changed.'); return 0; }
  }

  const failed: { label: string; manual: string }[] = [];
  for (const s of steps) {
    try {
      await s.run();
      deps.out(`  done  ${s.label}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      deps.err(`  FAIL  ${s.label} — ${reason}`);
      failed.push({ label: s.label, manual: s.manual });
    }
  }
  for (const k of kept) deps.out(`keep  ${k}`);

  if (failed.length > 0) {
    deps.err('');
    deps.err(`elowen uninstall finished with ${failed.length} failed step(s). Fix manually:`);
    for (const f of failed) deps.err(`  - ${f.label}  →  ${f.manual}`);
    deps.err('Then re-run `elowen uninstall` to retry the remaining steps.');
    return 1;
  }
  deps.out('elowen removed.');
  return 0;
}
