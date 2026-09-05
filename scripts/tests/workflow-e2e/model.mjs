// Scripted OpenAI-compatible model for the workflow (DAG) engine E2E suite.
//
// One server serves every turn the suite provokes, and how each one is chosen matters:
//   1. PARENT turns are driven by the mode the RUNNER sets before every send (diamond / failing / resume /
//      refusals / background / stop). Nothing is inferred from the payload, so the suite can never fail
//      because a heuristic misread a request — the same reason subagent-e2e/model.mjs works this way.
//   2. NODE and CHILD turns are recognised by CONTENT: the host's sub-agent role prompt plus the marker
//      carried in the task the engine handed them. It has to be content-based, because a node turn arrives
//      interleaved with the parent turn that spawned it and carries no mode of its own.
//   3. Housekeeping completions (conversation titling) carry no tools and are answered as plain text, so a
//      background inference can never be mistaken for an agent turn.
//
// The server is also the suite's INSTRUMENT, not just its fixture. It records, per node task marker, every
// execution as a `{ startedAt, endedAt }` span. Those spans are the only honest evidence for two claims the
// runner makes and no tool result could support:
//   * PARALLELISM — two node intervals genuinely intersect in wall-clock time (each parallel node holds its
//     response open for PARALLEL_HOLD_MS so the overlap is unambiguous rather than a scheduling accident);
//   * RESUME SELECTIVITY — a node the engine must NOT re-run has exactly one span, ever, across both runs.
// If the engine ever serialized a fan-out, or re-ran a finished node on resume, those spans change and the
// runner fails loudly.

import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** WorkflowStart reads its node definitions from a FILE, so the scripted parent writes one before calling
 *  the tool — the same two steps a real agent takes. The suite's daemon bootstraps an ADMIN, whose access
 *  carries no repo roots to be confined to, so a temp path resolves; a project-scoped session would have to
 *  write inside its own repository (see assertPathAllowed). */
const nodesDir = mkdtempSync(join(tmpdir(), 'elowen-wf-e2e-'));
// close() only runs when the suite reaches its own teardown; a crash or an unhandled rejection skips it and
// strands the directory in /tmp. Same belt-and-braces the daemon data dir uses (brain-e2e/spawn-daemon.mjs).
const cleanupNodesDir = () => {
  try { rmSync(nodesDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
};
process.once('exit', cleanupNodesDir);
let nodesFileSeq = 0;
const nodesFile = (nodes) => {
  const path = join(nodesDir, `nodes-${nodesFileSeq += 1}.json`);
  writeFileSync(path, JSON.stringify(nodes), 'utf-8');
  return path;
};

/** The host-injected role prompt every delegated child carries — a workflow node's prompt opens with the
 *  same words ('You are a focused sub-agent running one node of a workflow'), so this one substring tells
 *  BOTH kinds of child request apart from a parent one (see plugins/subagent/lib/workflow.mjs). */
export const SUBAGENT_PROMPT = 'You are a focused sub-agent';
/** The block a delivered BACKGROUND workflow summary rides into the parent's next turn on (turnRunner). */
export const WORKFLOW_RESULT_TAG = '<workflow-result';
/** A syntactically valid id no workflow will ever have — the refusal case must be rejected on ownership,
 *  not on a malformed argument. */
export const UNKNOWN_WORKFLOW_ID = 'wf-00000000-0000-4000-8000-000000000000';
/** How long the two parallel nodes hold their response open. Long enough that an engine which ran them one
 *  after another could not possibly produce intersecting intervals, short enough not to pad the suite. */
export const PARALLEL_HOLD_MS = 900;

/** The marker carried in a node's TASK — how the server recognises which node is asking, and how the runner
 *  counts that node's executions. Deliberately distinct from the RESULT marker: a dependent node is handed
 *  its dependencies' results, so one shared string would make "d ran" and "d saw b's output" indistinguishable. */
export const nodeTask = (id) => `WF-TASK-${id}-6b1d`;
/** The marker a node puts in its ANSWER — what the runner looks for in a dependent's request (proof the
 *  engine handed dependency results downstream) and in the workflow summary. */
export const nodeResult = (id) => `WF-RESULT-${id}-8e57`;

/** Unique strings the runner asserts on. Kept in one place so run.mjs and the script cannot drift. */
export const MARKERS = {
  // Behavioural counterpart to the wire assertion on dependency hand-off: node `d` inspects its OWN context
  // and says which of the two it found, so a broken hand-off reaches the parent as a visible failure rather
  // than as a node that quietly invented its answer.
  depsSeen: 'DEPS-CARRIED-3a9f',
  depsMissing: 'DEPS-MISSING-5c2b',
  probeFailure: 'PROBE-FAILED-ON-FIRST-ATTEMPT-7f60',
  diamondDone: 'PARENT-DIAMOND-DONE-1d4a',
  failingDone: 'PARENT-FAILING-DONE-2e5b',
  resumeDone: 'PARENT-RESUME-DONE-3f6c',
  refusalsDone: 'PARENT-REFUSALS-DONE-4a7d',
  bgStarted: 'PARENT-BG-STARTED-5b8e',
  bgDelivered: 'PARENT-BG-DELIVERED-6c9f',
  stopDone: 'PARENT-STOP-DONE-7da0',
  stopNoSession: 'PARENT-STOP-NO-SESSION-8eb1',
  stopDelivered: 'PARENT-STOP-DELIVERED-9fc2',
  noWorkflowId: 'PARENT-NO-WORKFLOW-ID-0ad3',
  /** The task of the child that never answers on its own — DelegateStop is the only thing that can end it. */
  hangTask: 'HANGING-CHILD-TASK-1be4',
};

/** The diamond: `a` fans out to `b` and `c`, which fan back in to `d`. The shape that makes ordering,
 *  parallelism and dependency hand-off all observable in ONE run. */
export const DIAMOND_NODES = ['a', 'b', 'c', 'd'];
/** The retry chain: `seed` succeeds, `probe` fails its FIRST execution, `report` is left unrunnable. Exactly
 *  the state WorkflowResume exists for. */
export const RETRY_NODES = ['seed', 'probe', 'report'];
/** The single node of the background workflow, whose completion is what lands in the durable result inbox. */
export const BG_NODE = 'solo';

/** What each node does when its turn arrives. `holdMs` buys the observable overlap; `deps` makes the node
 *  report whether it was actually shown those results; `failFirstAttempt` is the resume fixture. */
const NODE_SCRIPT = {
  a: {},
  b: { holdMs: PARALLEL_HOLD_MS },
  c: { holdMs: PARALLEL_HOLD_MS },
  d: { deps: ['b', 'c'] },
  seed: {},
  probe: { failFirstAttempt: true },
  report: { deps: ['probe'] },
  solo: {},
};

/** Flatten an OpenAI message `content` (string | parts array | null) into plain text for matching. */
export function contentText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ');
  return '';
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The text of the newest user message — the channel the RUNNER uses to hand the parent a workflow id it
 *  read off the live snapshot stream, exactly as an operator would take one from the UI panel. */
const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') return contentText(messages[i]);
  return '';
};
const workflowIdIn = (text) => (/wf-[0-9a-f-]{36}/.exec(text) ?? [''])[0];
const PARENT_MODES = {
  // A: ordering + parallelism, B: dependency hand-off. One blocking WorkflowStart; the summary comes back as
  // the tool result the runner reads.
  diamond: ({ say, callTool, awaitingTool }) => (awaitingTool
    ? say(`The diamond workflow finished. ${MARKERS.diamondDone}`)
    : callTool('WorkflowStart', {
      title: 'Diamond order',
      nodesFile: nodesFile([
        { id: 'a', task: `Produce the seed value. Task marker: ${nodeTask('a')}.` },
        { id: 'b', task: `Analyse the left branch. Task marker: ${nodeTask('b')}.`, deps: ['a'] },
        { id: 'c', task: `Analyse the right branch. Task marker: ${nodeTask('c')}.`, deps: ['a'] },
        { id: 'd', task: `Combine both branches. Task marker: ${nodeTask('d')}.`, deps: ['b', 'c'] },
      ]),
    })),
  // C: a failing node must leave its dependent unrun, and the summary must name it.
  failing: ({ say, callTool, awaitingTool }) => (awaitingTool
    ? say(`The probe workflow stopped. ${MARKERS.failingDone}`)
    : callTool('WorkflowStart', {
      title: 'Probe retry',
      nodesFile: nodesFile([
        { id: 'seed', task: `Collect the fixture. Task marker: ${nodeTask('seed')}.` },
        { id: 'probe', task: `Probe the fixture. Task marker: ${nodeTask('probe')}.`, deps: ['seed'] },
        { id: 'report', task: `Write up the probe. Task marker: ${nodeTask('report')}.`, deps: ['probe'] },
      ]),
    })),
  // D: resume the workflow the user just named. The id arrives in the user message because that is where a
  // real operator gets it from — the live workflow panel the runner is subscribed to (see run.mjs).
  resume: ({ say, callTool, awaitingTool, messages }) => {
    if (awaitingTool) return say(`The workflow was resumed. ${MARKERS.resumeDone}`);
    const id = workflowIdIn(lastUserText(messages));
    return id ? callTool('WorkflowResume', { workflowId: id }) : say(MARKERS.noWorkflowId);
  },
  // E: both refusal paths, in one turn, so each is seen as a readable tool RESULT rather than a throw.
  refusals: ({ say, callTool, awaitingTool, lastTool, messages }) => {
    if (!awaitingTool) return callTool('WorkflowResume', { workflowId: UNKNOWN_WORKFLOW_ID });
    // Keyed on WHICH refusal came back rather than on a step counter: the unknown-id refusal quotes the id
    // it could not find, so that result is the unambiguous cue to try the second, legitimate-but-already-
    // complete workflow. The unknown id is stripped from the user text first, because it appears there too
    // and would otherwise be the id matched again.
    if (lastTool.includes(UNKNOWN_WORKFLOW_ID)) {
      const id = workflowIdIn(lastUserText(messages).replace(UNKNOWN_WORKFLOW_ID, ''));
      return id ? callTool('WorkflowResume', { workflowId: id }) : say(MARKERS.noWorkflowId);
    }
    return say(`Both resume attempts were refused. ${MARKERS.refusalsDone}`);
  },
  // G: a BACKGROUND workflow, whose terminal summary is persisted into the durable result inbox and woken
  // into a fresh turn. The first branch IS that delivery turn — recognised by the block it rides in, not by a
  // mode, because the daemon starts it on its own.
  background: ({ say, callTool, awaitingTool, allText }) => {
    if (allText.includes(WORKFLOW_RESULT_TAG)) return say(`Noted the delivered summary. ${MARKERS.bgDelivered}`);
    return awaitingTool
      ? say(`The workflow is running in the background. ${MARKERS.bgStarted}`)
      : callTool('WorkflowStart', {
        title: 'Background solo',
        background: true,
        nodesFile: nodesFile([{ id: BG_NODE, task: `Run the standalone check. Task marker: ${nodeTask(BG_NODE)}.` }]),
      });
  },
  // F: delegate a child that never answers, find its session id, and stop it. Each step reads what the
  // transcript already proves, so the chain cannot skip a step or fire DelegateStop before it holds a real
  // session id.
  // Progress is read from the WHOLE conversation rather than from this turn's tool window, because a stopped
  // child settles immediately and the daemon then wakes the parent with its result — as a fresh turn, or
  // steered into the chain still running. A steer arrives as a USER message, so anything that treats "since
  // the last user message" as this turn is reset by it, making a mid-chain delivery indistinguishable from
  // the fresh one. Reading the transcript makes the script indifferent to which happened, which is the only
  // way this scenario is not a race.
  stop: async ({ say, callTool, awaitingTool, lastTool, allText, waitForHangingRequest, stopClock }) => {
    const jobId = (/Started background delegation (dlg-[0-9a-f-]+)/.exec(allText) ?? [])[1];
    const sessionId = (/Session: (brain-ch-subagent-\S+)/.exec(allText) ?? [])[1];
    // The delivered RESULT block, not the task marker: this scenario wrote the task itself, so the marker is
    // in context from the first tool call on and would read as "delivered" long before anything was.
    const delivered = /<subagent-result[^>]*status="error"/.test(allText);
    const acknowledged = allText.includes(MARKERS.stopDelivered);
    const chainDone = allText.includes(MARKERS.stopDone);
    const stopIssued = /^(Stopped\.|Nothing to stop)/m.test(allText);

    if (chainDone) {
      return delivered && !acknowledged
        ? say(`The stopped delegation reported back. ${MARKERS.stopDelivered}`)
        : say('The stop sequence is already complete.');
    }
    // Exactly one hanging child, ever — the suite asserts the child hung on exactly one model request. The
    // returned job id is the proof it was delegated: the task marker itself travels in the tool call's
    // ARGUMENTS, which never reach the transcript text, so keying on it would delegate over and over.
    if (!jobId) {
      return /Started background delegation/.test(allText)
        ? say(`No background job id came back. ${MARKERS.stopNoSession}`)
        : callTool('Delegate', { task: `Hold until released. Task marker: ${MARKERS.hangTask}.`, background: true });
    }
    if (stopIssued) {
      // Read the job once more AFTER the stop, so the suite sees what the stop did to the delegation rather
      // than only what the stop call claimed about itself. Close on both markers when the result already
      // arrived: a mid-chain delivery leaves no later turn to acknowledge it in.
      return awaitingTool && !/^(Stopped\.|Nothing to stop)/.test(lastTool)
        ? say(`Stop sequence complete. ${MARKERS.stopDone}${delivered ? ` ${MARKERS.stopDelivered}` : ''} ${lastTool.split('\n')[0]}`)
        : callTool('DelegateStatus', { id: jobId });
    }
    // Stamp the moment the stop is ISSUED. Without it the suite can only observe that the hanging request
    // ended somehow — which a provider timeout, a transport reset or the daemon teardown would also produce.
    // The runner pairs this with the abort stamp to prove the stop is what ended it.
    if (sessionId) {
      // Session registration precedes inference. This scenario tests transport cancellation, so do not
      // issue its stop until the provider has actually received the request it is supposed to abort.
      if (!await waitForHangingRequest()) return say('Error: hanging child model request is not ready for DelegateStop.');
      stopClock.issuedAt ??= Date.now();
      return callTool('DelegateStop', { id: sessionId });
    }
    // The child registers its session a moment after the job starts; poll a BOUNDED number of times rather
    // than stopping a job whose session id is still '(starting)'.
    return (allText.match(/Delegation job dlg-/g) ?? []).length < 12
      ? callTool('DelegateStatus', { id: jobId })
      : say(`The child never reported a session id. ${MARKERS.stopNoSession}`);
  },
};

/**
 * @returns {Promise<{
 *   baseUrl: string, requests: object[], nodeRuns: Map<string, {startedAt:number,endedAt:number}[]>,
 *   hangs: { requests: number, aborted: number, released: number, stopIssuedAt?: number, abortedAt?: number },
 *   setMode: (m: string) => void, releaseHangs: () => void, close: () => Promise<void>,
 * }>}
 */
export async function startScriptedModel({ hangReadyTimeoutMs = 15_000 } = {}) {
  const requests = [];
  /** node id -> one span per EXECUTION of that node, in order. The suite's evidence for parallelism and for
   *  resume selectivity; see the header. */
  const nodeRuns = new Map();
  const hangs = { requests: 0, aborted: 0, released: 0, stopIssuedAt: undefined, abortedAt: undefined };
  const stopClock = { issuedAt: undefined };
  let markHangReady;
  const hangReady = new Promise((resolve) => { markHangReady = resolve; });
  const waitForHangingRequest = async () => {
    let timeout;
    try {
      const ready = await Promise.race([
        hangReady,
        new Promise((resolve) => { timeout = setTimeout(() => resolve(false), hangReadyTimeoutMs); }),
      ]);
      return ready === true && hangs.requests === 1 && hangs.aborted === 0 && hangs.released === 0;
    } finally { clearTimeout(timeout); }
  };
  let releaseHang = () => {};
  /** Resolve when the suite releases the hanging children — chained so one release frees every waiter. */
  const hangReleased = () => new Promise((resolve) => {
    const previous = releaseHang;
    releaseHang = () => { previous(); resolve(); };
  });
  let mode = 'diamond';
  let toolCallSeq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    requests.push({ path: url.pathname, mode, body });

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unhandled ${req.method} ${url.pathname}` }));
      return;
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const allText = messages.map(contentText).join('\n');
    // Whether THIS request is the follow-up to a tool call — the conversation ENDS in a tool result.
    // "Does one exist anywhere" would stay true for the rest of the turn after the first tool use.
    const awaitingTool = messages.at(-1)?.role === 'tool';
    const lastTool = awaitingTool ? contentText(messages.at(-1)) : '';

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-workflow', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const delta = (d, finishReason = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finishReason }] });
    // Deliberately small and constant: this suite must never trip auto-compaction, which would summarise
    // away the dependency results a node is asserted to have been shown.
    const usage = () => frame({ ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } });
    const say = (text) => {
      res.write(delta({ role: 'assistant', content: text }));
      res.write(delta({}, 'stop'));
      res.write(usage());
    };
    const callTool = (name, args) => {
      toolCallSeq += 1;
      res.write(delta({ role: 'assistant', content: `Calling ${name}. ` }));
      res.write(delta({ tool_calls: [{ index: 0, id: `call_${toolCallSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(delta({}, 'tool_calls'));
      res.write(usage());
    };
    const finish = () => { res.write('data: [DONE]\n\n'); res.end(); };

    if (allText.includes(SUBAGENT_PROMPT) && allText.includes(MARKERS.hangTask)) {
      // The child DelegateStop exists to end. It answers nothing on its own, so this request ending WITHOUT
      // an explicit release is the stop taking effect at the transport — which is what the runner asserts on
      // (`hangs.aborted`), rather than trusting the tool's own "Stopped." reply.
      hangs.requests += 1;
      const settlement = Promise.race([
        hangReleased().then(() => 'released'),
        new Promise((resolve) => res.on('close', () => resolve('aborted'))),
      ]);
      markHangReady(true);
      const settled = await settlement;
      hangs[settled] += 1;
      if (settled === 'aborted') { hangs.abortedAt ??= Date.now(); hangs.stopIssuedAt = stopClock.issuedAt; res.end(); return; }
      say('Released.');
      finish();
      return;
    }

    if (allText.includes(SUBAGENT_PROMPT)) {
      const id = Object.keys(NODE_SCRIPT).find((n) => allText.includes(nodeTask(n)));
      if (!id) { say('Unrecognised sub-agent task.'); finish(); return; }
      const script = NODE_SCRIPT[id];
      const spans = nodeRuns.get(id) ?? [];
      const span = { startedAt: Date.now(), endedAt: 0 };
      spans.push(span);
      nodeRuns.set(id, spans);
      if (script.holdMs) await sleep(script.holdMs);
      if (script.failFirstAttempt && spans.length === 1) {
        // A node fails when its child's answer starts with 'Error:' — the same in-band convention the
        // delegate tool uses (see runNode in plugins/subagent/lib/workflow.mjs). The SECOND execution
        // succeeds, so a resume that genuinely re-ran the node is distinguishable from one that merely
        // replayed the old failure.
        say(`Error: ${MARKERS.probeFailure}`);
      } else if (script.deps) {
        const carried = script.deps.every((dep) => allText.includes(nodeResult(dep)));
        say(`Node ${id} report. ${nodeResult(id)} ${carried ? MARKERS.depsSeen : MARKERS.depsMissing}`);
      } else {
        say(`Node ${id} report. ${nodeResult(id)}`);
      }
      span.endedAt = Date.now();
      finish();
      return;
    }

    if (!Array.isArray(body?.tools) || body.tools.length === 0) {
      // A toolless completion is housekeeping (conversation titling), never an agent turn.
      say('Workflow engine checks');
      finish();
      return;
    }

    const respond = PARENT_MODES[mode];
    if (typeof respond === 'function') await respond({ say, callTool, awaitingTool, lastTool, messages, allText, waitForHangingRequest, stopClock });
    else say(`Nothing scripted for mode "${mode}".`);
    finish();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    nodeRuns,
    hangs,
    setMode: (m) => { mode = m; },
    // Teardown safety valve: any hanging child still held here is let go, so `close()` cannot block.
    releaseHangs: () => releaseHang(),
    close: () => new Promise((resolve) => {
      markHangReady(false);
      releaseHang();
      server.close(() => { process.off('exit', cleanupNodesDir); cleanupNodesDir(); resolve(); });
    }),
  };
}
