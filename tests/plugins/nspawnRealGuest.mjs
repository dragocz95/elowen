import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootfsArtifactStore } from '../../plugins/sandbox/lib/rootfsArtifacts.mjs';
import { PROJECT_ARTIFACT, artifactReference } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';
import { HELPER_PATH, NspawnClient } from '../../plugins/sandbox/lib/nspawn.mjs';
import { RECEIPT_PATH } from './nspawnProofHost.mjs';

/** The gate every real-guest suite in this repository shares.
 *
 *  A machine is not a private container store: there is no per-run engine to create and throw away, so a
 *  suite that touches one touches the host. That is why these suites refuse to run rather than pretend —
 *  the same refusal `tests/plugins/environmentNspawnProof.test.ts` makes, for the same reasons, stated
 *  once here because three suites now need it.
 *
 *  `tests/plugins/nspawnProofHost.mjs` prepares a host and takes the preparation away again, and a run it
 *  did not prepare is refused: every environment is reserved a uid range out of a forward-only registry
 *  the service account cannot give back, and that teardown is the only thing on the host that can.
 *  `docs/TESTING.md` has the invocation. */

/** Which privileged helper this run talks to. Unset, it is the installed one. Set, it is an isolated one
 *  a harness put there, so a branch can be proved on a host whose installed helper serves production. */
export const PROOF_HELPER = process.env.ELOWEN_TEST_NSPAWN_HELPER || HELPER_PATH;
export const PROJECT_ROOTFS = artifactReference(PROJECT_ARTIFACT);
const MACHINE_UNIT_TEMPLATE = '/etc/systemd/system/elowen-machine@.service';
/** An ordinary environment comes up with a virtual ethernet, and the privileged side refuses to write an
 *  envelope carrying one until the host can isolate it. Without these nothing can be created at all. */
const FIREWALL_RULE_IDS = ['firewall:forward-out', 'firewall:forward-back', 'firewall:machine-dhcp',
  'firewall:host-guard', 'firewall:host-guard6'];

export const blockers = [];
if (process.platform !== 'linux') blockers.push('the host is not Linux');
if (!existsSync('/usr/bin/systemd-nspawn')) blockers.push('systemd-container is not installed');
if (!existsSync(PROOF_HELPER)) blockers.push(`the privileged helper is not present at ${PROOF_HELPER}`);
if (!existsSync(MACHINE_UNIT_TEMPLATE)) blockers.push('the machine unit template is not installed');
else if (!readFileSync(MACHINE_UNIT_TEMPLATE, 'utf8').includes('--settings=trusted')) {
  blockers.push('the installed machine unit predates trusted root-owned settings, so systemd-nspawn ignores inbound Port= rules; provision the Sandbox host runtime before this proof');
}
if (!existsSync(RECEIPT_PATH)) {
  blockers.push('the proof host harness is not prepared, and its teardown is what returns the uid ranges'
    + ' these suites allocate: run `sudo node tests/plugins/nspawnProofHost.mjs run`');
}
if (!blockers.length) {
  // Asked of the privileged side, not of `iptables`: the service account cannot read the tables at all,
  // and the readiness report is what actually gates `write-envelope`.
  try {
    const probe = new NspawnClient({ artifacts: new RootfsArtifactStore({ dataDir: tmpdir() }), helperPath: PROOF_HELPER, namespace: 'elowen' });
    const readiness = await probe.hostReadiness();
    const unmet = FIREWALL_RULE_IDS.filter((id) => !readiness.items.some((item) => item.id === id && item.ok));
    if (unmet.length) blockers.push(`the host guard for machine networking is not installed: ${unmet.join(', ')}`);
  } catch (error) {
    blockers.push(`the machine runtime readiness could not be read: ${error.message}`);
  }
}

/** Where the helper is willing to touch at all. DERIVED, never read from a caller: the helper computes
 *  these from the passwd home of the account sudo says invoked it, and the same derivation is made here
 *  so a suite builds its disks where the privileged side will agree they belong. */
export let storageRoots = null;
if (!blockers.length) {
  const passwd = execFileSync('/usr/bin/getent', ['passwd', String(process.getuid())], { encoding: 'utf8', timeout: 30_000 }).trim().split(':');
  const home = passwd[5] ?? '';
  if (!home.startsWith('/')) blockers.push('the service account running this suite has no home directory');
  else {
    const pluginData = join(home, '.config', 'elowen', 'plugins-data');
    storageRoots = { sandboxDataDir: join(pluginData, 'sandbox'), sitesDataDir: join(pluginData, 'sites') };
    for (const root of [storageRoots.sandboxDataDir, storageRoots.sitesDataDir]) {
      if (!existsSync(root)) blockers.push(`the trusted storage root ${root} does not exist`);
    }
  }
}
if (!blockers.length && storageRoots) {
  // These suites will not pull hundreds of megabytes over the network, so an artifact that is not on the
  // host already is a reason to skip rather than a download inside a test.
  const present = new RootfsArtifactStore({ dataDir: storageRoots.sandboxDataDir }).status(PROJECT_ROOTFS);
  if (!present.published) blockers.push(`this release publishes no ${PROJECT_ROOTFS} artifact`);
  else if (!present.present) blockers.push(`the ${PROJECT_ROOTFS} root filesystem is not on this host`);
}

export function announce(suite) {
  if (blockers.length) console.log(`${suite} skipped: ${blockers.join('; ')}`);
}

/** An executor that refuses anything this runtime does not own. The machine client spawns exactly three
 *  programs — the two control tools and the pinned privileged helper — and a suite that runs against the
 *  real host has to be able to say that no fourth one was reached and that the helper argv is the one the
 *  sudoers drop-in pins, because that argv is the whole privilege boundary. */
export function pinnedExecutor(native, observed = []) {
  return { run: async (file, args, options) => {
    if (!['/usr/bin/systemctl', '/usr/bin/machinectl', '/usr/bin/sudo'].includes(file)) {
      throw new Error(`the machine runtime spawned an unexpected program: ${file}`);
    }
    if (file === '/usr/bin/sudo' && JSON.stringify(args) !== JSON.stringify(['-n', PROOF_HELPER, ''])) {
      throw new Error(`the privileged helper was invoked off its pinned argv: ${JSON.stringify(args)}`);
    }
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      if (options?.env?.[key] !== undefined) throw new Error(`a daemon credential reached the runtime environment: ${key}`);
    }
    observed.push(`${file.split('/').at(-1)} ${file === '/usr/bin/sudo' ? 'privileged' : args[0]}`);
    return await native.run(file, args, options);
  } };
}
