#!/usr/bin/env node
// Recovery layer 2 E2E — real daemon PAUSE/RESUME across a restart, for delegated sub-agents and owner turns.
//
// Every scenario boots dist/daemon/index.js through spawnRealDaemon: an auto-selected loopback port and a
// throwaway SQLite data directory are the only runtime state. No production port, DB or systemd unit is used.
// The scripted provider controls child progress, while every transition under test waits for a durable DB row
// or an observed provider request instead of assuming an elapsed delay.
//
// Every restart is a real SIGTERM. The harness reports how long the exit took and whether it had to
// SIGKILL: the daemon pauses on SIGTERM (checkpoint, exit within seconds), and each scenario asserts that
// bound plus the time from boot to the first resumed model request — the two numbers the redesign is for.

import Database from 'better-sqlite3';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { MARKERS, startRecoveryModel } from './model.mjs';

const DEADLINE_MS = 60_000;
/** The pause's exit bound. Production target is 5 s; the harness SIGKILLs at 3 s, so a clean exit here
 *  proves the daemon left on its own well inside the target. */
const PAUSE_EXIT_BOUND_MS = 3_000;
let failures = 0;
const timings = [];

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
  // The daemon logs to ELOWEN_LOG_DIR, not stdout: attach its tail, or a timeout explains nothing.
  const tail = currentDaemon ? daemonLog(currentDaemon).split('\n').filter((line) => /ERROR|WARN|DBG|recover|resume|continu|parked/.test(line)).slice(-25).join('\n') : '';
  throw new Error(`timed out waiting for ${label}; last observation: ${typeof last === 'string' ? last : JSON.stringify(last)}\n--- daemon log (filtered tail) ---\n${tail}`);
}
/** The scenario's daemon, for diagnostics on a timeout. */
let currentDaemon = null;

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

/** Everything the daemon logged so far (every day file under its log dir). The daemon logs to
 *  ELOWEN_LOG_DIR, not to stdout, so `logText()` is not where its lines are. */
function daemonLog(daemon) {
  try {
    return readdirSync(daemon.logDir).filter((name) => name.startsWith('daemon-')).sort()
      .map((name) => readFileSync(join(daemon.logDir, name), 'utf8')).join('\n');
  } catch { return ''; }
}

/** Problems with the ORDER of a provider payload (OpenAI chat shape): every `tool` message must directly
 *  follow the assistant message that issued its call (or another tool message of the same batch), and a
 *  tool_call_id may be answered once. A transcript that violates this is refused by every provider with a
 *  400 — durably, on every later turn — which is exactly the failure a checkpoint must never produce. */
function wireOrderProblems(messages) {
  const problems = [];
  const answered = new Set();
  let openBatch = new Set();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      openBatch = new Set((message.tool_calls ?? []).map((call) => call.id));
      continue;
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id;
      if (answered.has(id)) problems.push(`tool_call_id ${id} answered twice (message ${index})`);
      if (!openBatch.has(id)) problems.push(`tool result ${id} at message ${index} does not follow its assistant call`);
      answered.add(id);
      continue;
    }
    if (openBatch.size > 0 && ![...openBatch].every((id) => answered.has(id))) {
      problems.push(`message ${index} (${message.role}) interrupts an unanswered tool batch`);
    }
    openBatch = new Set();
  }
  return problems;
}

/** An assistant message with neither text nor tool calls — what providers reject with a 400. */
function hasEmptyAssistant(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => message.role === 'assistant'
    && !(message.tool_calls?.length) && !(typeof message.content === 'string' ? message.content.trim() : JSON.stringify(message.content ?? '').length > 2));
}

/** The silent resume's two invariants, asserted per scenario: no request the model received and no row of
 *  any transcript announces the restart (the old resume notes), and no `restart-resume` custom row exists. */
function checkSilentResume(label, daemon, model) {
  check(`${label}: no restart note reached the model in any request`, model.resumeNotesSeen() === 0, `notes seen=${model.resumeNotesSeen()}`);
  const noted = rows(daemon.dataDir, "SELECT session_id FROM brain_messages WHERE content LIKE '%The daemon restarted%' OR content LIKE '%restart-resume%' OR content LIKE '%restart-continue%'", []);
  check(`${label}: no restart note or resume custom row in any transcript`, noted.length === 0, JSON.stringify(noted));
}

/** Assert the restart was a PAUSE (own exit, no SIGKILL, inside the bound) and record its numbers. */
function checkPause(label, daemon, firstResumedAt) {
  const restart = daemon.lastRestart();
  const resumeMs = firstResumedAt ? firstResumedAt - restart.bootAt : null;
  timings.push({ label, stopMs: restart.stopMs, forced: restart.forced, exitCode: restart.exit?.code, bootMs: restart.bootMs, resumeMs });
  check(`${label}: the daemon paused on SIGTERM and exited on its own within ${PAUSE_EXIT_BOUND_MS} ms`,
    !restart.forced && restart.exit?.code === 0 && restart.stopMs < PAUSE_EXIT_BOUND_MS,
    `stopMs=${restart.stopMs} forced=${restart.forced} exit=${JSON.stringify(restart.exit)}`);
}

/** Runner variant (`ELOWEN_SUBAGENT_RUNNER=1`): delegated turns execute in a forked sub-agent runner, the
 *  production shape, so the pause leaves an ORPHANED runner behind (it aborts on IPC close and dies with
 *  the daemon) and the child's checkpoint is whatever that race wrote — an empty aborted assistant row
 *  included. The switch is a runtime config flag, set after boot exactly like subagent-e2e does. */
const USE_RUNNER = process.env.ELOWEN_SUBAGENT_RUNNER === '1';
async function enableRunner(daemon, token) {
  if (!USE_RUNNER) return;
  const res = await fetch(`${daemon.baseUrl}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ runtime: { subagentRunnerEnabled: true } }),
  });
  if (!res.ok) throw new Error(`enabling the sub-agent runner failed: HTTP ${res.status} ${await res.text()}`);
}

/** Proof the runner path was actually taken: the pool logs every fork. */
function checkRunnerUsed(label, daemon) {
  if (!USE_RUNNER) return;
  check(`${label}: the delegated turn ran in a forked sub-agent runner`, daemonLog(daemon).includes('sub-agent pool: forking a runner'));
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
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-bg' }); currentDaemon = daemon;
    const token = daemon.token;
    await enableRunner(daemon, token);
    const run = await startDelegation({ daemon, token, task: MARKERS.backgroundTask });
    await model.initialChildArrived;
    check('the background child reached the provider while its durable row is running', run.lifecycle === 'running'
      && model.childRequests().length === 1);
    checkRunnerUsed('background', daemon);

    await daemon.restart();
    const terminal = await waitFor('the recovered background row to become done', () => row(daemon.dataDir,
      `SELECT lifecycle, attempt, state FROM brain_subagent_runs
       WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'done'`, [run.parent_session_id, run.tool_call_id]));
    const inbox = await waitFor('the recovered background result in the durable inbox', () => {
      const found = resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id);
      return found.length === 1 ? found[0] : null;
    });
    const payload = JSON.parse(inbox.payload);
    const restartAt = daemon.lastRestart().bootAt;
    const recoveredRequests = model.childRequests().filter((request) => request.at > restartAt);
    checkPause('background', daemon, recoveredRequests[0]?.at);

    check('boot recovery continued the child exactly once', terminal.attempt === 1 && model.childRequests().length === 2,
      `attempt=${terminal.attempt}; child requests=${model.childRequests().length}`);
    // SILENT: the continuation request is the SAME context the child was working in — no note, no new
    // message of any role appended behind the task it was given.
    const before = model.childRequests()[0]?.body?.messages ?? [];
    const after = recoveredRequests[0]?.body?.messages ?? [];
    // Same roles in the same order, the task still the last user message, and NOTHING appended. (The
    // ambient before-user context block is composed per prompt, never persisted, so it is the one part
    // of the user message a rehydrated continuation does not carry — nothing to do with the resume.)
    const roles = (messages) => messages.filter((m) => m.role !== 'system').map((m) => m.role);
    check('the continuation replays exactly the interrupted context (no message appended)', recoveredRequests.length === 1
      && JSON.stringify(roles(after)) === JSON.stringify(roles(before)) && roles(after).at(-1) === 'user'
      && JSON.stringify(after.at(-1)?.content ?? '').includes(MARKERS.backgroundTask),
      `before=${JSON.stringify(roles(before))} after=${JSON.stringify(roles(after))}`);
    checkSilentResume('background', daemon, model);
    check('no empty assistant message reaches the provider on the respawn', !hasEmptyAssistant(recoveredRequests[0]?.body?.messages));
    check('the original run is terminal done', terminal.lifecycle === 'done' && JSON.parse(terminal.state).status === 'done');
    check('the inbox contains the child\'s actual recovered answer', inbox.status === 'done' && payload.result?.includes(MARKERS.backgroundResult), JSON.stringify(payload));
    // Recovery uses the `restart-` id namespace as its stable key, so semantic synthetic-ness is the payload:
    // a real completion must not be an interruption error nor coexist with a second synthetic notice.
    check('no synthetic interruption result accompanies the real completion', !payload.error && resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id).length === 1,
      `result id=${inbox.result_id}`);
    // The delivery the parent used to wait a whole boot for: the recovered result reaches the parent's
    // model in THIS boot, and exactly once.
    const delivered = await waitFor('the parent to receive the recovered result', () => model.requests.find((request) =>
      JSON.stringify(request.body).includes('<subagent-result') && JSON.stringify(request.body).includes(MARKERS.backgroundResult)));
    await waitFor('the inbox row to be acknowledged', () => resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id)[0]?.delivery_state === 'acknowledged');
    check('the recovered result was delivered to the parent in the same boot', !!delivered);
    check('the result reached the parent exactly once', model.requests.filter((request) =>
      JSON.stringify(request.body).includes('<subagent-result') && JSON.stringify(request.body).includes(MARKERS.backgroundResult)).length === 1);
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
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-fg' }); currentDaemon = daemon;
    const token = daemon.token;
    await enableRunner(daemon, token);
    const run = await startDelegation({ daemon, token, task: MARKERS.foregroundTask });
    await model.initialChildArrived;
    check('the foreground child is genuinely in flight before restart', run.lifecycle === 'running' && model.childRequests().length === 1);

    await daemon.restart();
    // The pause parked the owner turn mid-Delegate: the marker is what makes the resume deterministic. Read
    // off the daemon's own log line, because the marker is cleared again as soon as the resume consumes it.
    const parkedAtBoot = daemonLog(daemon).includes(`parked for boot resume: ${run.parent_session_id}`);
    const terminal = await waitFor('the recovered foreground row to become done', () => row(daemon.dataDir,
      `SELECT lifecycle, attempt, state FROM brain_subagent_runs
       WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'done'`, [run.parent_session_id, run.tool_call_id]));
    const inbox = await waitFor('the foreground recovery inbox result', () => {
      const found = resultRows(daemon.dataDir, run.parent_session_id, run.tool_call_id);
      return found.length === 1 ? found[0] : null;
    });
    const payload = JSON.parse(inbox.payload);
    const recovered = model.childRequests().find((request) => request.at > daemon.lastRestart().bootAt);
    checkPause('foreground', daemon, recovered?.at);

    check('the pause wrote the park marker for the owner turn blocked on its Delegate', parkedAtBoot);
    check('foreground recovery respawned the child after the parent turn died', terminal.attempt === 1 && model.childRequests().length === 2);
    check('foreground run terminalized as done', terminal.lifecycle === 'done' && JSON.parse(terminal.state).status === 'done');
    check('foreground result is durable inbox data, not only a dead tool waiter', inbox.status === 'done'
      && payload.result?.includes(MARKERS.foregroundResult), JSON.stringify(payload));
    // No ten-minute wait anywhere: the parked owner is NOT resumed with a generic note (it was waiting on
    // exactly this child); the child's answer is its continuation, delivered in this boot, and it
    // un-parks the conversation.
    const delivered = await waitFor('the parent to receive the recovered foreground result', () => model.requests.find((request) =>
      JSON.stringify(request.body).includes('<subagent-result') && JSON.stringify(request.body).includes(MARKERS.foregroundResult)));
    await waitFor('the parent to be un-parked after consuming the result', () =>
      row(daemon.dataDir, 'SELECT parked_at FROM brain_sessions WHERE id = ?', [run.parent_session_id])?.parked_at === null);
    check('the foreground parent got the result as its continuation', !!delivered);
    const parentWire = wireOrderProblems(Array.isArray(delivered?.body?.messages) ? delivered.body.messages : []);
    check('the parent continuation payload is a valid provider wire order', parentWire.length === 0, parentWire.join('; '));
    checkSilentResume('foreground', daemon, model);
    const parentTail = rows(daemon.dataDir, 'SELECT content FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC', [run.parent_session_id])
      .map((entry) => String(entry.content));
    // Either shape is right, and which one appears depends on the race between the child's respawn and
    // the owner's spawn: `resuming` when the child was still being recovered, `result recovered` when it
    // had already finished and its answer was folded straight into the tool result.
    check('the parent transcript answers the interrupted Delegate call instead of hiding it',
      parentTail.some((content) => content.includes('"toolResult"') && content.includes(run.tool_call_id)
        && (content.includes('[interrupted, resuming]') || content.includes('[interrupted, result recovered]'))));
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function scenarioInterruptedToolRecovery() {
  console.log('\n— 3: an unanswered local tool call is answered [interrupted] and the child resumes on its own —');
  const model = await startRecoveryModel({
    task: MARKERS.unsafeTask,
    result: MARKERS.unsafeContinued,
    unsafe: true,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-unsafe' }); currentDaemon = daemon;
    const token = daemon.token;
    await enableRunner(daemon, token);
    const run = await startDelegation({ daemon, token, task: MARKERS.unsafeTask });
    const pending = await waitFor('the persisted unanswered Bash tool call', () => {
      const pendingRows = rows(daemon.dataDir,
        `SELECT content FROM brain_messages WHERE session_id = ? AND pending = 1 ORDER BY rowid ASC`, [run.child_session_id]);
      return pendingRows.find((entry) => String(entry.content).includes('call_recovery_') && String(entry.content).includes('Bash')) ?? null;
    });
    check('the child is running with a persisted mutating Bash call and no result row yet', run.lifecycle === 'running'
      && String(pending.content).includes('Bash') && model.childRequests().length === 1);
    checkRunnerUsed('interrupted-tool', daemon);

    await daemon.restart();
    const terminal = await waitFor('the interrupted run to complete', () => row(daemon.dataDir,
      `SELECT lifecycle, attempt, state FROM brain_subagent_runs
       WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'done'`, [run.parent_session_id, run.tool_call_id]));
    const respawn = model.childRequests().find((request) => request.at > daemon.lastRestart().bootAt);
    checkPause('interrupted-tool', daemon, respawn?.at);

    check('the child was continued exactly once, with no instruction of any kind', !!respawn && model.childRequests().length === 2,
      `child requests=${model.childRequests().length}`);
    checkSilentResume('interrupted-tool', daemon, model);
    // The continuation's last message IS the interrupted result: the explanation sits inside it.
    const lastOnWire = respawn?.body?.messages?.at(-1);
    check('the continuation ends on the [interrupted] tool result, with the explanation inside it', lastOnWire?.role === 'tool'
      && String(lastOnWire?.content).includes('interrupted by a daemon restart') && String(lastOnWire?.content).includes('Verify the current state before repeating'));
    // What the model saw: its own Bash call, answered with an [interrupted] error — never a silently
    // trimmed transcript, never a parked run waiting for a human.
    const respawnWire = wireOrderProblems(Array.isArray(respawn?.body?.messages) ? respawn.body.messages : []);
    check('the respawn payload is a valid provider wire order', respawnWire.length === 0, respawnWire.join('; '));
    check('no empty assistant message (an orphaned runner\'s abort fragment) reaches the provider', !hasEmptyAssistant(respawn?.body?.messages));
    const respawnBody = JSON.stringify(respawn?.body ?? {});
    check('the respawn context carries the Bash call and its [interrupted] answer', respawnBody.includes('call_recovery_')
      && respawnBody.includes('[interrupted]') && respawnBody.includes('may or may not have taken effect'));
    const childRows = rows(daemon.dataDir, 'SELECT content, pending FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC', [run.child_session_id]);
    check('the child transcript is settled with the synthetic result right behind the call', childRows.every((entry) => entry.pending === 0)
      && childRows.some((entry) => String(entry.content).includes('"toolResult"') && String(entry.content).includes('[interrupted]')));
    check('the run completed as done with the child\'s answer', terminal.lifecycle === 'done' && terminal.attempt === 1
      && JSON.parse(terminal.state).status === 'done');
    check('no recovery_required row and no DelegateContinue were needed', !model.toolCalls.some((call) => call.name === 'DelegateContinue'));
    const delivered = await waitFor('the parent to receive the child\'s answer', () => model.requests.find((request) =>
      JSON.stringify(request.body).includes('<subagent-result') && JSON.stringify(request.body).includes(MARKERS.unsafeContinued)));
    check('the parent received the answer in this boot', !!delivered);
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function scenarioOwnerTurnPause() {
  console.log('\n— 5: an OWNER turn paused mid-Bash resumes with the [interrupted] result and its queued message —');
  const model = await startRecoveryModel({
    task: MARKERS.ownerBashTask,
    result: MARKERS.ownerBashResult,
    ownerBash: true,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-owner' }); currentDaemon = daemon;
    const token = daemon.token;
    const parentSessionId = await startParent(daemon.baseUrl, token);
    await post(daemon.baseUrl, token, '/brain/send', { text: `Do this: ${MARKERS.ownerBashTask}`, session: parentSessionId, mode: 'build' });
    await waitFor('the persisted unanswered owner Bash call', () => rows(daemon.dataDir,
      `SELECT content FROM brain_messages WHERE session_id = ? AND pending = 1`, [parentSessionId])
      .find((entry) => String(entry.content).includes('Bash')) ?? null);
    // A message typed while the tool runs lives only in PI's queue until the pause checkpoints it.
    await post(daemon.baseUrl, token, '/brain/send', { text: MARKERS.ownerSteer, session: parentSessionId, mode: 'build' });
    await waitFor('the steered message to be queued', async () => {
      const res = await fetch(`${daemon.baseUrl}/brain/queue?session=${encodeURIComponent(parentSessionId)}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null);
      return JSON.stringify(body ?? {}).includes(MARKERS.ownerSteer) ? body : null;
    });

    await daemon.restart();
    const parked = daemonLog(daemon).includes(`parked for boot resume: ${parentSessionId}`);
    const resumed = await waitFor('the continued owner turn to reach the model', () => model.requests.find((request) =>
      request.at > daemon.lastRestart().bootAt && JSON.stringify(request.body).includes('[interrupted]')));
    checkPause('owner-bash', daemon, resumed?.at);
    checkSilentResume('owner-bash', daemon, model);
    check('the continuation ends on the [interrupted] Bash result, nothing appended behind it', resumed?.body?.messages?.at(-1)?.role === 'tool');

    check('the pause parked the owner turn', parked);
    const wire = wireOrderProblems(Array.isArray(resumed?.body?.messages) ? resumed.body.messages : []);
    check('the resumed payload is a valid provider wire order (tool results behind their calls, no duplicate ids)', wire.length === 0, wire.join('; '));
    const body = JSON.stringify(resumed?.body ?? {});
    check('the resumed turn sees its Bash call answered [interrupted]', body.includes('[interrupted]') && body.includes('may or may not have taken effect'));
    // The queued message is NOT in the resumed context (that would put a user row between the Bash call
    // and its answer); it is replayed as its own turn AFTER the continuation, with a valid wire order.
    check('the resumed continuation does not carry the queued message inside the interrupted step', !body.includes(MARKERS.ownerSteer));
    const replayed = await waitFor('the queued message to be replayed as a turn of its own', () => model.requests.find((request) =>
      request.at > resumed.at && JSON.stringify(request.body).includes(MARKERS.ownerSteer)));
    const replayWire = wireOrderProblems(Array.isArray(replayed?.body?.messages) ? replayed.body.messages : []);
    check('the replayed turn is a valid provider wire order', replayWire.length === 0, replayWire.join('; '));
    const userRows = rows(daemon.dataDir, `SELECT content FROM brain_messages WHERE session_id = ? AND role = 'user' ORDER BY rowid ASC`, [parentSessionId]);
    check('the replayed message became a durable user row exactly once', userRows.filter((entry) => String(entry.content).includes(MARKERS.ownerSteer)).length === 1);
    check('the pause checkpoint was consumed', rows(daemon.dataDir, 'SELECT seq FROM brain_paused_queue WHERE session_id = ?', [parentSessionId]).length === 0);
    await waitFor('the owner turn to finish and un-park', () =>
      row(daemon.dataDir, 'SELECT parked_at FROM brain_sessions WHERE id = ?', [parentSessionId])?.parked_at === null);
    const answer = await waitFor('the final owner answer to be stored', () => rows(daemon.dataDir,
      `SELECT content FROM brain_messages WHERE session_id = ? AND role = 'assistant' ORDER BY rowid DESC`, [parentSessionId])
      .find((entry) => String(entry.content).includes(MARKERS.ownerBashResult)) ?? null);
    // Exactly one continuation turn: one request after the restart ends on the interrupted result and
    // does not yet carry the replayed message.
    check('the owner got the answer the pause interrupted, exactly once', !!answer && model.requests.filter((request) =>
      request.at > daemon.lastRestart().bootAt && request.body?.messages?.at(-1)?.role === 'tool'
      && !JSON.stringify(request.body).includes(MARKERS.ownerSteer)).length === 1);
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

async function scenarioNestedRecovery() {
  console.log('\n— 6: parent → child → grandchild across a restart: the grandchild\'s answer reaches the parent exactly once —');
  const model = await startRecoveryModel({
    task: MARKERS.foregroundTask,
    result: MARKERS.nestedChildResult,
    nested: true,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-nested' }); currentDaemon = daemon;
    const token = daemon.token;
    await enableRunner(daemon, token);
    const run = await startDelegation({ daemon, token, task: MARKERS.foregroundTask });
    // The child delegates in turn; wait for the grandchild's durable row and its first model request.
    const grand = await waitFor('the grandchild\'s durable running row', () => row(daemon.dataDir,
      `SELECT parent_session_id, tool_call_id, child_session_id, lifecycle FROM brain_subagent_runs WHERE parent_session_id = ? AND lifecycle = 'running'`,
      [run.child_session_id]));
    await model.initialChildArrived;
    check('three levels are in flight: parent turn, child waiting on its Delegate, grandchild mid-model-call',
      run.lifecycle === 'running' && grand.lifecycle === 'running');

    await daemon.restart();
    const grandDone = await waitFor('the grandchild run to complete', () => row(daemon.dataDir,
      `SELECT lifecycle, attempt FROM brain_subagent_runs WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'done'`,
      [grand.parent_session_id, grand.tool_call_id]));
    const childDone = await waitFor('the child run to complete', () => row(daemon.dataDir,
      `SELECT lifecycle, attempt, state FROM brain_subagent_runs WHERE parent_session_id = ? AND tool_call_id = ? AND lifecycle = 'done'`,
      [run.parent_session_id, run.tool_call_id]));
    const firstAfter = model.requests.find((request) => request.at > daemon.lastRestart().bootAt);
    checkPause('nested', daemon, firstAfter?.at);
    checkSilentResume('nested', daemon, model);

    check('both levels recovered exactly once (leaves first)', grandDone.attempt === 1 && childDone.attempt === 1);
    // The grandchild's answer was folded into the child's own Delegate call answer — and the inbox row it
    // came from is acknowledged, not left for the drain to deliver a second time.
    const childRows = rows(daemon.dataDir, 'SELECT content FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC', [run.child_session_id]).map((r) => String(r.content));
    check('the child\'s Delegate call carries the grandchild\'s answer as [interrupted, result recovered]',
      childRows.some((c) => c.includes('"toolResult"') && c.includes(grand.tool_call_id) && c.includes('[interrupted, result recovered]') && c.includes(MARKERS.grandResult)));
    const grandInbox = rows(daemon.dataDir, 'SELECT delivery_state FROM brain_subagent_results WHERE parent_session_id = ? AND tool_call_id = ?', [grand.parent_session_id, grand.tool_call_id]);
    check('the folded grandchild result is acknowledged in the inbox (never redelivered)', grandInbox.length === 1 && grandInbox[0].delivery_state === 'acknowledged', JSON.stringify(grandInbox));
    // The grandchild's answer reached the CHILD's context exactly once — never twice (fold + drain).
    const childSawGrand = model.requests.filter((request) => {
      const text = (Array.isArray(request.body?.messages) ? request.body.messages : []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');
      return text.includes(MARKERS.grandResult) && text.includes('<subagent-result');
    });
    check('no <subagent-result> delivery of the grandchild\'s answer to the child (the fold was the delivery)', childSawGrand.length === 0, `deliveries=${childSawGrand.length}`);
    // And the child's answer reaches the PARENT exactly once.
    const parentDeliveries = model.requests.filter((request) => JSON.stringify(request.body).includes('<subagent-result') && JSON.stringify(request.body).includes(MARKERS.nestedChildResult));
    await waitFor('the parent to receive the child\'s answer', () => model.requests.find((request) => JSON.stringify(request.body).includes('<subagent-result') && JSON.stringify(request.body).includes(MARKERS.nestedChildResult)));
    check('the parent received the child\'s answer exactly once', parentDeliveries.length <= 1 && model.requests.filter((request) => JSON.stringify(request.body).includes('<subagent-result') && JSON.stringify(request.body).includes(MARKERS.nestedChildResult)).length === 1);
    check('the grandchild\'s answer does not reach the parent as a separate delivery', !model.requests.some((request) => JSON.stringify(request.body).includes(`<subagent-result id="restart-${run.child_session_id}`)));
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function scenarioWorkflowRecovery() {
  console.log('\n— 7: a workflow node interrupted mid-tool-call is continued after the restart; its dependent runs; the summary reaches the parent once —');
  const model = await startRecoveryModel({
    task: MARKERS.workflowTask,
    result: MARKERS.workflowNodeTwoResult,
    workflow: true,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'recovery-workflow' }); currentDaemon = daemon;
    const token = daemon.token;
    await enableRunner(daemon, token);
    const nodesFile = join(daemon.dataDir, 'recovery-workflow.json');
    writeFileSync(nodesFile, JSON.stringify({
      title: 'recovery chain',
      nodes: [
        { id: 'one', task: MARKERS.workflowNodeOneTask },
        { id: 'two', task: MARKERS.workflowNodeTwoTask, deps: ['one'] },
      ],
    }));
    const parentSessionId = await startParent(daemon.baseUrl, token);
    const sent = await post(daemon.baseUrl, token, '/brain/send', {
      text: `Start this recovery scenario: ${MARKERS.workflowTask} nodesFile=${nodesFile}`,
      session: parentSessionId,
      mode: 'build',
    });
    if (sent?.accepted === false) throw new Error('parent turn was not accepted');
    const nodeState = (state, id) => JSON.parse(state).nodes.find((node) => node.id === id);
    const wf = await waitFor('a durable running workflow row with node one running', () => {
      const found = row(daemon.dataDir, 'SELECT workflow_id, tool_call_id, state FROM brain_workflows WHERE parent_session_id = ?', [parentSessionId]);
      return found && nodeState(found.state, 'one')?.status === 'running' && nodeState(found.state, 'one')?.sessionId ? found : null;
    });
    const nodeOneSession = nodeState(wf.state, 'one').sessionId;
    await model.initialChildArrived;
    const pending = await waitFor('the persisted unanswered Bash call of node one', () => rows(daemon.dataDir,
      'SELECT content FROM brain_messages WHERE session_id = ? AND pending = 1 ORDER BY rowid ASC', [nodeOneSession])
      .find((entry) => String(entry.content).includes('call_recovery_') && String(entry.content).includes('Bash')) ?? null);
    const nodeOneRequests = () => model.requests.filter((request) => JSON.stringify(request.body).includes(MARKERS.workflowNodeOneTask)
      && JSON.stringify(request.body).includes('You are a focused sub-agent'));
    check('node one is mid-tool-call with a persisted Bash call and no workflow run row of its own', !!pending && nodeOneRequests().length === 1
      && !row(daemon.dataDir, 'SELECT 1 AS x FROM brain_subagent_runs WHERE child_session_id = ?', [nodeOneSession]));
    const journalDir = join(daemon.dataDir, 'plugins-data', 'subagent', 'workflows', 'state');
    check('the engine journaled node one\'s session for the resume', readdirSync(journalDir).some((name) => name.startsWith(wf.workflow_id))
      && readFileSync(join(journalDir, `${wf.workflow_id}.json`), 'utf8').includes(nodeOneSession));

    await daemon.restart();
    const done = await waitFor('the workflow to finish with both nodes done', () => {
      const found = row(daemon.dataDir, 'SELECT state FROM brain_workflows WHERE parent_session_id = ? AND tool_call_id = ?', [parentSessionId, wf.tool_call_id]);
      const state = found ? JSON.parse(found.state) : null;
      return state?.status === 'done' && state.nodes.every((node) => node.status === 'done') ? state : null;
    });
    const bootAt = daemon.lastRestart().bootAt;
    const continued = nodeOneRequests().filter((request) => request.at > bootAt);
    checkPause('workflow', daemon, continued[0]?.at);
    checkSilentResume('workflow', daemon, model);
    check('node one was CONTINUED exactly once, never re-prompted with its task', continued.length === 1 && nodeOneRequests().length === 2,
      `after-restart node-one requests=${continued.length}`);
    const lastOnWire = continued[0]?.body?.messages?.at(-1);
    check('the continuation ends on the [interrupted] Bash result — the same silent resume a delegation gets', lastOnWire?.role === 'tool'
      && String(lastOnWire?.content).includes('[interrupted]') && String(lastOnWire?.content).includes('Verify the current state before repeating'));
    const userTurns = (continued[0]?.body?.messages ?? []).filter((m) => m.role === 'user');
    check('no second user message was appended to node one (the task was not sent again)', userTurns.length === 1, `user messages=${userTurns.length}`);
    const wire = wireOrderProblems(Array.isArray(continued[0]?.body?.messages) ? continued[0].body.messages : []);
    check('the continuation payload is a valid provider wire order', wire.length === 0, wire.join('; '));
    check('node one kept its session across the restart', done.nodes.find((node) => node.id === 'one')?.sessionId === nodeOneSession);
    check('node two ran AFTER node one finished, with node one\'s result as its context',
      model.requests.some((request) => request.at > bootAt && JSON.stringify(request.body).includes(MARKERS.workflowNodeTwoTask))
      && !model.requests.some((request) => JSON.stringify(request.body).includes(`${MARKERS.workflowNodeTwoResult}-MISSING-DEP`)));
    const summaryDeliveries = () => model.requests.filter((request) => JSON.stringify(request.body).includes('<workflow-result')
      && JSON.stringify(request.body).includes(MARKERS.workflowNodeTwoResult));
    await waitFor('the parent to receive the workflow summary', () => summaryDeliveries()[0] ?? null);
    const inbox = await waitFor('the workflow result to be acknowledged in the inbox', () => {
      const found = resultRows(daemon.dataDir, parentSessionId, wf.tool_call_id);
      return found.length === 1 && found[0].delivery_state === 'acknowledged' ? found[0] : null;
    });
    // Let any stray second delivery show up before counting.
    await pause(1_500);
    check('the summary reached the parent exactly once, in this boot', summaryDeliveries().length === 1 && inbox.status === 'done',
      `deliveries=${summaryDeliveries().length}`);
    check('the recovery journal was dropped once the workflow finished', !readdirSync(journalDir).some((name) => name.startsWith(wf.workflow_id)));
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

/** `RECOVERY_E2E_ONLY=1,7` runs a subset while iterating on one scenario; the default is the whole suite. */
const SCENARIOS = [
  scenarioBackgroundRecovery, scenarioForegroundRecovery, scenarioInterruptedToolRecovery, scenarioLegacyMigration,
  scenarioOwnerTurnPause, scenarioNestedRecovery, scenarioWorkflowRecovery,
];
const only = new Set((process.env.RECOVERY_E2E_ONLY ?? '').split(',').map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0));

async function main() {
  for (const [index, scenario] of SCENARIOS.entries()) {
    if (only.size && !only.has(index + 1)) continue;
    await scenario();
  }
  console.log(`\nrestart timings (ms), ${USE_RUNNER ? 'sub-agent RUNNER' : 'in-process'} variant: SIGTERM→exit | boot→healthy | boot→first resumed model request`);
  for (const t of timings) {
    console.log(`  ${t.label.padEnd(18)} stop=${String(t.stopMs).padStart(5)}${t.forced ? ' (SIGKILL!)' : ''}  boot=${String(t.bootMs).padStart(5)}  resume=${t.resumeMs === null ? '   n/a' : String(t.resumeMs).padStart(6)}`);
  }
  console.log(failures === 0
    ? '\nPASS — recovery E2E verifies pause-on-SIGTERM, respawn, same-boot result delivery, interrupted tool calls, owner resume and legacy migration\n'
    : `\nFAIL — recovery E2E had ${failures} failed check(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`SUITE ERROR — ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
