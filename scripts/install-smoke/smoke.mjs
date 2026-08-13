// In-container assertions for the "first unboxing" install smoke test. Runs inside a clean node:22
// container where ONLY the packed `elowen` tarball is installed globally — no repo source, no dev deps.
// It mirrors what a brand-new user does per docs/site/02-install.md: install, `elowen up`, use it,
// `elowen down`. Every check runs against the REAL installed package + a REAL daemon on an empty DB,
// so it catches packaging/first-run bugs (missing `files`, unbuilt dist/web-dist, broken onboarding
// backend) that unit tests never see. Plain Node ≥22, zero dependencies (global fetch only).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = process.env.ELOWEN_EXPECTED_VERSION ?? '';
const DAEMON = 'http://127.0.0.1:4400';
const WEB = 'http://127.0.0.1:4500';
const LOG_DIR = join(homedir(), '.config', 'elowen', 'logs');

// A wedged step must never hang the CI job past its own watchdog.
const watchdog = setTimeout(() => { fail('watchdog', new Error('smoke exceeded 150s')); }, 150_000);
watchdog.unref();

function dumpLogs() {
  try {
    for (const f of readdirSync(LOG_DIR)) {
      process.stderr.write(`\n----- ${f} (tail) -----\n`);
      const lines = readFileSync(join(LOG_DIR, f), 'utf8').split('\n');
      process.stderr.write(lines.slice(-40).join('\n') + '\n');
    }
  } catch { process.stderr.write(`(no logs under ${LOG_DIR})\n`); }
}

function fail(name, err) {
  process.stderr.write(`\nFAIL: ${name} — ${err?.message ?? err}\n`);
  dumpLogs();
  process.exit(1);
}

async function step(name, fn) {
  try { await fn(); process.stdout.write(`ok: ${name}\n`); }
  catch (err) { fail(name, err); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** One HTTP call, tokenless by default. Returns { status, text, json } and never throws on non-2xx. */
async function req(method, base, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'follow' });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, json };
}

async function main() {
  // 1. The CLI (both bin aliases) is on PATH and reports the installed version.
  await step('cli --version (elowen + elo)', () => {
    for (const bin of ['elowen', 'elo']) {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
      assert(out.includes(VERSION), `${bin} --version = "${out}", expected to include "${VERSION}"`);
    }
  });

  // 2. The installed package actually contains the built dist + shipped assets (catches `files`/build
  //    omissions with a precise message before anything boots).
  await step('installed package ships dist + web-dist + prompts + plugins', () => {
    const root = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'elowen');
    for (const rel of ['dist/cli/bin.js', 'dist/daemon/index.js', 'dist/store/schema.sql', 'dist/prompts', 'dist/plugins', 'prompts', 'plugins', 'web-dist/server.js', 'web-dist/.next/static']) {
      assert(existsSync(join(root, rel)), `installed package is missing ${rel}`);
    }
  });

  // 3. Unbox: the documented manual-start verb. It boots the daemon + web and polls the daemon's
  //    /health itself, exiting non-zero if the daemon never comes up.
  await step('elowen up (daemon + web launch)', () => {
    execFileSync('elowen', ['up'], { stdio: 'inherit' });
  });

  // 4. Daemon is healthy AND is the installed build (version cross-check).
  await step('daemon /health 200 + version matches', async () => {
    const r = await req('GET', DAEMON, '/health');
    assert(r.status === 200, `/health status ${r.status}`);
    assert(r.json?.ok === true, `/health ok !== true: ${r.text}`);
    assert(r.json?.version === VERSION, `/health version ${r.json?.version} !== ${VERSION}`);
  });

  // 5. Fresh install is detected: setup mode, no users yet.
  await step('/setup reports needsSetup=true (fresh install)', async () => {
    const r = await req('GET', DAEMON, '/setup');
    assert(r.status === 200 && r.json?.needsSetup === true, `/setup = ${r.status} ${r.text}`);
  });

  // 6. In setup mode the API is open tokenless: /auth/me is 200 with no user (NOT 401).
  await step('/auth/me tokenless is 200 with no user in setup mode', async () => {
    const r = await req('GET', DAEMON, '/auth/me');
    assert(r.status === 200, `/auth/me status ${r.status} (expected 200 in setup mode)`);
    assert(r.json != null && r.json.user == null, `/auth/me should have no user: ${r.text}`);
  });

  // 7. The first-run readiness report the setup wizard prints works on a BARE install — the honest
  //    "what works right now" answer, served by core alone (a fresh install enables no plugin that owns
  //    a domain vertical, so nothing here may depend on one being present).
  await step('/system/readiness reachable tokenless and reports core subsystems', async () => {
    const r = await req('GET', DAEMON, '/system/readiness');
    assert(r.status === 200 && Array.isArray(r.json?.checks), `/system/readiness = ${r.status} ${r.text}`);
    const ids = r.json.checks.map((c) => c.id);
    for (const id of ['chat', 'memory', 'platforms']) assert(ids.includes(id), `readiness is missing the ${id} row: ${r.text}`);
  });

  // 8. Create the first admin (the count==0 bootstrap path).
  await step('POST /users creates the first admin (201, is_admin)', async () => {
    const r = await req('POST', DAEMON, '/users', { body: { username: 'admin', password: 'smoke-Passw0rd!' } });
    assert(r.status === 201, `POST /users status ${r.status}: ${r.text}`);
    assert(r.json?.is_admin === true, `first user should be admin: ${r.text}`);
    assert(r.json?.username === 'admin', `username mismatch: ${r.text}`);
  });

  // 9. With a user in place the daemon re-engages auth: tokenless is rejected and setup is done.
  await step('auth re-engages once an admin exists', async () => {
    const me = await req('GET', DAEMON, '/auth/me');
    assert(me.status === 401, `/auth/me should be 401 after setup, got ${me.status}`);
    const setup = await req('GET', DAEMON, '/setup');
    assert(setup.status === 200 && setup.json?.needsSetup === false, `/setup should be needsSetup=false: ${setup.text}`);
  });

  // 10. The writes the first-run wizard's Preferences step performs land on a fresh box. These three
  //     endpoints are the first thing a new user's onboarding touches after the admin exists, so a
  //     regression in any of them breaks the unboxing path itself — and the wizard's own tests mock
  //     fetch, so nothing else exercises them against a real daemon.
  await step('onboarding preference writes persist (timezone, terminal, cli settings)', async () => {
    const login = await req('POST', DAEMON, '/auth/login', { body: { username: 'admin', password: 'smoke-Passw0rd!' } });
    assert(login.status === 200 && typeof login.json?.token === 'string', `login = ${login.status} ${login.text}`);
    const token = login.json.token;

    // Plugin config never comes back from GET /config (it may hold secrets), so read it back through the
    // per-plugin detail route the settings UI uses.
    const tz = await req('PATCH', DAEMON, '/plugins/runtime-context/config', { token, body: { values: { timezone: 'Europe/Prague' } } });
    assert(tz.status === 200, `PATCH runtime-context config = ${tz.status} ${tz.text}`);
    const tzRead = await req('GET', DAEMON, '/plugins/runtime-context', { token });
    assert(tzRead.json?.config?.timezone === 'Europe/Prague', `timezone did not persist: ${tzRead.text}`);

    const term = await req('PATCH', DAEMON, '/auth/me/terminal-settings', { token, body: { showThoughtsCli: false } });
    assert(term.status === 200, `PATCH terminal-settings = ${term.status} ${term.text}`);
    const termRead = await req('GET', DAEMON, '/auth/me/terminal-settings', { token });
    assert(termRead.json?.showThoughtsCli === false, `showThoughtsCli did not persist: ${termRead.text}`);

    const cli = await req('PATCH', DAEMON, '/auth/me/cli-settings', { token, body: { autoCompact: true, autoCompactAt: 80 } });
    assert(cli.status === 200, `PATCH cli-settings = ${cli.status} ${cli.text}`);
    const cliRead = await req('GET', DAEMON, '/auth/me/cli-settings', { token });
    assert(cliRead.json?.autoCompact === true && cliRead.json?.autoCompactAt === 80, `auto-compaction did not persist: ${cliRead.text}`);
  });

  // 11. The web standalone actually serves (elowen up does not wait for it, so poll).
  await step('web UI serves 200', async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { const r = await req('GET', WEB, '/'); if (r.status === 200) return; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('web did not serve 200 within 30s');
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  // 12. Teardown verb stops everything.
  await step('elowen down stops the daemon', async () => {
    execFileSync('elowen', ['down'], { stdio: 'inherit' });
    let stillUp = false;
    try { const r = await req('GET', DAEMON, '/health'); stillUp = r.status === 200; } catch { /* refused = stopped */ }
    assert(!stillUp, 'daemon still answering /health after `elowen down`');
  });

  clearTimeout(watchdog);
  process.stdout.write(`\nPASS install-smoke (elowen ${VERSION})\n`);
}

main();
