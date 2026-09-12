#!/usr/bin/env node
// Delegate (sub-agent) + Workflow delegation E2E against a REAL built daemon.
//
// Proves real delegation wiring end to end, with NO stub anywhere in the path:
//   1. The PARENT brain turn emits a `Delegate` (resp. `WorkflowStart`) tool call over the real SSE stream.
//   2. The host actually SPAWNS a child brain session (subagent platform) that runs its OWN model turn —
//      the scripted model server receives a SECOND request carrying the host's distinct sub-agent system
//      prompt AND the exact delegated task marker (so we know the child ran, and ran the RIGHT task).
//   3. The child's scripted answer flows BACK to the parent as the Delegate tool's result — the parent's
//      post-tool follow-up request carries a `tool` message containing the child's unique answer marker.
//   4. The parent turn reaches idle with the child's answer incorporated, the delegation is persisted in
//      the transcript, and the child shows up as a `brain-ch-subagent-*` managed session.
//
// TEETH: if delegation were a stub (child never spawned) there would be no child model request bearing the
// sub-agent prompt + task marker, and no tool result carrying the child answer — every one of those asserts
// fails loudly. We additionally assert the child got the DELEGATED task, never the parent's own prompt.
//
// No bare sleeps on the turn: every wait is on a stream frame with a hard deadline. Full cleanup in finally.
// Run with: node scripts/tests/delegate-e2e/run.mjs

import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startScriptedModelServer, startSteeringModelServer } from './model-server.mjs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';

const TURN_DEADLINE_MS = 90_000;

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Await a promise under a hard deadline, so a scenario reports what it was waiting for instead of hanging. */
function withDeadline(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)), timeoutMs);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Open a real SSE stream and expose the parsed brain events plus a deadline-bounded `waitFor`. */
async function openStream(baseUrl, path, token) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream open failed: HTTP ${res.status}`);

  const events = [];
  const waiters = [];
  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(events)) { waiters[i].resolve(events); waiters.splice(i, 1); }
    }
  };
  // The daemon writes the `: connected` comment only AFTER it has installed the session tap
  // (api/routes/brainStream.ts). Response headers arrive earlier than that, so resolving on the fetch
  // alone would let a send race the subscription and lose the turn's events.
  let markConnected = () => {};
  const connected = new Promise((resolve) => { markConnected = resolve; });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let dataLine = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) dataLine += line.slice(5).trim();
            else if (line.trim() === ': connected') markConnected();
          }
          if (!dataLine) continue;
          try { events.push(JSON.parse(dataLine)); notify(); } catch { /* non-JSON frame */ }
        }
      }
    } catch { /* stream aborted on close */ }
  })();

  return {
    events,
    connected,
    waitFor(predicate, timeoutMs, label) {
      if (predicate(events)) return Promise.resolve(events);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for: ${label}\nevents so far: ${events.map((e) => e.type).join(', ')}`));
        }, timeoutMs);
        entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
        waiters.push(entry);
      });
    },
    close() { controller.abort(); },
  };
}

async function post(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json, text };
}

async function getJson(baseUrl, path, token) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return res.json();
}

/** Drive one parent turn to idle: fresh session, open stream before send, send, wait for idle. */
async function driveParentTurn(baseUrl, token, sendText, mode) {
  const start = await post(baseUrl, '/brain/start', token, { fresh: true });
  assert(start.status === 201, `POST /brain/start → 201 (got ${start.status}: ${start.text})`);
  const sessionId = start.json?.sessionId;
  assert(typeof sessionId === 'string' && sessionId, 'start returned a sessionId');

  const stream = await openStream(baseUrl, `/brain/stream?session=${encodeURIComponent(sessionId)}`, token);
  // The tap is provably attached, not assumed attached after a fixed pause a loaded runner can exceed.
  await withDeadline(stream.connected, 15_000, 'the session tap to attach (`: connected`)');

  const send = await post(baseUrl, '/brain/send', token, { text: sendText, session: sessionId, mode });
  assert(send.status === 202, `POST /brain/send → 202 accepted (got ${send.status}: ${send.text})`);
  await stream.waitFor((evs) => evs.some((e) => e.type === 'idle'), TURN_DEADLINE_MS, 'parent turn idle');
  return { sessionId, stream };
}

/** Concatenate every message's text content of a captured model request (for marker matching). */
function requestText(model, req) {
  const messages = Array.isArray(req?.body?.messages) ? req.body.messages : [];
  return messages.map((m) => model.contentText(m)).join('\n');
}

const clamp = (text, n) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** Everything the daemon wrote. It logs to ELOWEN_LOG_DIR, not to stdout, so its own stdout capture is
 *  NOT where the lines are — a scenario that reports only `logText()` reports almost nothing. */
function daemonLog(daemon) {
  try {
    return readdirSync(daemon.logDir).filter((name) => name.startsWith('daemon-')).sort()
      .map((name) => readFileSync(join(daemon.logDir, name), 'utf8')).join('\n');
  } catch { return ''; }
}

/**
 * Print, on the way out of a failing scenario, the three records that decide WHY it failed: what the
 * model was actually asked, what the parent's stream carried (including each tool's settled output — the
 * one place a Delegate that failed to spawn says so), and what the daemon logged.
 *
 * Without this a delegation assertion reports only that something did not happen, which is unfixable
 * from a CI log: the run is gone, its temp data dir is gone, and nothing said what the tool returned.
 */
function diagnose(label, { model, stream, daemon, markers = {} }) {
  const out = [`\n=== DIAGNOSTICS (${label}) ===`];

  out.push(`-- model requests (${model.requests.length}) --`);
  model.requests.forEach((req, i) => {
    const messages = Array.isArray(req?.body?.messages) ? req.body.messages : [];
    const hit = Object.entries(markers).filter(([, v]) => requestText(model, req).includes(v)).map(([k]) => k);
    const roles = messages.map((m) => m.role).join('>');
    const system = model.contentText(messages.find((m) => m.role === 'system') ?? {});
    out.push(`  [${i}] roles=${roles || '(none)'} markers=${hit.join(',') || '(none)'}`);
    out.push(`      system: ${clamp(system, 140)}`);
    out.push(`      last:   ${clamp(model.contentText(messages.at(-1) ?? {}), 220)}`);
  });

  if (stream) {
    out.push(`-- stream event types, in order (${stream.events.length}) --`);
    out.push(`  ${stream.events.map((e) => e.type).join(' > ') || '(none)'}`);
    out.push('-- stream events of interest --');
    for (const e of stream.events) {
      if (e.type === 'tool') out.push(`  tool        ${e.name}${e.reason ? ` reason=${e.reason}` : ''}`);
      else if (e.type === 'tool_output') out.push(`  tool_output ${clamp(JSON.stringify(e.output), 400)}`);
      else if (e.type === 'tool_end') out.push(`  tool_end    ${clamp(JSON.stringify(e), 200)}`);
      else if (e.type === 'error') out.push(`  error       ${e.message}`);
      else if (e.type === 'idle') out.push('  idle');
    }
  }

  if (daemon) {
    const lines = daemonLog(daemon).split('\n');
    const problems = lines.filter((line) => /\b(ERROR|WARN)\b/.test(line));
    out.push(`-- daemon log: ERROR/WARN lines (${problems.length}, last 20) --`);
    out.push(problems.slice(-20).join('\n'));
    // Unfiltered, because the previous filter was a guessed keyword whitelist and a failure it did not
    // anticipate left the tail empty — which is how a red job became undiagnosable.
    out.push('-- daemon log: last 40 lines --');
    out.push(lines.slice(-40).join('\n'));
  }

  out.push('=== END DIAGNOSTICS ===\n');
  console.error(out.join('\n'));
}

// ---------------------------------------------------------------------------------------------------
// Scenario 1 — Delegate: parent hands ONE self-contained task to a fresh sub-agent, gets its answer back.
// ---------------------------------------------------------------------------------------------------
async function scenarioDelegate() {
  const DELEGATE_TASK_MARKER = 'DELEGATE-TASK-7f3a91';       // unique text carried by the delegated task
  const CHILD_ANSWER_MARKER = 'CHILD-ANSWER-42d0c';           // unique text in the sub-agent's reply
  const SUBAGENT_PROMPT_SNIPPET = 'You are a focused sub-agent'; // host-injected distinct child system prompt
  const PARENT_SEND = 'Please delegate the widget-sizing task to a sub-agent.';

  const model = await startScriptedModelServer({
    toolName: 'Delegate',
    toolArgs: JSON.stringify({
      task: `Compute the widget size and report only the number. Task marker: ${DELEGATE_TASK_MARKER}.`,
      // This scenario reads the child's answer as the tool result of the Delegate call itself, so it asks
      // for the blocking mode rather than the asynchronous default.
      background: false,
    }),
    parentFirstText: 'Handing this to a sub-agent. ',
    parentFinalText: `The sub-agent reported back: ${CHILD_ANSWER_MARKER}. Done.`,
    children: [{ match: DELEGATE_TASK_MARKER, text: `Computed the widget size: 42. ${CHILD_ANSWER_MARKER}` }],
  });

  let daemon = null;
  let stream = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'e2e-dlg' });
    const { baseUrl, token } = daemon;
    console.log(`[delegate] daemon up on ${baseUrl}; model on ${model.baseUrl}`);

    const parent = await driveParentTurn(baseUrl, token, PARENT_SEND, 'build');
    const sessionId = parent.sessionId;
    stream = parent.stream;

    // --- The parent actually issued the Delegate tool call over the real stream ---
    const toolEvents = stream.events.filter((e) => e.type === 'tool');
    assert(toolEvents.some((e) => e.name === 'Delegate'),
      `a 'Delegate' tool event streamed on the parent; tools seen: ${toolEvents.map((e) => e.name).join(', ') || '(none)'}`);

    // --- The child REALLY ran: a distinct model request carries the sub-agent system prompt + the task ---
    const childReq = model.requests.find((r) => {
      const t = requestText(model, r);
      return t.includes(SUBAGENT_PROMPT_SNIPPET) && t.includes(DELEGATE_TASK_MARKER);
    });
    assert(childReq, 'the sub-agent ran: a model request carried the host sub-agent prompt AND the delegated task marker');
    // TEETH: the child got the DELEGATED task, not a generic/parent one.
    assert(!requestText(model, childReq).includes(PARENT_SEND),
      "the sub-agent got the delegated task, NOT the parent's own prompt");

    // --- The child's answer flowed BACK to the parent as the Delegate tool result ---
    const followUp = model.requests.find((r) => {
      const messages = Array.isArray(r?.body?.messages) ? r.body.messages : [];
      return messages.some((m) => m.role === 'tool' && model.contentText(m).includes(CHILD_ANSWER_MARKER));
    });
    assert(followUp, "the parent's post-tool request carried a tool result containing the child's answer marker");

    // --- The parent turn incorporated the child's answer into its streamed reply ---
    const streamedText = stream.events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    assert(streamedText.includes(CHILD_ANSWER_MARKER),
      `the parent's streamed reply incorporated the child's answer marker: got "${streamedText}"`);

    // --- The child session is persisted as a managed sub-agent session ---
    const managed = await getJson(baseUrl, '/brain/managed-sessions', token);
    assert(Array.isArray(managed), 'GET /brain/managed-sessions returned an array');
    const childSession = managed.find((s) => typeof s.id === 'string' && s.id.startsWith('brain-ch-subagent-'));
    assert(childSession, `a child sub-agent managed session persisted; ids: ${managed.map((s) => s.id).join(', ') || '(none)'}`);

    // --- The delegation persists in the parent transcript as a Delegate tool call ---
    const messages = await getJson(baseUrl, `/brain/messages?session=${encodeURIComponent(sessionId)}`, token);
    const delegateMsg = messages.find((m) => m.role === 'assistant' && Array.isArray(m.segments)
      && m.segments.some((s) => s.kind === 'tool' && s.name === 'Delegate'));
    assert(delegateMsg, 'persisted transcript reloads with the Delegate tool call');

    stream.close();
    console.log('PASS delegate: child spawned with the right task + sub-agent prompt, answer returned to the parent, session persisted.');
  } catch (error) {
    diagnose('delegate', {
      model, stream, daemon,
      markers: { task: DELEGATE_TASK_MARKER, childAnswer: CHILD_ANSWER_MARKER, subagentPrompt: SUBAGENT_PROMPT_SNIPPET, parentSend: PARENT_SEND },
    });
    throw error;
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// Scenario 2 — Workflow: parent runs a 2-node DAG (gather → write); nodes spawn like delegations and their
// results roll up into the WorkflowStart summary returned to the parent. Proves dependency ordering too.
// ---------------------------------------------------------------------------------------------------
async function scenarioWorkflow() {
  const NODE_A_MARKER = 'WF-NODE-A-11aa';
  const NODE_B_MARKER = 'WF-NODE-B-22bb';
  const NODE_A_ANSWER = 'GATHERED-A-answer';
  const NODE_B_ANSWER = 'WRITTEN-B-answer';
  const NODE_PROMPT_SNIPPET = 'one node of a workflow'; // host-injected distinct workflow-node system prompt
  const PARENT_SEND = 'Please run the gather-then-write workflow.';

  // WorkflowStart reads its nodes from a FILE, so the scripted parent writes one first — the same two steps
  // a real agent takes. The suite's daemon bootstraps an ADMIN, whose access carries no repo roots to be
  // confined to, so a temp path resolves; a project-scoped session would have to write inside its own repo.
  const nodesDir = mkdtempSync(join(tmpdir(), 'elowen-delegate-e2e-'));
  // The finally below only runs when the scenario reaches it; a crash or an unhandled rejection skips it and
  // strands the directory in /tmp. Same belt-and-braces the daemon data dir uses (brain-e2e/spawn-daemon.mjs).
  const cleanupNodesDir = () => {
    try { rmSync(nodesDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  };
  process.once('exit', cleanupNodesDir);
  const nodesFile = join(nodesDir, 'gather-write.json');
  writeFileSync(nodesFile, JSON.stringify({
    title: 'E2E gather-write',
    nodes: [
      { id: 'gather', task: `Gather the inputs and report them. Task marker: ${NODE_A_MARKER}.` },
      { id: 'write', task: `Write the summary from the gathered inputs. Task marker: ${NODE_B_MARKER}.`, deps: ['gather'] },
    ],
  }), 'utf-8');

  const model = await startScriptedModelServer({
    toolName: 'WorkflowStart',
    // Blocking, because the scenario reads every node's result out of this call's own tool result.
    toolArgs: JSON.stringify({ nodesFile, background: false }),
    parentFirstText: 'Running the workflow. ',
    parentFinalText: `Workflow done: ${NODE_A_ANSWER} then ${NODE_B_ANSWER}.`,
    children: [
      { match: NODE_A_MARKER, text: `Gathered the inputs. ${NODE_A_ANSWER}` },
      { match: NODE_B_MARKER, text: `Wrote the summary. ${NODE_B_ANSWER}` },
    ],
  });

  let daemon = null;
  let stream = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'e2e-wf' });
    const { baseUrl, token } = daemon;
    console.log(`[workflow] daemon up on ${baseUrl}; model on ${model.baseUrl}`);

    stream = (await driveParentTurn(baseUrl, token, PARENT_SEND, 'workflow')).stream;

    // --- The parent issued the WorkflowStart tool call ---
    const toolEvents = stream.events.filter((e) => e.type === 'tool');
    assert(toolEvents.some((e) => e.name === 'WorkflowStart'),
      `a 'WorkflowStart' tool event streamed; tools seen: ${toolEvents.map((e) => e.name).join(', ') || '(none)'}`);

    // --- BOTH nodes really ran as sub-agents with their distinct tasks ---
    const nodeAIdx = model.requests.findIndex((r) => {
      const t = requestText(model, r);
      return t.includes(NODE_PROMPT_SNIPPET) && t.includes(NODE_A_MARKER);
    });
    const nodeBIdx = model.requests.findIndex((r) => {
      const t = requestText(model, r);
      return t.includes(NODE_PROMPT_SNIPPET) && t.includes(NODE_B_MARKER);
    });
    assert(nodeAIdx !== -1, 'workflow node A ran with the node prompt + its task marker');
    assert(nodeBIdx !== -1, 'workflow node B ran with the node prompt + its task marker');
    // --- Dependency ordering: gather (A) ran before write (B) ---
    assert(nodeAIdx < nodeBIdx, `dependency ordering honored: node A (idx ${nodeAIdx}) ran before node B (idx ${nodeBIdx})`);

    // --- Both node results rolled up into the WorkflowStart summary returned to the parent ---
    const followUp = model.requests.find((r) => {
      const messages = Array.isArray(r?.body?.messages) ? r.body.messages : [];
      return messages.some((m) => m.role === 'tool'
        && model.contentText(m).includes(NODE_A_ANSWER) && model.contentText(m).includes(NODE_B_ANSWER));
    });
    assert(followUp, "the parent's post-tool request carried a workflow summary with BOTH node answers");

    // --- Both node sessions persisted as managed sub-agent sessions ---
    const managed = await getJson(baseUrl, '/brain/managed-sessions', token);
    const nodeSessions = managed.filter((s) => typeof s.id === 'string' && s.id.startsWith('brain-ch-subagent-'));
    assert(nodeSessions.length >= 2, `both workflow node sessions persisted (>=2); got ${nodeSessions.length}`);

    stream.close();
    console.log('PASS workflow: 2-node DAG ran in dependency order, both node results rolled up to the parent, sessions persisted.');
  } catch (error) {
    diagnose('workflow', {
      model, stream, daemon,
      markers: { nodeA: NODE_A_MARKER, nodeB: NODE_B_MARKER, nodeAAnswer: NODE_A_ANSWER, nodeBAnswer: NODE_B_ANSWER, nodePrompt: NODE_PROMPT_SNIPPET },
    });
    throw error;
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
    process.off('exit', cleanupNodesDir);
    cleanupNodesDir();
  }
}

// ---------------------------------------------------------------------------------------------------
// Scenario 3 — Steering batch: three messages sent while a turn streams must reach the model TOGETHER,
// in ONE round, not one round each. This can only be proven against a real PI session: the queue is PI's,
// and how it drains is the behaviour under test — a fake session would just confirm whatever it was told.
// ---------------------------------------------------------------------------------------------------
async function scenarioSteeringBatch() {
  const MARKERS = ['STEER-ONE-a41c9', 'STEER-TWO-b72d4', 'STEER-THREE-c08e6'];
  const model = await startSteeringModelServer();

  let daemon = null;
  let stream = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'e2e-steer' });
    const { baseUrl, token } = daemon;
    console.log(`[steering] daemon up on ${baseUrl}; model on ${model.baseUrl}`);

    const start = await post(baseUrl, '/brain/start', token, { fresh: true });
    assert(start.status === 201, `POST /brain/start → 201 (got ${start.status}: ${start.text})`);
    const sessionId = start.json?.sessionId;
    assert(typeof sessionId === 'string' && sessionId, 'start returned a sessionId');

    stream = await openStream(baseUrl, `/brain/stream?session=${encodeURIComponent(sessionId)}`, token);
    await withDeadline(stream.connected, 15_000, 'the session tap to attach (`: connected`)');

    const first = await post(baseUrl, '/brain/send', token, { text: 'Start on the report.', session: sessionId, mode: 'build' });
    assert(first.status === 202, `first send → 202 accepted (got ${first.status}: ${first.text})`);
    // The turn is provably in flight only once the provider request lands — before that a send would take
    // the conversation lock and run its own turn instead of being steered, and the test would prove nothing.
    await withDeadline(model.firstTurnArrived, TURN_DEADLINE_MS, 'the first turn reached the model');

    for (const marker of MARKERS) {
      const queued = await post(baseUrl, '/brain/send', token, { text: `Also handle this. ${marker}`, session: sessionId, mode: 'build' });
      assert(queued.status === 202, `mid-turn send ${marker} → 202 accepted (got ${queued.status}: ${queued.text})`);
    }

    model.releaseFirstTurn();
    await stream.waitFor((evs) => evs.some((e) => e.type === 'idle'), TURN_DEADLINE_MS, 'the steered turn reached idle');

    const carrying = model.requests.filter((r) => requestText(model, r).includes(MARKERS[0]));
    // TEETH: draining one message per round would put the first steered message in three successive
    // contexts (it stays in history) and would show the model only that one in the round it arrived.
    assert(carrying.length === 1,
      `the steered batch cost exactly ONE model round; the first steered message appears in ${carrying.length} request(s)`);
    const batch = requestText(model, carrying[0]);
    for (const marker of MARKERS) {
      assert(batch.includes(marker), `the single steered round carried ${marker} (all three arrive together)`);
    }

    stream.close();
    console.log('PASS steering: three mid-turn messages reached the model together, in one round.');
  } catch (error) {
    diagnose('steering', { model, stream, daemon, markers: { one: MARKERS[0], two: MARKERS[1], three: MARKERS[2] } });
    throw error;
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

async function main() {
  await scenarioDelegate();
  await scenarioWorkflow();
  await scenarioSteeringBatch();
}

main().then(() => {
  console.log('PASS delegate-e2e — real daemon sub-agent + workflow delegation verified.');
  process.exit(0);
}).catch((err) => {
  console.error(`FAIL delegate-e2e — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
