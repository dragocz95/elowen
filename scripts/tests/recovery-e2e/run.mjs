#!/usr/bin/env node
// Recovery layer 2 E2E — real daemon restart recovery for delegated sub-agents.
//
// Every scenario boots dist/daemon/index.js through spawnRealDaemon: an auto-selected loopback port and a
// throwaway SQLite data directory are the only runtime state. No production port, DB or systemd unit is used.
// The scripted provider controls child progress, while every transition under test waits for a durable DB row
// or an observed provider request instead of assuming an elapsed delay.

import Database from 'better-sqlite3';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { MARKERS, startRecoveryModel } from './model.mjs';

const DEADLINE_MS = 60_000;
let failures = 0;

const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an externally observable condition under a bounded deadline. The short pause only backs off a DB or
 * provider observation; no scenario uses elapsed time as evidence that a turn has reached a state. */
async function waitFor(label, read, deadlineMs = DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await pause(50);
  }
  throw new Error(`timed out waiting for ${label}; last observation: ${typeof last === 'string' ? last : JSON.stringify(last)}`);
}

function rows(dataDir, sql, params = []) {
  const db = new Database(`${dataDir}/elowen.db`, { readonly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

function row(dataDir, sql, params = []) {
  return rows(dataDir, sql, params)[0];
}

async function post(baseUrl, token, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* error text is retained below */ }
  if (!res.ok) throw new Error(`POST ${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  return json;
}

async function startParent(baseUrl, token) {
  const started = await post(baseUrl, token, '/brain/start', { fresh: true });
  if (!started?.sessionId) throw new Error('POST /brain/start did not return a session id');
  // The unsafe scenario drives Bash. Enabling yolo on the test-local parent removes an approval interaction;
  // its inherited child remains confined to spawnRealDaemon's temp project.
  await post(baseUrl, token, '/brain/yolo', { on: true, session: started.sessionId });
  return started.sessionId;
}

async function startDelegation({ daemon, token, task }) {
  const parentSessionId = await startParent(daemon.baseUrl, token);
  const sent = await post(daemon.baseUrl, token, '/brain/send', {
    text: `Start this recovery scenario: ${task}`,
    session: parentSessionId,
    mode: 'build',
  });
  if (sent?.accepted === false) throw new Error('parent turn was not accepted');
  const running = await waitFor('a durable running delegated row', () => row(daemon.dataDir,
    `SELECT parent_session_id, tool_call_id, child_session_id, lifecycle, state
       FROM brain_subagent_runs WHERE parent_session_id = ? AND lifecycle = 'running'`, [parentSessionId]));
  return { parentSessionId, ...running, state: JSON.parse(running.state) };
}

function resultRows(dataDir, parentSessionId, toolCallId) {
  return rows(dataDir,
    `SELECT result_id, status, payload, delivery_state
       FROM brain_subagent_results WHERE parent_session_id = ? AND tool_call_id = ?`,
    [parentSessionId, toolCallId]);
}

async function scenarioBackgroundRecovery() {
  console.log('\n— 1: background Delegate restarts, respawns and stores the real result —');
  const model = await startRecoveryModel({
    task: MARKERS.backgroundTask,
    result: MARKERS.backgroundResult,
    background: true,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-bg' });
    const token = daemon.token;
    const run = await startDelegation({ daemon, token, task: MARKERS.backgroundTask });
    await model.initialChildArrived;
    check('the background child reached the provider while its durable row is running', run.lifecycle === 'running'
      && model.childRequests().length === 1);

    await daemon.restart();
    const terminal = await waitFor('the recovered background row to become done', () => row(daemon.dataDir,
      `SELECT lifecycle, attempt, state FROM brain_subagent_runs
       WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'done'`, [run.parent_session_id, run.tool_call_id]));
    const inbox = await waitFor('the recovered background result in the durable inbox', () => {
      const found = resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id);
      return found.length === 1 ? found[0] : null;
    });
    const payload = JSON.parse(inbox.payload);
    const recoveredRequests = model.childRequests().filter((request) => JSON.stringify(request.body).includes('The daemon restarted and interrupted you mid-task.'));

    check('boot recovery respawned the child exactly once', terminal.attempt === 1 && model.childRequests().length === 2,
      `attempt=${terminal.attempt}; child requests=${model.childRequests().length}`);
    check('the respawn carried the recovery instruction', recoveredRequests.length === 1);
    check('the original run is terminal done', terminal.lifecycle === 'done' && JSON.parse(terminal.state).status === 'done');
    check('the inbox contains the child\'s actual recovered answer', inbox.status === 'done' && payload.result?.includes(MARKERS.backgroundResult), JSON.stringify(payload));
    // Recovery uses the `restart-` id namespace as its stable key, so semantic synthetic-ness is the payload:
    // a real completion must not be an interruption error nor coexist with a second synthetic notice.
    check('no synthetic interruption result accompanies the real completion', !payload.error && resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id).length === 1,
      `result id=${inbox.result_id}`);
    check('the recovered result remains pending in the inbox for parent delivery', inbox.delivery_state === 'pending');
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function scenarioForegroundRecovery() {
  console.log('\n— 2: foreground Delegate restart enqueues its recovered result —');
  const model = await startRecoveryModel({
    task: MARKERS.foregroundTask,
    result: MARKERS.foregroundResult,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-fg' });
    const token = daemon.token;
    const run = await startDelegation({ daemon, token, task: MARKERS.foregroundTask });
    await model.initialChildArrived;
    check('the foreground child is genuinely in flight before restart', run.lifecycle === 'running' && model.childRequests().length === 1);

    await daemon.restart();
    const terminal = await waitFor('the recovered foreground row to become done', () => row(daemon.dataDir,
      `SELECT lifecycle, attempt, state FROM brain_subagent_runs
       WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'done'`, [run.parent_session_id, run.tool_call_id]));
    const inbox = await waitFor('the foreground recovery inbox result', () => {
      const found = resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id);
      return found.length === 1 ? found[0] : null;
    });
    const payload = JSON.parse(inbox.payload);

    check('foreground recovery respawned the child after the parent turn died', terminal.attempt === 1 && model.childRequests().length === 2);
    check('foreground run terminalized as done', terminal.lifecycle === 'done' && JSON.parse(terminal.state).status === 'done');
    check('foreground result is durable inbox data, not only a dead tool waiter', inbox.status === 'done'
      && inbox.delivery_state === 'pending' && payload.result?.includes(MARKERS.foregroundResult), JSON.stringify(payload));
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function scenarioUnsafeToolRecovery() {
  console.log('\n— 3: unanswered tool call parks recovery and the parent continues it —');
  const model = await startRecoveryModel({
    task: MARKERS.unsafeTask,
    result: 'UNUSED-UNSAFE-RECOVERY-RESULT',
    unsafe: true,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-unsafe' });
    let token = daemon.token;
    const run = await startDelegation({ daemon, token, task: MARKERS.unsafeTask });
    const pending = await waitFor('the persisted unanswered Bash tool call', () => {
      const pendingRows = rows(daemon.dataDir,
        `SELECT content FROM brain_messages WHERE session_id = ? AND pending = 1 ORDER BY rowid ASC`, [run.child_session_id]);
      return pendingRows.find((entry) => String(entry.content).includes('call_recovery_') && String(entry.content).includes('Bash')) ?? null;
    });
    check('the child is running with a persisted mutating Bash call and no result row yet', run.lifecycle === 'running'
      && String(pending.content).includes('Bash') && model.childRequests().length === 1);

    token = await daemon.restart();
    const parked = await waitFor('the unsafe run to park as recovery_required', () => row(daemon.dataDir,
      `SELECT lifecycle, state, owner_boot_id, lease_until FROM brain_subagent_runs
       WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'recovery_required'`, [run.parent_session_id, run.tool_call_id]));
    const notice = await waitFor('the recovery-required parent notice in the inbox', () => {
      const found = resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id);
      return found.length === 1 ? found[0] : null;
    });
    const noticePayload = JSON.parse(notice.payload);

    check('unsafe suffix was not auto-respawned', model.childRequests().length === 1,
      `child requests=${model.childRequests().length}`);
    check('the parked row is inert and retains a durable recovery reason', parked.owner_boot_id === null && parked.lease_until === null
      && JSON.parse(parked.state).recoveryReason?.includes('Bash'));
    check('the parent notice tells the parent to use DelegateContinue', notice.status === 'error'
      && noticePayload.error?.includes('DelegateContinue'), JSON.stringify(noticePayload));

    // DelegateContinue is scoped to the conversation that owns the child. Its original blocking turn died,
    // but the parent session itself survived in SQLite and is the only valid continuation caller.
    const delegationsBefore = model.toolCalls.filter((call) => call.name === 'Delegate').length;
    await post(daemon.baseUrl, token, '/brain/send', {
      text: MARKERS.unsafeParentContinue,
      session: run.parent_session_id,
      mode: 'build',
    });
    await waitFor('the parent to invoke DelegateContinue', () => model.toolCalls.some((call) => call.name === 'DelegateContinue'));
    const continuedChild = await waitFor('the parked child continuation request', () => model.childRequests().find((request) =>
      JSON.stringify(request.body).includes(MARKERS.unsafeChildContinue)));
    const parentFollowUp = await waitFor('the parent to receive the continued result', () => model.requests.find((request) => {
      const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
      return messages.at(-1)?.role === 'tool' && JSON.stringify(messages.at(-1)).includes(MARKERS.unsafeContinued);
    }));

    // "Continue, don't re-delegate" is about WHICH tool the parent reached for, not how many times it
    // reached for it. Pinning the count to exactly one made this check fail whenever the scripted model
    // retried a call — a red CI run for behaviour that was correct. What actually matters is that a
    // DelegateContinue happened and that no NEW delegation was started alongside it, and the second half
    // was never asserted at all before.
    const delegationsAfter = model.toolCalls.filter((call) => call.name === 'Delegate').length;
    check('the parent used DelegateContinue instead of a new delegation',
      model.toolCalls.some((call) => call.name === 'DelegateContinue') && delegationsAfter === delegationsBefore,
      `DelegateContinue calls=${model.toolCalls.filter((c) => c.name === 'DelegateContinue').length}, Delegate before=${delegationsBefore} after=${delegationsAfter}`);
    check('DelegateContinue resumed the original child session', JSON.stringify(continuedChild.body).includes(MARKERS.unsafeTask));
    check('the continued child result returned through the parent tool-result path', !!parentFollowUp);
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function scenarioLegacyMigration() {
  console.log('\n— 4: a legacy running row is terminal legacy_interrupted and never respawns —');
  const model = await startRecoveryModel({ task: 'UNUSED-LEGACY-TASK', result: 'UNUSED-LEGACY-RESULT' });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({
      providerBaseUrl: model.baseUrl,
      providerId: 'recovery-legacy',
      // This is the pre-recovery five-column table. The fixture hook runs before the daemon first opens the
      // temp DB, so its real migration path—not a direct post-migration UPDATE—must backfill this row.
      prepareDataDir: (_dataDir, dbPath) => {
        const db = new Database(dbPath);
        try {
          db.exec(`CREATE TABLE brain_subagent_runs (
            parent_session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, child_session_id TEXT NOT NULL,
            state TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (parent_session_id, tool_call_id)
          )`);
          db.prepare(
            'INSERT INTO brain_subagent_runs (parent_session_id, tool_call_id, child_session_id, state) VALUES (?, ?, ?, ?)'
          ).run('legacy-parent', 'legacy-call', 'brain-ch-subagent-legacy-child', JSON.stringify({
            status: 'running', task: 'historic mutation', tools: 0, seconds: 0,
          }));
        } finally { db.close(); }
      },
    });
    const legacy = await waitFor('the old-format row to be migrated', () => row(daemon.dataDir,
      `SELECT lifecycle, owner_boot_id, attempt FROM brain_subagent_runs
       WHERE parent_session_id = 'legacy-parent' AND tool_call_id = 'legacy-call'`));
    const results = rows(daemon.dataDir,
      `SELECT result_id FROM brain_subagent_results WHERE parent_session_id = 'legacy-parent' AND tool_call_id = 'legacy-call'`);

    check('migration turns legacy JSON running into terminal legacy_interrupted', legacy.lifecycle === 'legacy_interrupted');
    check('legacy row has no recovery owner or attempt', legacy.owner_boot_id === null && legacy.attempt === 0);
    check('boot recovery made no model respawn request for legacy work', model.childRequests().length === 0);
    check('legacy row produced neither an inbox result nor restart synthetic result', results.length === 0);
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function main() {
  await scenarioBackgroundRecovery();
  await scenarioForegroundRecovery();
  await scenarioUnsafeToolRecovery();
  await scenarioLegacyMigration();
  console.log(failures === 0
    ? '\nPASS — recovery E2E verifies restart respawn, inbox delivery, fail-closed parking and legacy migration\n'
    : `\nFAIL — recovery E2E had ${failures} failed check(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`SUITE ERROR — ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
