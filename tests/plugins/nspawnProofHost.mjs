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
 *  alone: an operator who has provisioned this host keeps their own unit template and rule.
 *
 *  Run as root, from the working tree:
 *
 *    sudo node tests/plugins/nspawnProofHost.mjs run        install, run the suite, remove
 *    sudo node tests/plugins/nspawnProofHost.mjs install    leave the host prepared
 *    sudo node tests/plugins/nspawnProofHost.mjs uninstall  remove and verify
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const RECEIPT_PATH = '/var/tmp/elowen-nspawn-proof-host.json';

const fail = (message) => { console.error(`nspawn proof host: ${message}`); process.exit(1); };
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: 120_000, ...options });

if (process.getuid() !== 0) fail('run this as root');
if (!existsSync(HELPER_SOURCE)) fail(`the working tree helper is missing at ${HELPER_SOURCE}`);

/** The account the daemon runs as, which is the account the polkit rule and the sudoers line are scoped
 *  to. `sudo` states it; guessing it would scope a root-owned rule to the wrong user. */
const serviceUser = process.env.ELOWEN_TEST_NSPAWN_USER ?? process.env.SUDO_USER ?? '';
if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(serviceUser) || serviceUser === 'root') {
  fail('the service account could not be determined; run under sudo or set ELOWEN_TEST_NSPAWN_USER');
}

// Importing the helper for its artefacts rather than restating them: a test that installs its own copy
// of a unit template proves that copy works, not the one the branch ships. The module's self-invocation
// guard compares `import.meta.url` against `process.argv[1]`, which is this file, so nothing runs.
const helper = await import(`file://${HELPER_SOURCE}`);
for (const name of ['MACHINE_UNIT_PATH', 'MACHINE_UNIT_TEMPLATE', 'POLKIT_RULE_PATH', 'renderPolkitRule']) {
  if (helper[name] === undefined) fail(`the working tree helper does not export ${name}`);
}

const WRAPPER = `#!/bin/sh
# Written by tests/plugins/nspawnProofHost.mjs for one proof run. Not part of a deployment.
exec /usr/bin/node ${HELPER_PATH} "$@"
`;
const SUDOERS = `# Written by tests/plugins/nspawnProofHost.mjs for one proof run. Not part of a deployment.
${serviceUser} ALL=(root) NOPASSWD: ${WRAPPER_PATH} ""
`;

const artefacts = [
  { id: 'helper', path: HELPER_PATH, content: readFileSync(HELPER_SOURCE, 'utf8'), mode: 0o755 },
  { id: 'wrapper', path: WRAPPER_PATH, content: WRAPPER, mode: 0o755 },
  { id: 'sudoers', path: SUDOERS_PATH, content: SUDOERS, mode: 0o440 },
  { id: 'unit', path: helper.MACHINE_UNIT_PATH, content: helper.MACHINE_UNIT_TEMPLATE, mode: 0o644, reload: true },
  { id: 'polkit', path: helper.POLKIT_RULE_PATH, content: helper.renderPolkitRule(serviceUser), mode: 0o644 },
];

const readReceipt = () => {
  try { return JSON.parse(readFileSync(RECEIPT_PATH, 'utf8')); }
  catch { return null; }
};

/** The deployment record is NOT touched. The helper derives its trusted storage roots from the passwd
 *  home of the account sudo says invoked it, and reads them from nowhere, so there is nothing here to
 *  install and nothing to restore. */

function install() {
  if (readReceipt()) fail(`a previous run left ${RECEIPT_PATH}; run uninstall first`);
  // Which artefacts this run is responsible for. One that already exists belongs to whoever put it
  // there, so it is neither rewritten nor removed, and the receipt records that decision.
  const owned = [];
  // The receipt is written after EVERY artefact, and an empty one before the first. Anything that can
  // fail between here and the end — a rejected sudoers file, a failed daemon-reload — would otherwise
  // leave root-owned files on disk that teardown has no record of, and `uninstall` would answer that
  // there was nothing to remove while a sudo grant sat there.
  const record = () => writeFileSync(RECEIPT_PATH, JSON.stringify({ owned, serviceUser, worktree: WORKTREE, at: new Date().toISOString() }), { mode: 0o600 });
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

function uninstall() {
  const receipt = readReceipt();
  if (!receipt) { console.log('nspawn proof host: nothing recorded to remove'); return true; }
  let reload = false;
  for (const artefact of artefacts) {
    if (!receipt.owned.includes(artefact.id)) continue;
    rmSync(artefact.path, { force: true });
    reload = reload || artefact.reload === true;
  }
  if (reload) run('/usr/bin/systemctl', ['daemon-reload']);
  rmSync(RECEIPT_PATH, { force: true });
  // Verified, not assumed: an artefact this run created must be gone, and one it did not create must
  // still be there.
  const failures = [];
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

const mode = process.argv[2] ?? 'run';
if (mode === 'install') { install(); }
else if (mode === 'uninstall') { process.exit(uninstall() ? 0 : 1); }
else if (mode === 'run') {
  install();
  const suite = run('/usr/bin/sudo', ['-u', serviceUser, '--preserve-env=ELOWEN_TEST_NSPAWN_HELPER',
    'npx', 'vitest', 'run', 'tests/plugins/environmentNspawnProof.test.ts'], {
    cwd: WORKTREE, stdio: 'inherit', timeout: 45 * 60_000,
    env: { ...process.env, ELOWEN_TEST_NSPAWN_HELPER: WRAPPER_PATH },
  });
  const clean = uninstall();
  process.exit(suite.status === 0 && clean ? 0 : 1);
} else fail(`unknown mode ${mode}; use install, uninstall or run`);
