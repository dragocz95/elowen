#!/usr/bin/node
/** Host preparation for the systemd-nspawn proof suite, and its removal.
 *
 *  The proof suite asserts properties of a RUNNING machine, so it needs three root-owned artefacts that
 *  an unprovisioned host does not have: the machine unit template, the polkit rule that lets the service
 *  account start those units without sudo, and a sudoers line naming one privileged helper.
 *
 *  The helper it names is deliberately NOT the installed one. `/usr/local/libexec/elowen-site-gateway`
 *  serves published sites in production; replacing it to test a branch would deploy that branch's whole
 *  Sites domain untested. This installs a small root-owned wrapper that runs the helper FROM THE WORKING
 *  TREE instead, and pins the sudoers line to the wrapper, so the argv the client spawns keeps exactly
 *  the shape the production drop-in pins while the bytes that answer come from the branch.
 *
 *  Everything written here is recorded and removed again, and an artefact that already existed is left
 *  alone: an operator who has provisioned this host keeps their own unit template and rule. The uid
 *  ranges the run's environments were allocated are given back the same way, and on the same terms.
 *
 *  Run as root, from the working tree:
 *
 *    sudo node tests/plugins/nspawnProofHost.mjs run        install, run the suite, remove
 *    sudo node tests/plugins/nspawnProofHost.mjs install    leave the host prepared
 *    sudo node tests/plugins/nspawnProofHost.mjs uninstall  remove and verify
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER_SOURCE = join(WORKTREE, 'scripts', 'elowen-site-gateway.mjs');
/** The helper the sudoers line ultimately runs as root, and therefore a path the service account must not
 *  be able to write. The working tree is the service account's, so pointing the grant at it would hand
 *  that account root on request for as long as the harness is installed. What runs is a COPY taken at
 *  install time into a root-owned directory; the branch is still what answers, but the bytes stop moving
 *  the moment the grant exists. */
const HELPER_PATH = '/usr/local/libexec/elowen-nspawn-proof-gateway.mjs';
const WRAPPER_PATH = '/usr/local/libexec/elowen-nspawn-proof-gateway';
const SUDOERS_PATH = '/etc/sudoers.d/elowen-nspawn-proof';
/** What says a host is prepared AND that its preparation will be taken away again: it exists from the
 *  first artefact until teardown has finished. The suite reads it as the condition for running at all,
 *  because teardown is what gives the uid ranges back. */
export const RECEIPT_PATH = '/var/tmp/elowen-nspawn-proof-host.json';
/** The registry in which the privileged helper reserves one uid range per environment, named here the
 *  way the helper names it. Nothing about it is changed for a proof run: the reservation is forward-only
 *  on purpose — a restored disk carries its ownership on disk and the envelope refuses a mismatch — and a
 *  registry path the helper took from a request would be a path the service account can name, which is
 *  the one thing the trusted roots exist to prevent. So a run allocates from the real registry like
 *  everything else does, and gives its own reservations back at teardown. */
const UID_RANGE_REGISTRY = '/var/lib/elowen/nspawn-uid-ranges.json';
/** The ids the proof suite mints, as `tests/plugins/environmentNspawnProof.test.ts` derives them: a
 *  project id far outside the range a real project reaches, and a `nsproof-` site. Both key forms are
 *  matched, because the helper writes `kind:resource` and still adopts the earlier `kind:resource:disk`.
 *  Nothing else on a host can produce these, which is what makes this safe to run against production
 *  state at all. */
const PROOF_RANGE_KEY = /^(?:project:990[0-9]{6}|site:nsproof-[0-9a-f]{8})(?::[a-f0-9]{32})?$/;

const fail = (message) => { console.error(`nspawn proof host: ${message}`); process.exit(1); };
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: 120_000, ...options });

if (!existsSync(HELPER_SOURCE)) fail(`the working tree helper is missing at ${HELPER_SOURCE}`);

// Importing the helper for its artefacts rather than restating them: a test that installs its own copy
// of a unit template proves that copy works, not the one the branch ships. The module's self-invocation
// guard compares `import.meta.url` against `process.argv[1]`, which is this file, so nothing runs.
const helper = await import(`file://${HELPER_SOURCE}`);
for (const name of ['MACHINE_UNIT_PATH', 'MACHINE_UNIT_TEMPLATE', 'POLKIT_RULE_PATH', 'renderPolkitRule',
  'storageRootsFor', 'acquireMutationLock']) {
  if (helper[name] === undefined) fail(`the working tree helper does not export ${name}`);
}

/** The account the daemon runs as, which is the account the polkit rule and the sudoers line are scoped
 *  to. `sudo` states it; guessing it would scope a root-owned rule to the wrong user. */
function resolveServiceUser() {
  const user = process.env.ELOWEN_TEST_NSPAWN_USER ?? process.env.SUDO_USER ?? '';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || user === 'root') {
    fail('the service account could not be determined; run under sudo or set ELOWEN_TEST_NSPAWN_USER');
  }
  return user;
}

function artefactsFor(serviceUser) {
  const wrapper = `#!/bin/sh
# Written by tests/plugins/nspawnProofHost.mjs for one proof run. Not part of a deployment.
exec /usr/bin/node ${HELPER_PATH} "$@"
`;
  const sudoers = `# Written by tests/plugins/nspawnProofHost.mjs for one proof run. Not part of a deployment.
${serviceUser} ALL=(root) NOPASSWD: ${WRAPPER_PATH} ""
`;
  return [
    { id: 'helper', path: HELPER_PATH, content: readFileSync(HELPER_SOURCE, 'utf8'), mode: 0o755 },
    { id: 'wrapper', path: WRAPPER_PATH, content: wrapper, mode: 0o755 },
    { id: 'sudoers', path: SUDOERS_PATH, content: sudoers, mode: 0o440 },
    { id: 'unit', path: helper.MACHINE_UNIT_PATH, content: helper.MACHINE_UNIT_TEMPLATE, mode: 0o644, reload: true },
    { id: 'polkit', path: helper.POLKIT_RULE_PATH, content: helper.renderPolkitRule(serviceUser), mode: 0o644 },
  ];
}

const readReceipt = () => {
  try { return JSON.parse(readFileSync(RECEIPT_PATH, 'utf8')); }
  catch { return null; }
};

/** The deployment record is NOT touched. The helper derives its trusted storage roots from the passwd
 *  home of the account sudo says invoked it, and reads them from nowhere, so there is nothing here to
 *  install and nothing to restore. */

const readUidRanges = (registryPath) => {
  try { return JSON.parse(readFileSync(registryPath, 'utf8')); }
  catch { return {}; }
};

/** Give back the uid ranges this run's environments were allocated, and nothing else.
 *
 *  Three conditions, all of them necessary. The key was NOT in the registry when the run was installed,
 *  so an entry the daemon allocated in the meantime is left where it is — a snapshot restored wholesale
 *  would destroy exactly that one. The key is one only the proof suite can produce. And the disk tree the
 *  range owns is gone from the storage roots, which is the rule the whole registry rests on: an entry
 *  matters as long as some bootable or restorable tree carries ownership in its range, so a run that
 *  failed halfway keeps its slot and says so rather than orphaning a chowned tree.
 *
 *  Written the way the helper writes it — same layout, same 0600, replaced by rename — and under the
 *  helper's own mutation lock, so a `write-envelope` allocating a range at the same moment cannot be
 *  lost between the read and the write. */
export function retireProofRanges(installedKeys, storage, registryPath = UID_RANGE_REGISTRY) {
  const ranges = readUidRanges(registryPath);
  const installed = new Set(installedKeys);
  const retired = [];
  const kept = [];
  for (const key of Object.keys(ranges)) {
    if (installed.has(key) || !PROOF_RANGE_KEY.test(key)) continue;
    const [kind, resource] = key.split(':');
    const tree = kind === 'project'
      ? join(storage.sandboxDataDir, 'projects', resource)
      : join(storage.sitesDataDir, resource);
    if (existsSync(tree)) { kept.push(key); continue; }
    delete ranges[key];
    retired.push(key);
  }
  if (retired.length) {
    const temporary = `${registryPath}.proof-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(ranges, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, registryPath);
  }
  return { retired, kept };
}

/** Where the run's disks live, which is the passwd home of the account it was scoped to plus the layout
 *  the helper derives from it. Resolved through getent, like every other account fact here. */
function storageRootsOf(serviceUser) {
  const passwd = run('/usr/bin/getent', ['passwd', serviceUser]);
  const home = String(passwd.stdout ?? '').trim().split(':')[5] ?? '';
  if (!home.startsWith('/')) fail(`the account ${serviceUser} has no home directory`);
  return helper.storageRootsFor(home);
}

function install(serviceUser) {
  if (readReceipt()) fail(`a previous run left ${RECEIPT_PATH}; run uninstall first`);
  const artefacts = artefactsFor(serviceUser);
  // Which artefacts this run is responsible for. One that already exists belongs to whoever put it
  // there, so it is neither rewritten nor removed, and the receipt records that decision.
  const owned = [];
  // Every uid range the registry already holds, so teardown can tell this run's reservations from the
  // ones that were here before it and the ones the daemon makes while it runs.
  const uidRangeKeys = Object.keys(readUidRanges(UID_RANGE_REGISTRY));
  // The receipt is written after EVERY artefact, and an empty one before the first. Anything that can
  // fail between here and the end — a rejected sudoers file, a failed daemon-reload — would otherwise
  // leave root-owned files on disk that teardown has no record of, and `uninstall` would answer that
  // there was nothing to remove while a sudo grant sat there.
  const record = () => writeFileSync(RECEIPT_PATH, JSON.stringify({ owned, serviceUser, uidRangeKeys, worktree: WORKTREE, at: new Date().toISOString() }), { mode: 0o600 });
  record();
  let reload = false;
  for (const artefact of artefacts) {
    if (existsSync(artefact.path)) { console.log(`nspawn proof host: ${artefact.path} already exists, leaving it alone`); continue; }
    mkdirSync(dirname(artefact.path), { recursive: true });
    writeFileSync(artefact.path, artefact.content, { mode: artefact.mode });
    chmodSync(artefact.path, artefact.mode);
    chownSync(artefact.path, 0, 0);
    owned.push(artefact.id);
    record();
    reload = reload || artefact.reload === true;
    console.log(`nspawn proof host: wrote ${artefact.path}`);
  }
  if (owned.includes('sudoers')) {
    const check = run('/usr/sbin/visudo', ['-c', '-f', SUDOERS_PATH]);
    if (check.status !== 0) {
      rmSync(SUDOERS_PATH, { force: true });
      fail(`the sudoers drop-in did not validate: ${String(check.stderr || check.stdout || '').trim()}`);
    }
  }
  if (reload) {
    const reloaded = run('/usr/bin/systemctl', ['daemon-reload']);
    if (reloaded.status !== 0) fail(`systemd daemon-reload failed: ${String(reloaded.stderr || '').trim()}`);
  }
  console.log(`nspawn proof host: prepared (${owned.length ? owned.join(', ') : 'nothing to write'})`);
  return owned;
}

async function uninstall() {
  const receipt = readReceipt();
  if (!receipt) { console.log('nspawn proof host: nothing recorded to remove'); return true; }
  const artefacts = artefactsFor(receipt.serviceUser);
  let reload = false;
  for (const artefact of artefacts) {
    if (!receipt.owned.includes(artefact.id)) continue;
    rmSync(artefact.path, { force: true });
    reload = reload || artefact.reload === true;
  }
  if (reload) run('/usr/bin/systemctl', ['daemon-reload']);
  // The reservations before the receipt: the grant is already gone, so nothing of this run can allocate
  // another range while the registry is being rewritten.
  const release = await helper.acquireMutationLock();
  let ranges;
  try { ranges = retireProofRanges(receipt.uidRangeKeys ?? [], storageRootsOf(receipt.serviceUser)); }
  finally { release(); }
  for (const key of ranges.retired) console.log(`nspawn proof host: gave back the uid range of ${key}`);
  rmSync(RECEIPT_PATH, { force: true });
  // Verified, not assumed: an artefact this run created must be gone, and one it did not create must
  // still be there.
  const failures = ranges.kept.map((key) => `${key} keeps its uid range: its disk tree is still on this host`);
  for (const artefact of artefacts) {
    const owned = receipt.owned.includes(artefact.id);
    const present = existsSync(artefact.path);
    if (owned && present) failures.push(`${artefact.path} is still present`);
    if (!owned && !present) failures.push(`${artefact.path} was not this run's and is now missing`);
  }
  if (existsSync(RECEIPT_PATH)) failures.push(`${RECEIPT_PATH} is still present`);
  for (const line of failures) console.error(`nspawn proof host: ${line}`);
  console.log(failures.length ? 'nspawn proof host: CLEANUP INCOMPLETE' : 'nspawn proof host: cleanup verified');
  return failures.length === 0;
}

// Only when this file is what was run. The proof suite imports it for the receipt path and
// `nspawnProofRegistry.test.ts` for the teardown rule above, and neither of those runs as root, so
// nothing here executes on an import and the root check does not reject the importer.
const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  if (process.getuid() !== 0) fail('run this as root');
  const mode = process.argv[2] ?? 'run';
  if (mode === 'install') { install(resolveServiceUser()); }
  else if (mode === 'uninstall') { process.exit(await uninstall() ? 0 : 1); }
  else if (mode === 'run') {
    const serviceUser = resolveServiceUser();
    install(serviceUser);
    const suite = run('/usr/bin/sudo', ['-u', serviceUser, '--preserve-env=ELOWEN_TEST_NSPAWN_HELPER',
      'npx', 'vitest', 'run', 'tests/plugins/environmentNspawnProof.test.ts'], {
      cwd: WORKTREE, stdio: 'inherit', timeout: 45 * 60_000,
      env: { ...process.env, ELOWEN_TEST_NSPAWN_HELPER: WRAPPER_PATH },
    });
    const clean = await uninstall();
    process.exit(suite.status === 0 && clean ? 0 : 1);
  } else fail(`unknown mode ${mode}; use install, uninstall or run`);
}
