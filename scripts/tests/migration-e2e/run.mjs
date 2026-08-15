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
// It also carries the plugin-extraction upgrade scenario (plan risk 2): the fixture holds a RUNNING
// mission from the pre-plugin core era, in tables the daemon no longer owns. After the upgrade the
// `agents` plugin must be auto-enabled and the plugin-owned autopilot keys COPIED into
// plugins.config.agents with autopilot.* left intact (lossless rollback); the legacy rows must survive
// untouched; a plugin that GRANDFATHERS one of those tables must adopt it (rows included) through
// ctx.db().migrate() at boot and serve it; and /missions — a path whose owner is switched on but not
// installed on this host — must answer an explicit 503 rather than a 404 that reads as data loss.
//
// WHAT IS NOT HERE. `agents` and `work` left this package for the plugin registry, so nothing on this
// host can serve /missions or /tasks and no amount of fixture-building changes that. The daemon-side
// half of every assertion is re-anchored above; the plugin-side half — the agents boot reconcile that
// re-opens a zombie in_progress phase — moved to the registry repo, which owns that code
// (elowen-plugins → tests/agents-registration.test.ts, "reconcileZombies re-opens a task whose agent
// session died").
//
// NO NETWORK. The config migration switches four extracted plugins on, and a daemon that finds an
// enabled plugin missing from disk asks the marketplace to restore it (bootstrap.ts →
// marketplace.reconcileEnabled). Left alone that clones github.com/dragocz95/elowen-plugins from a CI
// runner: slow, flaky, and it would decide the outcome of the assertions below. ELOWEN_PLUGIN_REGISTRY
// therefore points at a local path that does not exist, so the reconcile fails immediately and offline,
// which is exactly the state the 503 is the answer to.

import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOldFixture, writeAdopterPlugin, seedRegistryCache, ADOPTER_PLUGIN, OLD_ADMIN, BOOTSTRAP } from './build-fixture.mjs';

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
    // The extracted-vertical stand-in, installed the way the marketplace installs a plugin, and the
    // registry-cache manifest that lets the daemon name /missions' absent owner. Both must exist before
    // the first boot — the boot scan is what discovers them.
    writeAdopterPlugin(dataDir);
    seedRegistryCache(dataDir, 'agents', ['/missions']);

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

    // 3d) The extracted vertical survived the upgrade, in the two halves this host can observe.
    const auth = { authorization: `Bearer ${login.token}` };

    // The auto-enable reached the RUNNING daemon, not just the settings row: /missions is a path the
    // daemon now attributes to an enabled owner. The code for that owner is in the plugin registry and
    // not on this host, so the honest answer is 503 "enabled but not installed" — 404 would claim the
    // endpoint never existed, which for a mission list reads as data loss. Had the migration failed to
    // enable `agents`, nothing would claim the path and this WOULD be a 404.
    const missionsRes = await fetch(`${baseUrl}/missions`, { headers: auth });
    const missionsBody = await missionsRes.json().catch(() => null);
    assert(missionsRes.status === 503, `/missions answers 503 for the auto-enabled but uninstalled owner (HTTP ${missionsRes.status})`);
    eq(missionsBody, { error: 'agents plugin is enabled but not installed' },
      '/missions names the absent owner rather than 404-ing the path away');

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

      // v1 teeth: rolePolicies tool allow-list inside the settings blob renamed ('*' preserved).
      const settingsData = JSON.parse(db.prepare('SELECT data FROM settings WHERE id = 1').get().data);
      const roleTools = settingsData.plugins.config.someplatform.rolePolicies[0].tools;
      eq(roleTools, expected.expectedRolePolicyTools, 'v1 renamed rolePolicies tools (wildcard preserved)');

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

      // Agents-plugin one-shot migrations (extraction F2): the plugin was auto-enabled for this
      // pre-existing install, and the plugin-owned autopilot keys were COPIED into
      // plugins.config.agents while autopilot.* kept its values (lossless rollback).
      const migrated = JSON.parse(db.prepare('SELECT data FROM settings WHERE id = 1').get().data);
      assert(migrated.plugins.enabled.includes('agents'), 'agents plugin auto-enabled in plugins.enabled');
      eq(migrated.agentsConfigMigrated, true, 'agents auto-enable marker persisted (one-shot)');
      eq(migrated.agentsPluginConfigMigrated, true, 'agents config-copy marker persisted (one-shot)');
      const agentsSlice = migrated.plugins.config.agents;
      eq(agentsSlice.overseerModel, 'legacy-overseer-model', 'overseerModel copied into plugins.config.agents');
      eq(agentsSlice.prBaseBranch, 'develop', 'prBaseBranch copied into plugins.config.agents');
      eq(agentsSlice.prAutoOpen, true, 'prAutoOpen copied into plugins.config.agents');
      eq(agentsSlice.prVerifyCommand, 'npm run verify', 'prVerifyCommand copied into plugins.config.agents');
      eq(migrated.autopilot.overseerModel, 'legacy-overseer-model', 'autopilot.overseerModel untouched (copy, not move)');

      // Config wave 2 (batch 3a): the remaining agents-only keys + the top-level ghToken were COPIED
      // into the slice by their own one-shot migration, with the originals kept for rollback.
      eq(migrated.agentsPluginConfigMigrated2, true, 'agents wave-2 config-copy marker persisted (one-shot)');
      eq(agentsSlice.pilotExec, 'claude:opus', 'pilotExec copied into plugins.config.agents');
      eq(agentsSlice.overseerExec, 'claude:sonnet', 'overseerExec copied into plugins.config.agents');
      eq(agentsSlice.reviewOnDone, true, 'reviewOnDone copied into plugins.config.agents');
      eq(agentsSlice.tddMode, true, 'tddMode copied into plugins.config.agents');
      eq(agentsSlice.prEnabled, true, 'prEnabled copied into plugins.config.agents');
      eq(agentsSlice.ghToken, 'legacy-gh-token', 'ghToken copied into plugins.config.agents');
      eq(migrated.autopilot.pilotExec, 'claude:opus', 'autopilot.pilotExec untouched (copy, not move)');
      eq(migrated.ghToken, 'legacy-gh-token', 'top-level ghToken untouched (copy, not move)');

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
