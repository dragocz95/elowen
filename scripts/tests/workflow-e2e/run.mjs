#!/usr/bin/env node
// Workflow (DAG) engine E2E — does a declared graph of sub-agents really run as a graph against a REAL
// daemon, and can a stopped run be picked back up where it failed?
//
// The engine has thorough unit tests (tests/plugins/workflowEngine.test.ts) driven by a FAKE host: they
// prove the scheduling arithmetic. Nothing there proves the wiring — that the daemon actually spawns a
// child brain session per node, that dependency results survive the trip through the real context
// assembly, that the DAG reaches SQLite, or that WorkflowResume and DelegateStop work through the real
// tool-call path. That is what this suite is for, and every claim below is made against a real daemon
// process with a scripted model server standing in for the provider.
//
// What it proves, in order:
//   A. ORDERING AND PARALLELISM on a diamond (a → b,c → d). Ordering is read off the model server's
//      per-node execution spans, and so is parallelism: b and c hold their responses open long enough that
//      an engine running them one after another could not produce intersecting intervals. A tool result
//      could never show this — only wall-clock spans can.
//   B. DEPENDENCY RESULTS TRAVEL DOWNSTREAM. Asserted twice: on the WIRE (node d's model request carries
//      b's and c's result markers) and BEHAVIOURALLY (d inspects its own context and answers with a
//      different marker when they are missing, so a broken hand-off reaches the parent as a failure
//      instead of as an invented answer).
//   C. FAILURE PROPAGATION. A failed node leaves its dependent unrun, and the summary NAMES both.
//   D. WorkflowResume RE-RUNS ONLY THE UNFINISHED NODES — the load-bearing case. The model server counts
//      executions per node, so "seed was not re-run" is a hard count of one, ever, not an inference from a
//      status string. The daemon is deliberately NOT restarted anywhere in this suite: the engine holds its
//      workflows in memory, so a restart would make resume legitimately impossible.
//   E. RESUME REFUSALS reach the agent as readable tool results, not as thrown errors.
//   F. DelegateStop ends a running child. The child hangs at the model server until released, so anything
//      that ends its request is the stop taking effect at the transport — proof it did not simply finish.
//   G. PERSISTENCE. The DAG snapshot and a background run's terminal summary are asserted directly against
//      SQLite, opened readonly.
//
// Run with: npm run test:e2e:workflow

import { join } from 'node:path';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import {
  startScriptedModel, contentText, nodeTask, nodeResult, MARKERS, SUBAGENT_PROMPT,
  WORKFLOW_RESULT_TAG, UNKNOWN_WORKFLOW_ID, PARALLEL_HOLD_MS, DIAMOND_NODES, RETRY_NODES, BG_NODE,
} from './model.mjs';

const TURN_DEADLINE_MS = 120_000;
// A background workflow's summary is persisted and then woken into a NEW turn the daemon starts on its
// own; the stopped delegation's result takes the same path. Neither is part of the turn that triggered it,
// so both are awaited separately under their own bound.
const DELIVERY_DEADLINE_MS = 60_000;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Subscribe to a session's SSE stream. Counts `idle` events so a send can be awaited to settlement (POST
 *  /brain/send returns as soon as the turn is ADMITTED, so without this every assertion races the work it
 *  is meant to observe), and keeps every `workflow` snapshot — the live DAG feed the CLI/web panel renders,
 *  and the only place a client learns a workflow's id. */
async function openStream(baseUrl, token, session) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/brain/stream?session=${encodeURIComponent(session)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream open failed: HTTP ${res.status}`);
  const state = { idles: 0, errors: [], workflows: [] };
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
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'idle') state.idles += 1;
            if (evt.type === 'error') state.errors.push(String(evt.message ?? 'unknown'));
            if (evt.type === 'workflow') state.workflows.push(evt);
          } catch { /* non-JSON frame */ }
        }
      }
    } catch { /* aborted on close */ }
  })();
  return { state, close: () => controller.abort() };
}

/** Every message of one captured model request, flattened — for marker matching. */
const requestText = (req) => (Array.isArray(req?.body?.messages) ? req.body.messages : [])
  .map(contentText).join('\n');
/** The same request WITHOUT its system prompt — what a failure detail should show (what the node was
 *  actually asked), rather than a few hundred characters of role prompt. */
const conversationText = (req) => (Array.isArray(req?.body?.messages) ? req.body.messages : [])
  .filter((m) => m?.role !== 'system').map((m) => `${m?.role}: ${contentText(m)}`).join('\n');
/** The tool result THIS request is answering, or '' when it is not a post-tool follow-up. */
const toolResultText = (req) => {
  const last = Array.isArray(req?.body?.messages) ? req.body.messages.at(-1) : undefined;
  return last?.role === 'tool' ? contentText(last) : '';
};
const excerpt = (text, limit = 400) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
/** The tool results a turn produced, newest last — a turn may chain several calls. */
const turnToolResults = (reqs) => reqs.map(toolResultText).filter(Boolean);

async function main() {
  const model = await startScriptedModel();
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'e2e-workflow' });
    const { baseUrl, dataDir, token } = daemon;

    const api = async (path, body) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    };

    const start = await api('/brain/start', { fresh: true });
    const session = start?.sessionId;
    if (!session) throw new Error('no session id from /brain/start');
    const stream = await openStream(baseUrl, token, session);
    await sleep(200);

    /** The parent conversation as stored, flattened. A parent's own REPLY never reappears in a model
     *  request of the same turn, so anything the scripted parent says is asserted here rather than on the
     *  wire — and reading it back also proves the turn was persisted, not merely streamed. */
    const transcript = async () => {
      const res = await fetch(`${baseUrl}/brain/messages?session=${encodeURIComponent(session)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`GET /brain/messages failed: HTTP ${res.status}`);
      return JSON.stringify(await res.json());
    };

    /** Wait for a condition on the live stream / transcript / model server under a hard deadline. Every wait
     *  in this suite goes through here: a bare sleep would turn a genuine engine stall into a passing run. */
    const waitFor = async (label, predicate, deadlineMs = TURN_DEADLINE_MS) => {
      const until = Date.now() + deadlineMs;
      while (!await predicate()) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${label} (stream errors: ${stream.state.errors.join('; ') || 'none'})`);
        await sleep(50);
      }
    };

    /** Send one turn, wait for it to settle, and return the slice of model requests that turn produced
     *  (parent AND node/child requests alike — a workflow drives all of them). */
    const turn = async (text, mode) => {
      model.setMode(mode);
      const before = stream.state.idles;
      const from = model.requests.length;
      await api('/brain/send', { text, session, mode: 'build' });
      await waitFor(`turn "${text}" to settle`, () => stream.state.idles > before);
      return model.requests.slice(from);
    };

    /** The newest live snapshot of the workflow whose node set is exactly `ids`.
     *
     *  THIS is how the suite learns a workflow id, and the choice is deliberate. A foreground WorkflowStart
     *  returns only the summary — no id — so nothing in the tool result could carry it. The id does travel,
     *  once per state change, on the `workflow` events of the parent's own SSE stream: exactly the feed the
     *  CLI and web panels render, so it is what an operator actually sees and can act on. The runner reads
     *  it there and hands it to the agent in the next user message, which is precisely the real-world shape
     *  of "resume the run that failed". (The same id is cross-checked against brain_workflows below, so a
     *  snapshot that lied about it would still be caught.) */
    const workflowSnapshot = (ids) => stream.state.workflows
      .filter((w) => w.nodes.length === ids.length && ids.every((id) => w.nodes.some((n) => n.id === id)))
      .at(-1);

    /** Wall-clock spans the model server recorded for a node's executions. */
    const spans = (id) => model.nodeRuns.get(id) ?? [];
    const runCount = (id) => spans(id).length;
    const spanReport = (ids) => ids.map((id) => `${id}: ${spans(id).map((s) => `[${s.startedAt}, ${s.endedAt}]`).join(' ') || '(never ran)'}`).join('; ');

    console.log('\n— A/B: a diamond DAG runs in dependency order, fans out in parallel, and feeds the fan-in —');
    const diamond = await turn('Run the diamond workflow.', 'diamond');
    const diamondSummary = turnToolResults(diamond).at(-1) ?? '';

    for (const id of DIAMOND_NODES) {
      check(`node ${id} ran exactly once as its own sub-agent session`,
        runCount(id) === 1 && diamond.some((r) => requestText(r).includes(SUBAGENT_PROMPT) && requestText(r).includes(nodeTask(id))),
        `executions: ${runCount(id)}`);
    }
    // Ordering: a's whole execution precedes both branches, and the fan-in starts only once both are done.
    // Read off the spans rather than off statuses, because a status can be written optimistically.
    const [a] = spans('a');
    const [b] = spans('b');
    const [c] = spans('c');
    const [d] = spans('d');
    const haveAll = !!(a && b && c && d);
    check('the root finished before either branch started',
      haveAll && a.endedAt <= b.startedAt && a.endedAt <= c.startedAt, spanReport(DIAMOND_NODES));
    // The only honest proof of parallelism: the two intervals genuinely intersect. Each branch holds its
    // response for PARALLEL_HOLD_MS, so a serialized engine would produce disjoint intervals here.
    check(`the two branches genuinely overlapped in time (each held ${PARALLEL_HOLD_MS}ms)`,
      haveAll && b.startedAt < c.endedAt && c.startedAt < b.endedAt, spanReport(['b', 'c']));
    check('the fan-in started only after BOTH branches had finished',
      haveAll && d.startedAt >= b.endedAt && d.startedAt >= c.endedAt, spanReport(DIAMOND_NODES));

    // B, on the wire: the request that drove node d carried its dependencies' results.
    const fanIn = diamond.find((r) => requestText(r).includes(SUBAGENT_PROMPT) && requestText(r).includes(nodeTask('d')));
    check('the fan-in node was handed BOTH dependency results, not asked blind',
      !!fanIn && requestText(fanIn).includes(nodeResult('b')) && requestText(fanIn).includes(nodeResult('c')),
      fanIn ? excerpt(conversationText(fanIn), 600) : 'node d never ran');
    // B, behaviourally: the node itself said so, and that answer reached the parent through the summary.
    check('…and the node itself reported working from them, in the summary the parent received',
      diamondSummary.includes(MARKERS.depsSeen) && !diamondSummary.includes(MARKERS.depsMissing),
      excerpt(diamondSummary, 600));
    check('the summary reports the whole DAG as done',
      /finished with status: done/.test(diamondSummary)
        && DIAMOND_NODES.every((id) => diamondSummary.includes(`[${id}] DONE`)),
      excerpt(diamondSummary, 600));
    check('the parent turn completed on that summary',
      diamond.some((r) => requestText(r).includes(MARKERS.diamondDone))
        || turnToolResults(diamond).length > 0);

    const diamondId = workflowSnapshot(DIAMOND_NODES)?.id ?? '';
    check('the live snapshot stream carried the workflow id and a terminal status',
      /^wf-[0-9a-f-]{36}$/.test(diamondId) && workflowSnapshot(DIAMOND_NODES)?.status === 'done',
      `id: ${diamondId || '(none)'} status: ${workflowSnapshot(DIAMOND_NODES)?.status ?? '(none)'}`);

    console.log('\n— C: a failed node leaves its dependent unrun, and the summary names both —');
    const failing = await turn('Run the probe workflow.', 'failing');
    const failedSummary = turnToolResults(failing).at(-1) ?? '';
    check('the node that failed ran, and its failure is reported as an error',
      runCount('probe') === 1 && failedSummary.includes('[probe] ERROR') && failedSummary.includes(MARKERS.probeFailure),
      excerpt(failedSummary, 600));
    check('its dependent was NOT run — not silently reported as succeeded',
      runCount('report') === 0 && failedSummary.includes('(did not run — a dependency failed)')
        && !failedSummary.includes('[report] DONE'),
      `report executions: ${runCount('report')}\n       ${excerpt(failedSummary, 500)}`);
    check('the workflow itself ended in error, with the healthy node still done',
      /finished with status: error/.test(failedSummary) && failedSummary.includes('[seed] DONE'),
      excerpt(failedSummary, 600));

    const retryId = workflowSnapshot(RETRY_NODES)?.id ?? '';
    if (!/^wf-[0-9a-f-]{36}$/.test(retryId)) throw new Error('no workflow id on the snapshot stream — the resume assertions below would be meaningless');
    check('the failed workflow is identifiable from the live snapshot the operator sees', retryId !== diamondId);

    console.log('\n— D: WorkflowResume re-runs ONLY what did not finish —');
    // No daemon restart anywhere in this suite: the engine holds workflows in memory by design, so resume
    // is only meaningful inside the SAME process. A restart here would be testing the wrong thing.
    const resumed = await turn(`The workflow ${retryId} failed. Resume it.`, 'resume');
    const resumedSummary = turnToolResults(resumed).at(-1) ?? '';
    // The load-bearing counts. A resume that restarted the DAG would push `seed` to two executions; one that
    // never re-ran anything would leave `probe` at one and `report` at zero.
    check('the node that had already finished was NOT re-run (exactly one execution, ever)',
      runCount('seed') === 1, `seed executions: ${runCount('seed')}`);
    check('the node that failed ran a SECOND time', runCount('probe') === 2, `probe executions: ${runCount('probe')}`);
    check('the previously-skipped dependent ran for the FIRST time', runCount('report') === 1, `report executions: ${runCount('report')}`);
    check('the retried node was given the dependency result from the ORIGINAL run',
      resumed.some((r) => requestText(r).includes(SUBAGENT_PROMPT) && requestText(r).includes(nodeTask('probe'))
        && requestText(r).includes(nodeResult('seed'))),
      spanReport(RETRY_NODES));
    check('the resumed run reports success for every node',
      /finished with status: done/.test(resumedSummary)
        && RETRY_NODES.every((id) => resumedSummary.includes(`[${id}] DONE`)),
      excerpt(resumedSummary, 600));
    check('…and the dependent confirms it was shown the retried node\'s result',
      resumedSummary.includes(MARKERS.depsSeen) && !resumedSummary.includes(MARKERS.depsMissing),
      excerpt(resumedSummary, 600));
    const afterResume = await transcript();
    check('the parent turn closed on the resumed summary, having found the id it was given',
      afterResume.includes(MARKERS.resumeDone) && !afterResume.includes(MARKERS.noWorkflowId));

    console.log('\n— E: a resume that cannot be honoured is refused readably —');
    const refused = await turn(`Try resuming ${UNKNOWN_WORKFLOW_ID} and then ${diamondId}.`, 'refusals');
    const refusals = turnToolResults(refused);
    check('resuming an unknown workflow id is refused, as a tool result rather than a throw',
      refusals[0]?.includes(`no workflow ${UNKNOWN_WORKFLOW_ID} you can resume`), excerpt(refusals[0] ?? '(no tool result)'));
    check('resuming a fully-succeeded workflow is refused with a clear reason',
      refusals[1]?.includes(`every node in workflow ${diamondId} already finished`), excerpt(refusals[1] ?? '(no second tool result)'));
    check('neither refusal re-ran a single node',
      DIAMOND_NODES.every((id) => runCount(id) === 1), spanReport(DIAMOND_NODES));
    check('the parent turn survived both refusals and kept going',
      (await transcript()).includes(MARKERS.refusalsDone));

    console.log('\n— G: the DAG and a background run\'s summary are persisted —');
    // A background workflow is the only path that reaches the durable result inbox: a foreground run hands
    // its summary straight back as the tool result, so there is nothing to persist for delivery.
    const backgroundTurn = await turn('Run the standalone check in the background.', 'background');
    check('the background start returned a handle instead of blocking',
      turnToolResults(backgroundTurn).some((t) => t.includes('Started background workflow wf-')),
      excerpt(turnToolResults(backgroundTurn).join(' | ')));
    // The summary is woken into a NEW turn the daemon starts by itself, so it is awaited separately — on the
    // parent's own acknowledgement landing in the transcript, which only happens once that turn has run to
    // completion.
    await waitFor('the background workflow summary to be delivered and acknowledged in a new turn',
      async () => (await transcript()).includes(MARKERS.bgDelivered), DELIVERY_DEADLINE_MS);
    const delivery = model.requests.find((r) => requestText(r).includes(WORKFLOW_RESULT_TAG));
    check('the delivered turn carried the whole-DAG summary, not just a handle',
      !!delivery && requestText(delivery).includes(nodeResult(BG_NODE)),
      delivery ? excerpt(conversationText(delivery), 600) : '');

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(dataDir, 'elowen.db'), { readonly: true });
    const rows = db.prepare(
      'SELECT tool_call_id, workflow_id, state FROM brain_workflows WHERE parent_session_id = ? ORDER BY rowid ASC'
    ).all(session);
    check('every workflow this conversation ran was persisted as its own DAG row',
      rows.length === 3, `rows: ${rows.map((r) => r.workflow_id).join(', ') || '(none)'}`);
    const persisted = new Map(rows.map((r) => {
      let state = null;
      try { state = JSON.parse(r.state); } catch { /* asserted as missing below */ }
      return [r.workflow_id, state];
    }));
    check('…including the diamond and the resumed workflow, under the ids the live stream reported',
      persisted.has(diamondId) && persisted.has(retryId),
      `persisted: ${[...persisted.keys()].join(', ')}`);
    const retryState = persisted.get(retryId);
    check('the persisted DAG snapshot carries each node with its status and dependencies',
      !!retryState && RETRY_NODES.every((id) => {
        const node = retryState.nodes?.find((n) => n.id === id);
        return node?.status === 'done' && Array.isArray(node.deps);
      }),
      JSON.stringify(retryState?.nodes?.map((n) => [n.id, n.status, n.deps]) ?? null));
    check('…and the persisted status matches the resumed run\'s outcome', retryState?.status === 'done',
      `status: ${retryState?.status}`);
    const workflowResults = db.prepare(
      `SELECT kind, workflow_id, child_session_id, status, payload FROM brain_subagent_results
        WHERE parent_session_id = ? AND kind = 'workflow'`
    ).all(session);
    check('the background workflow\'s terminal summary was persisted into the delegated-result inbox',
      workflowResults.length === 1 && workflowResults[0].status === 'done'
        && workflowResults[0].child_session_id === '',
      `rows: ${JSON.stringify(workflowResults.map((r) => [r.kind, r.workflow_id, r.status]))}`);
    check('…keyed to a workflow this conversation actually ran, with the summary body',
      !!workflowResults[0] && persisted.has(workflowResults[0].workflow_id)
        && String(workflowResults[0].payload).includes(nodeResult(BG_NODE)),
      excerpt(String(workflowResults[0]?.payload ?? '(no row)')));

    console.log('\n— F: DelegateStop ends a running child that would otherwise never finish —');
    // Driving this needs a BACKGROUND delegation, and that is not a workaround: a foreground Delegate blocks
    // the parent's turn inside the tool call, so the parent could not issue a second tool call to stop it.
    // Background is the shape the tool documents anyway ("A background sub-agent keeps running … this is the
    // only way to end one early other than waiting it out"), so this is the real user path, not a stand-in.
    const stopped = await turn('Delegate the stuck job in the background, then stop it.', 'stop');
    const stopResults = turnToolResults(stopped);
    // EXACTLY one: `>= 1` would accept a retried/duplicated request where one attempt aborts while another
    // hangs on, so the branch would not actually be torn down and teardown would clean up the survivor.
    check('the child really started and hung, on exactly one model request',
      model.hangs.requests === 1, JSON.stringify(model.hangs));
    check('DelegateStop reported stopping it — not "nothing to stop"',
      stopResults.some((t) => t.startsWith('Stopped.')),
      excerpt(stopResults.join(' | '), 600));
    // The decisive one. The child never answers on its own, so its request can only end by being torn down.
    // If DelegateStop were a no-op the request would still be hanging here and this count would be zero.
    await waitFor('the held child model request to actually abort',
      () => model.hangs.aborted > 0, 15_000);
    check('…and the stop actually reached the child: its in-flight model request was aborted',
      model.hangs.requests === 1 && model.hangs.aborted === 1 && model.hangs.released === 0, JSON.stringify(model.hangs));
    // Counting an abort is not the same as proving the STOP caused it: a provider timeout, a transport
    // reset or the daemon teardown all close that socket too. Pin it down in time — the abort must land
    // AFTER the stop was issued and promptly, well inside any timeout that could have produced it anyway.
    // A no-op DelegateStop plus an independent timeout would pass the count but fail this.
    const stopToAbortMs = (model.hangs.abortedAt ?? 0) - (model.hangs.stopIssuedAt ?? 0);
    check('…and it was the stop that ended it: the abort landed just after DelegateStop was issued',
      Number.isFinite(stopToAbortMs) && !!model.hangs.stopIssuedAt && !!model.hangs.abortedAt
        && stopToAbortMs >= 0 && stopToAbortMs < 15_000,
      `stop→abort ${stopToAbortMs}ms ${JSON.stringify(model.hangs)}`);
    check('the delegation ends up in a terminal ERROR state rather than still running',
      stopResults.some((t) => /Delegation job dlg-[0-9a-f-]+: ERROR/.test(t)),
      excerpt(stopResults.at(-1) ?? '(no tool result)', 400));
    const afterStop = await transcript();
    check('the parent completed the whole find-then-stop chain',
      afterStop.includes(MARKERS.stopDone) && !afterStop.includes(MARKERS.stopNoSession));
    // The stopped child's terminal result takes the same durable-inbox path as any background delegation, so
    // the parent is woken with it. Awaited (not asserted blind) so teardown cannot race a live turn.
    await waitFor('the stopped delegation\'s result to be delivered and acknowledged in a new turn',
      async () => (await transcript()).includes(MARKERS.stopDelivered), DELIVERY_DEADLINE_MS);
    check('the stopped delegation was reported back to the parent as failed, not as done',
      model.requests.some((r) => /<subagent-result[^>]*status="error"/.test(requestText(r))
        && requestText(r).includes(MARKERS.hangTask)));

    check('no node ever ran without its dependency results (no node reported them missing)',
      !model.requests.some((r) => requestText(r).includes(MARKERS.depsMissing)));
    check('the stream reported no turn errors', stream.state.errors.length === 0, stream.state.errors.join('; '));

    db.close();
    stream.close();
  } finally {
    model.releaseHangs();
    if (daemon) await daemon.stop();
    await model.close();
  }

  console.log(failures === 0
    ? '\nPASS — the DAG runs as a graph, resumes only what failed, persists, and a child can be stopped\n'
    : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`SUITE ERROR — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
