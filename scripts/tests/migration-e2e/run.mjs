// E2E: DB MIGRATION on upgrade.
//
// Boots the REAL built daemon (`dist/daemon/index.js`) against a hand-built OLD-schema SQLite DB (see
// build-fixture.mjs) and proves the migration runner in src/store/db.ts upgrades it cleanly IN PLACE and
// the daemon comes up healthy on it. The source-tree unit tests only ever see a fresh schema, so this is
// the only guard on an existing user's upgrade path.
//
// SAFETY (mirrors scripts/tests/brain-e2e/spawn-daemon.mjs): auto-selected free loopback port (never
// 4400/4500), a throwaway temp dir under os.tmpdir() for the DB + HOME + config, every ELOWEN_* / agent-CLI
// env var stripped from the child so nothing points back at prod, and full teardown in `finally`. The prod
// DB (/var/www/.config/elowen/elowen.db) and prod services are never touched. Does NOT run `elowen up`.
//
// TEETH: the fixture stores OLD tool names / prompt keys and the assertions pin the exact POST-migration
// values (Read,Bash / elowen / dropped personality tables / user_version advanced). A silently-skipped,
// no-op, or data-dropping migration fails the run loudly. Flip any expected value to its pre-migration
// form and the run goes red.
//
// It also carries the retired-domain upgrade boundary: non-empty legacy tables survive untouched and a
// fixture plugin can explicitly adopt one through ctx.db().migrate(), while top-level PR/autopilot config,
// unowned GitHub tokens, retired plugin slices and their migration markers are scrubbed rather than copied.
//
// NO NETWORK. ELOWEN_PLUGIN_REGISTRY points at a local path that does not exist, so marketplace reconcile
// stays deterministic and offline.

import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOldFixture, writeAdopterPlugin, ADOPTER_PLUGIN, OLD_ADMIN, BOOTSTRAP } from './build-fixture.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const daemonEntry = join(repoRoot, 'dist', 'daemon', 'index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolvePort(port) : reject(new Error('failed to allocate a free port'))));
    });
  });
}

async function waitForHealth(baseUrl, deadlineMs) {
  const until = Date.now() + deadlineMs;
  let lastErr = 'no attempt';
  while (Date.now() < until) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) return body;
      }
      lastErr = `status ${res.status}`;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    await sleep(100);
  }
  throw new Error(`daemon did not become healthy within ${deadlineMs}ms (last: ${lastErr})`);
}

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed += 1;
  console.log(`  ok  ${msg}`);
}
function eq(actual, expected, msg) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'elowen-migration-e2e-'));
  const dbPath = join(dataDir, 'elowen.db');
  const logs = [];
  let child = null;
  let exited = null;

  const stop = async () => {
    try {
      if (child && exited === null) {
        child.kill('SIGTERM');
        for (let i = 0; i < 30 && exited === null; i += 1) await sleep(100);
        if (exited === null) child.kill('SIGKILL');
        for (let i = 0; i < 20 && exited === null; i += 1) await sleep(100);
      }
    } catch { /* ignore */ }
  };

  try {
    // 1) Build the OLD-schema fixture (user_version = 0, old tool names, retired tables).
    console.log('Building old-schema fixture at', dbPath);
    const expected = buildOldFixture(dbPath);
    // The extracted-vertical stand-in must exist before the first boot so its migration adopts the
    // non-empty legacy table without core taking ownership of it.
    writeAdopterPlugin(dataDir);

    // Sanity: confirm the fixture really starts un-migrated, else the test would pass vacuously.
    {
      const pre = new Database(dbPath, { readonly: true });
      const v = pre.pragma('user_version', { simple: true });
      const denied = pre.prepare('SELECT disabled_tools FROM users WHERE id = 1').get().disabled_tools;
      pre.close();
      assert(v === 0, `fixture starts at user_version 0 (got ${v})`);
      eq(denied, 'read_file,run_command', 'fixture starts with OLD snake_case disabled_tools');
    }

    // 2) Boot the real daemon against the fixture. Strip prod env, redirect HOME, pass DIFFERENT bootstrap
    //    creds than the pre-existing admin so we can prove setup does not re-trigger.
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const childEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('ELOWEN_')) continue;
      if (k === 'CLAUDE_CONFIG_DIR' || k === 'CODEX_HOME' || k === 'XDG_CONFIG_HOME' || k === 'XDG_DATA_HOME') continue;
      childEnv[k] = v;
    }
    Object.assign(childEnv, {
      HOME: dataDir,
      ELOWEN_DB: dbPath,
      ELOWEN_PORT: String(port),
      ELOWEN_HOST: '127.0.0.1',
      ELOWEN_PROJECT: 'e2e',
      ELOWEN_PROJECT_PATH: dataDir,
      ELOWEN_LOG_DIR: join(dataDir, 'logs'),
      ELOWEN_BOOTSTRAP_USER: BOOTSTRAP.username,
      ELOWEN_BOOTSTRAP_PASS: BOOTSTRAP.password,
      // Deterministic, offline boot reconcile: a local path that is not a repository. `git clone` fails
      // at once, the marketplace logs the registry as unreachable and installs nothing, and the seeded
      // cache above survives (a failed clone only removes its own temp dir). Without this the reconcile
      // would reach for GitHub on any host that has a network.
      ELOWEN_PLUGIN_REGISTRY: join(dataDir, 'no-such-registry.git'),
    });

    console.log('Booting real daemon on', baseUrl);
    child = spawn(process.execPath, [daemonEntry], { cwd: dataDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logs.push(d.toString()));
    child.stderr.on('data', (d) => logs.push(d.toString()));
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    // 3a) Daemon reaches /health 200 { ok: true } ON the migrated DB.
    const health = await waitForHealth(baseUrl, 30_000);
    assert(health.ok === true, `/health returns ok:true (version ${health.version})`);

    // 3b) The pre-existing admin still authenticates with its ORIGINAL password (data intact, real route).
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OLD_ADMIN),
    });
    assert(loginRes.status === 200, `pre-existing admin authenticates via /auth/login (HTTP ${loginRes.status})`);
    const login = await loginRes.json();
    assert(typeof login.token === 'string' && login.token.length > 0, 'login returns a bearer token');
    assert(login.user && login.user.is_admin === true, 'the migrated pre-existing user is admin');

    // 3c) Setup did NOT re-trigger: the bootstrap creds must be rejected (no second admin was created).
    const bootstrapLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BOOTSTRAP),
    });
    assert(bootstrapLogin.status === 401, `bootstrap creds rejected — setup not re-triggered (HTTP ${bootstrapLogin.status})`);

    // 3d) A plugin that explicitly grandfathers the legacy table adopts it at boot; core neither enables
    // a retired owner nor rewrites the rows.
    const auth = { authorization: `Bearer ${login.token}` };

    // The rows themselves: a plugin that grandfathers `missions` adopts the legacy table at boot and
    // serves the pre-upgrade mission. `missionsSeenAtMigration` is recorded INSIDE that migration, so it
    // is the proof the adoption found the existing row rather than creating an empty table beside it.
    const adoptedRes = await fetch(`${baseUrl}/e2e-missions`, { headers: auth });
    assert(adoptedRes.status === 200, `the adopting plugin's route answers after the upgrade (HTTP ${adoptedRes.status})`);
    const adopted = await adoptedRes.json();
    eq(adopted.missionsSeenAtMigration, 1, 'the plugin migration adopted the legacy missions table WITH its row');
    const mission = (adopted.missions ?? []).find((m) => m.id === 'm-epic1');
    assert(mission, 'the pre-upgrade mission m-epic1 is served by the plugin that adopted the table');
    eq(mission.state, 'active', 'the mission is still active (nothing was lost)');

    // 4) Stop the daemon, then open the migrated DB and assert the transforms have teeth.
    await stop();
    if (exited && exited.code !== 0 && exited.signal !== 'SIGTERM') {
      throw new Error(`daemon exited abnormally: code=${exited.code} signal=${exited.signal}`);
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      // Version marker advanced to CURRENT.
      const version = db.pragma('user_version', { simple: true });
      eq(version, expected.expectedUserVersion, 'user_version advanced to CURRENT');

      // Exactly one user — setup did not re-seed a second admin.
      const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      eq(userCount, 1, 'still exactly one user (no duplicate/bootstrap admin inserted)');
      const noFresh = db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get(BOOTSTRAP.username).n;
      eq(noFresh, 0, 'no bootstrap user was created on the populated DB');

      // v1 teeth: disabled_tools rewritten snake_case -> TitleCase.
      const denied = db.prepare('SELECT disabled_tools FROM users WHERE id = 1').get().disabled_tools;
      eq(denied, expected.expectedDisabledTools, 'v1 rewrote disabled_tools to TitleCase');

      // Non-versioned prompt rename: advisor -> elowen, advisor-channel -> elowen-platform.
      const promptNames = db.prepare('SELECT name FROM user_prompts WHERE user_id = 1 ORDER BY name').all().map((r) => r.name);
      eq(promptNames, expected.expectedPromptNames, 'advisor prompt keys renamed to elowen / elowen-platform');
      const advisorGone = db.prepare("SELECT COUNT(*) AS n FROM user_prompts WHERE name IN ('advisor', 'advisor-channel')").get().n;
      eq(advisorGone, 0, 'no old advisor prompt keys remain');

      // v1 teeth: permission JSON tool KEYS renamed, bash scope untouched.
      const perm = JSON.parse(db.prepare("SELECT value FROM user_settings WHERE user_id = 1 AND key = 'permissions'").get().value);
      eq(perm.tools, expected.expectedPermTools, 'v1 renamed permission tool keys to TitleCase');
      eq(perm.bash, { 'git status*': 'allow' }, 'v1 left the bash permission pattern untouched');

      // Data intact: brain session + messages survive with content and get the new columns.
      const sess = db.prepare('SELECT * FROM brain_sessions WHERE id = ?').get('sess-old-1');
      assert(sess && sess.title === 'Legacy chat' && sess.model === 'old-model', 'brain_session survived intact');
      assert('work_dir' in sess && 'parent_session_id' in sess && 'delegated_access' in sess, 'brain_sessions gained the new columns');
      eq(sess.work_dir, '', 'migrated brain_session.work_dir defaults to empty');
      const msgs = db.prepare('SELECT id, content, pending FROM brain_messages WHERE session_id = ? ORDER BY id').all('sess-old-1');
      eq(msgs.length, 2, 'both brain_messages survived (no drop, no duplicate)');
      eq(msgs[0].content, 'hello from the past', 'brain_message content intact');
      eq(msgs[0].pending, 0, 'migrated brain_message.pending defaults to 0 (durable history)');

      // v5 teeth: brain_session_events rebuilt so its CHECK now admits 'cwd', and the old row survived.
      const evDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='brain_session_events'").get().sql;
      assert(/'cwd'/.test(evDdl), "v5 rebuilt brain_session_events with 'cwd' in the CHECK constraint");
      const evCount = db.prepare('SELECT COUNT(*) AS n FROM brain_session_events').get().n;
      eq(evCount, 1, 'the pre-existing session event survived the v5 table rebuild');
      const ev = db.prepare('SELECT kind, detail FROM brain_session_events').get();
      eq(ev, { kind: 'model', detail: 'old-model' }, 'session event content preserved across rebuild');

      // v6 teeth: retired personality tables dropped.
      for (const t of expected.droppedTables) {
        const present = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(t).n;
        eq(present, 0, `v6 dropped the retired table ${t}`);
      }

      // Retired configuration is scrubbed, never copied into a new owner. The fixture leaves an unrelated
      // plugin enabled to prove the cleanup is scoped rather than replacing the whole plugin block.
      const migrated = JSON.parse(db.prepare('SELECT data FROM settings WHERE id = 1').get().data);
      assert(!migrated.plugins.enabled.includes('agents'), 'agents plugin is not auto-enabled');
      assert(!migrated.plugins.enabled.includes('work'), 'work plugin is not auto-enabled');
      assert(!Object.hasOwn(migrated, 'autopilot'), 'legacy autopilot block removed');
      assert(!Object.hasOwn(migrated, 'ghToken'), 'legacy top-level GitHub token removed');
      assert(!Object.hasOwn(migrated, 'agentsConfigMigrated'), 'legacy agents migration marker removed');
      assert(!Object.hasOwn(migrated, 'agentsPluginConfigMigrated'), 'legacy agents config marker removed');
      assert(!Object.hasOwn(migrated, 'agentsPluginConfigMigrated2'), 'legacy agents wave-2 marker removed');
      assert(!Object.hasOwn(migrated.plugins.config, 'agents'), 'legacy agents plugin slice removed');
      assert(!Object.hasOwn(migrated.plugins.config, 'work'), 'legacy work plugin slice removed');

      // The grandfathered plugin schema adopted the OLD tables without touching the rows: each step
      // bookkept exactly once in plugin_migrations, and the legacy rows still there afterwards.
      const pm = db.prepare('SELECT version FROM plugin_migrations WHERE plugin = ? ORDER BY version').all(ADOPTER_PLUGIN.name).map((r) => r.version);
      eq(pm, [1], `the adopting plugin's migration is bookkept exactly once in plugin_migrations`);
      const missionRow = db.prepare("SELECT epic_id, state, autonomy FROM missions WHERE id = 'm-epic1'").get();
      eq(missionRow, { epic_id: 'epic1', state: 'active', autonomy: 'L2' }, 'mission row intact after upgrade');
      // Tables of a vertical the daemon no longer owns: the core migration must not touch them at all,
      // and no plugin here adopts task_deps — an upgrade that tidied up unknown tables would lose this.
      const dep = db.prepare("SELECT COUNT(*) AS n FROM task_deps WHERE task_id = 'ph2' AND depends_on_id = 'ph1'").get().n;
      eq(dep, 1, 'phase dependency intact after upgrade');
      const ph1 = db.prepare("SELECT status FROM tasks WHERE id = 'ph1'").get();
      eq(ph1, { status: 'in_progress' }, 'the legacy task rows are left exactly as they were (no core rewrite)');
    } finally {
      db.close();
    }

    console.log(`\nMIGRATION E2E PASSED — ${passed} assertions.`);
  } catch (err) {
    const tail = logs.join('').split('\n').slice(-40).join('\n');
    console.error('\nMIGRATION E2E FAILED:', err instanceof Error ? err.message : err);
    if (tail.trim()) console.error('--- daemon log tail ---\n' + tail);
    process.exitCode = 1;
  } finally {
    await stop();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main();
