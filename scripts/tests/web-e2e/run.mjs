// Web page smokes: the REAL Next.js standalone bundle (web-dist/server.js) serving against a REAL
// daemon (dist/daemon/index.js), exercised over HTTP exactly as a browser would.
//
// It complements the install-smoke (which only checks web serves `/`) by covering two things unit
// tests can't: (1) the actual app routes render (200, not a 500 from a broken build), and (2) the BFF
// proxy contract in web/app/api/[...path]/route.ts — the same-origin cookie→Bearer translation, the
// Authorization allow-list, setup-mode tokenless passthrough, and the "clear the session cookie on an
// upstream 401 only when a token was present" rule.
//
// WHY IT BOOTS ITS OWN DAEMON (and does not import spawnRealDaemon): spawnRealDaemon always sets
// ELOWEN_BOOTSTRAP_USER/PASS, so its daemon boots with an admin already created — i.e. NEVER in setup
// mode (users.count() === 0). The web proxy targets exactly ONE daemon, and the setup-mode assertions
// require that daemon to have zero users, so this suite boots a fresh daemon WITHOUT bootstrap and then
// drives the real onboarding flow (create first admin → log in → authed call) through the web proxy.
// It reuses spawnRealDaemon's prod-safe boot TECHNIQUE (ELOWEN_* env stripping, HOME redirect into a
// throwaway temp dir, a freePort() well clear of 4400/4500, robust teardown) without modifying it.
//
// SAFETY: throwaway ephemeral ports for BOTH daemon and web (never 4400/4500), all state under
// os.tmpdir(), HOME redirected so the daemon's boot-time skill install can't touch the real ~/.config,
// full teardown in finally, and a prod-daemon-PID cross-check before/after. Never touches the prod DB,
// config, ports or systemd services. Plain Node ≥22, zero dependencies (global fetch only).

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const daemonEntry = join(repoRoot, 'dist', 'daemon', 'index.js');
const webServer = join(repoRoot, 'web-dist', 'server.js');

const ADMIN_USER = 'webadmin';
const ADMIN_PASS = 'web-e2e-Passw0rd!';

// A wedged boot must never hang forever; cap the whole run well under any CI job budget.
const watchdog = setTimeout(() => { console.error('\nFAIL: watchdog — web-e2e exceeded 180s'); process.exit(1); }, 180_000);
watchdog.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function ok(name) { passed += 1; process.stdout.write(`ok: ${name}\n`); }

/** Grab a free loopback TCP port (bind :0, read it back). Guarantees we never collide with 4400/4500. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolvePort(port) : reject(new Error('failed to allocate a free port'))));
    });
  });
}

/** A filtered copy of the parent env: drop every ELOWEN_* prod var and agent-CLI config override so no
 *  child can point back at the prod DB/config, then layer on our throwaway values. Mirrors the isolation
 *  spawnRealDaemon applies. */
function baseChildEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ELOWEN_')) continue;
    if (k === 'CLAUDE_CONFIG_DIR' || k === 'CODEX_HOME' || k === 'XDG_CONFIG_HOME' || k === 'XDG_DATA_HOME') continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}

/** The prod daemon's systemd MainPID, or null when systemctl/unit is unavailable. Read before and after
 *  the run to prove this suite never disturbed the live service. */
function prodDaemonPid() {
  try {
    const out = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'elowen-daemon'], { encoding: 'utf8' }).trim();
    return /^\d+$/.test(out) ? out : null;
  } catch { return null; }
}

/** One HTTP call. Never throws on non-2xx. Returns status, parsed json (if any), raw text, and the
 *  Set-Cookie array (getSetCookie keeps multiple cookies distinct, unlike a folded get('set-cookie')). */
async function http(method, base, path, { headers = {}, body, cookie, origin } = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (origin) h.origin = origin;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* non-JSON (e.g. an HTML page) */ }
  return { status: res.status, json, text, setCookies: res.headers.getSetCookie(), headers: res.headers };
}

/** Poll `fn` (returns truthy when ready) until the deadline; throws with `desc` on timeout. */
async function pollUntil(fn, deadlineMs, desc) {
  const until = Date.now() + deadlineMs;
  let last = 'no attempt';
  while (Date.now() < until) {
    try { const r = await fn(); if (r) return r; last = 'not ready'; }
    catch (e) { last = e instanceof Error ? e.message : String(e); }
    await sleep(150);
  }
  throw new Error(`${desc} (last: ${last})`);
}

/** Value of the elowen_session cookie in a Set-Cookie array, or null. `''` means an explicit clear. */
function sessionCookieValue(setCookies) {
  for (const c of setCookies) {
    const m = /^elowen_session=([^;]*)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  // Fail fast with a precise message if a concurrent build left an artifact missing.
  for (const p of [daemonEntry, webServer, join(repoRoot, 'web-dist', '.next')]) {
    assert(existsSync(p), `missing build artifact ${p} — run \`npm run build\` and \`npm run build:web\` first`);
  }

  const prodPidBefore = prodDaemonPid();

  const dataDir = mkdtempSync(join(tmpdir(), 'elowen-web-e2e-'));
  const daemonPort = await freePort();
  const webPort = await freePort();
  const DAEMON = `http://127.0.0.1:${daemonPort}`;
  const WEB = `http://127.0.0.1:${webPort}`;
  const webOrigin = WEB;

  let daemonProc = null;
  let webProc = null;
  const daemonLogs = [];
  const webLogs = [];

  const stopProc = async (proc) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    for (let i = 0; i < 30 && proc.exitCode === null && proc.signalCode === null; i += 1) await sleep(100);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  };

  try {
    // --- Boot the fresh daemon (no bootstrap → setup mode: users.count() === 0). ------------------
    daemonProc = spawn(process.execPath, [daemonEntry], {
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: baseChildEnv({
        HOME: dataDir,
        ELOWEN_DB: join(dataDir, 'elowen.db'),
        ELOWEN_PORT: String(daemonPort),
        ELOWEN_HOST: '127.0.0.1',
        ELOWEN_PROJECT: 'e2e-web',
        ELOWEN_PROJECT_PATH: dataDir,
        ELOWEN_LOG_DIR: join(dataDir, 'logs'),
      }),
    });
    daemonProc.stdout.on('data', (d) => daemonLogs.push(d.toString()));
    daemonProc.stderr.on('data', (d) => daemonLogs.push(d.toString()));

    await pollUntil(async () => {
      const r = await http('GET', DAEMON, '/health');
      return r.status === 200 && r.json?.ok === true;
    }, 30_000, 'daemon did not become healthy on its port within 30s');
    ok('daemon boots healthy (fresh, no users)');

    // --- Boot the real Next standalone, pointed at our daemon. ------------------------------------
    webProc = spawn(process.execPath, [webServer], {
      cwd: join(repoRoot, 'web-dist'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: baseChildEnv({
        PORT: String(webPort),
        HOSTNAME: '127.0.0.1',
        NODE_ENV: 'production',
        ELOWEN_DAEMON_URL: DAEMON,
        ELOWEN_LOG_DIR: join(dataDir, 'logs'),
      }),
    });
    webProc.stdout.on('data', (d) => webLogs.push(d.toString()));
    webProc.stderr.on('data', (d) => webLogs.push(d.toString()));
    webProc.on('exit', (code, signal) => { webLogs.push(`\n[web exited code=${code} signal=${signal}]\n`); });

    await pollUntil(async () => {
      const r = await http('GET', WEB, '/');
      return r.status === 200;
    }, 45_000, 'web standalone did not serve / with 200 within 45s');
    ok('web standalone serves / with 200');

    // --- 1) KEY PAGES SERVE 200 (not 500). -------------------------------------------------------
    // Every app route is a client-rendered SPA behind a client-side LoginGate, so the standalone
    // returns a 200 HTML shell for all of them even on a fresh install — the login/onboarding UI is
    // painted in the browser, not by an SSR redirect. The teeth here is therefore "renders at all":
    // a 500 means a broken build/bundle. We assert 200 AND that the body is the HTML document.
    const PAGES = [
      '/', '/onboarding', '/dash', '/settings', '/users', '/stats', '/kanban', '/tasks',
      '/chat', '/sessions', '/projects', '/memory', '/timeline', '/escalations', '/account',
      '/editor', '/terminal/e2e', // dynamic route [name] — arbitrary segment must still render
    ];
    for (const path of PAGES) {
      const r = await http('GET', WEB, path);
      assert(r.status === 200, `page ${path} returned ${r.status} (expected 200; a 500 = broken build)`);
      assert(/<html/i.test(r.text), `page ${path} 200 but body is not an HTML document`);
    }
    ok(`key pages serve 200 (${PAGES.length} routes incl. onboarding, login-gated app, dynamic /terminal)`);

    // --- 2) BFF PROXY: SETUP-MODE TOKENLESS PASSTHROUGH (0 users). --------------------------------
    // With no session cookie the proxy forwards tokenless; the daemon's own guard keeps public and
    // (in setup mode) all routes open, so first-run onboarding is reachable through the proxy.
    {
      const setup = await http('GET', WEB, '/api/setup');
      assert(setup.status === 200 && setup.json?.needsSetup === true, `/api/setup should be needsSetup=true in setup mode, got ${setup.status} ${setup.text}`);

      const me = await http('GET', WEB, '/api/auth/me');
      // TEETH: setup-mode tokenless must NOT be wrongly 401'd.
      assert(me.status === 200, `/api/auth/me tokenless should be 200 in setup mode, got ${me.status}`);
      assert(me.json != null && me.json.user == null, `/api/auth/me should carry no user in setup mode: ${me.text}`);

      const cli = await http('GET', WEB, '/api/integrations/cli-status');
      assert(cli.status === 200 && cli.json !== undefined, `/api/integrations/cli-status should be reachable tokenless, got ${cli.status} ${cli.text}`);
    }
    ok('proxy setup-mode tokenless passthrough: /api/setup needsSetup=true, /api/auth/me 200 no-user, cli-status 200');

    // --- 3) CREATE FIRST ADMIN THROUGH THE PROXY (the count==0 bootstrap path). -------------------
    {
      const r = await http('POST', WEB, '/api/users', { body: { username: ADMIN_USER, password: ADMIN_PASS }, origin: webOrigin });
      assert(r.status === 201, `POST /api/users (first admin) should be 201, got ${r.status}: ${r.text}`);
      assert(r.json?.is_admin === true, `first user should be admin: ${r.text}`);
      assert(r.json?.username === ADMIN_USER, `username mismatch: ${r.text}`);
    }
    ok('proxy POST /api/users creates the first admin (201, is_admin)');

    // --- 4) AUTH RE-ENGAGES; TOKENLESS 401 MUST NOT CLEAR A COOKIE THAT ISN'T THERE. --------------
    {
      const setup = await http('GET', WEB, '/api/setup');
      assert(setup.status === 200 && setup.json?.needsSetup === false, `/api/setup should be needsSetup=false after setup: ${setup.text}`);

      const me = await http('GET', WEB, '/api/auth/me');
      assert(me.status === 401, `/api/auth/me tokenless should be 401 once an admin exists, got ${me.status}`);
      // TEETH: a tokenless upstream 401 has no session to expire, so the proxy must not emit a clear-cookie.
      assert(sessionCookieValue(me.setCookies) === null, `tokenless 401 must not set/clear a session cookie: ${JSON.stringify(me.setCookies)}`);
    }
    ok('auth re-engages after setup; tokenless 401 does NOT manufacture a cookie clear');

    // --- 5) THE CLIENT CANNOT SMUGGLE ITS OWN Authorization (allow-list strips it). ---------------
    // A REAL, valid daemon token (minted straight from the daemon) is sent as the client's own
    // Authorization header on a cookieless proxied call. If the proxy forwarded it, the daemon would
    // authenticate and answer 200. Because forwardHeaders() drops Authorization and there is no cookie
    // to inject a Bearer from, the daemon sees no auth → 401. Verified via daemon-observed behavior.
    {
      const login = await http('POST', DAEMON, '/auth/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
      assert(login.status === 200 && typeof login.json?.token === 'string', `direct daemon login should mint a token: ${login.status} ${login.text}`);
      const validToken = login.json.token;

      const smuggled = await http('GET', WEB, '/api/auth/me', { headers: { authorization: `Bearer ${validToken}` } });
      // TEETH: if the client's Authorization were forwarded, this would be 200. It must be 401.
      assert(smuggled.status === 401, `client-supplied Authorization must be stripped by the proxy (expected 401, got ${smuggled.status})`);
    }
    ok('proxy strips client Authorization: a valid Bearer sent by the client is NOT forwarded (401)');

    // --- 6) LOG IN VIA THE WEB LOGIN ROUTE → httpOnly cookie → authed proxied call succeeds. -------
    let sessionCookie = null;
    {
      const login = await http('POST', WEB, '/api/auth/login', { body: { username: ADMIN_USER, password: ADMIN_PASS }, origin: webOrigin });
      assert(login.status === 200 && login.json?.ok === true, `web login should be 200 {ok:true}, got ${login.status} ${login.text}`);
      const token = sessionCookieValue(login.setCookies);
      assert(token && token.length > 0, `web login must set a non-empty httpOnly elowen_session cookie: ${JSON.stringify(login.setCookies)}`);
      const cookieAttrs = login.setCookies.find((c) => c.startsWith('elowen_session=')) ?? '';
      assert(/HttpOnly/i.test(cookieAttrs), `session cookie must be HttpOnly: ${cookieAttrs}`);
      sessionCookie = `elowen_session=${token}`;

      const me = await http('GET', WEB, '/api/auth/me', { cookie: sessionCookie });
      // TEETH: the proxy must inject the Bearer from the cookie so the authed call succeeds.
      assert(me.status === 200, `authed /api/auth/me with cookie should be 200, got ${me.status}`);
      assert(me.json?.user?.username === ADMIN_USER, `authed /api/auth/me should return the admin: ${me.text}`);
    }
    ok('web login sets httpOnly cookie; proxy injects Bearer so an authed /api/auth/me succeeds (200)');

    // --- 7) UPSTREAM 401 WITH A TOKEN PRESENT → proxy clears the cookie. --------------------------
    // A stale/garbage session cookie makes the daemon 401. Because a token WAS present, the proxy must
    // append a clear-cookie so the gate logs out — the mirror image of the tokenless case in step 4.
    {
      const bogus = 'elowen_session=stale-invalid-token';
      const me = await http('GET', WEB, '/api/auth/me', { cookie: bogus });
      assert(me.status === 401, `a bogus session cookie should upstream-401, got ${me.status}`);
      // TEETH: on a 401 with a token present the proxy expires the cookie (Max-Age=0, empty value).
      const cleared = me.setCookies.find((c) => c.startsWith('elowen_session='));
      assert(cleared != null, `401-with-token must emit a clear-cookie, none found: ${JSON.stringify(me.setCookies)}`);
      assert(/Max-Age=0/i.test(cleared) && sessionCookieValue(me.setCookies) === '', `clear-cookie must expire the session (Max-Age=0, empty value): ${cleared}`);
    }
    ok('upstream 401 WITH a token present clears the session cookie (Max-Age=0)');

    process.stdout.write(`\nPASS web-e2e — ${passed} checks, daemon :${daemonPort}, web :${webPort}\n`);
  } catch (err) {
    process.stderr.write(`\nFAIL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`\n----- daemon log tail -----\n${daemonLogs.join('').split('\n').slice(-30).join('\n')}\n`);
    process.stderr.write(`\n----- web log tail -----\n${webLogs.join('').split('\n').slice(-30).join('\n')}\n`);
    process.exitCode = 1;
  } finally {
    // Teardown: kill web AND daemon, then remove the temp dir. Best-effort, never masks the failure.
    await stopProc(webProc);
    await stopProc(daemonProc);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }

    const prodPidAfter = prodDaemonPid();
    if (prodPidBefore !== prodPidAfter) {
      process.stderr.write(`\nFAIL: prod daemon PID changed (${prodPidBefore} → ${prodPidAfter}) — this suite must never touch prod\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`prod daemon PID unchanged (${prodPidBefore ?? 'n/a'})\n`);
    }
    clearTimeout(watchdog);
  }
}

main();
