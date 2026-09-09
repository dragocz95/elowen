// Scripted OpenAI-compatible model for the MANAGED-project workflow test
// (tests/plugins/workflowManagedGuest.podman.test.ts).
//
// One parent turn walks the exact sequence WorkflowStart documents, with no shortcuts: the parent WRITES
// its files with the real Write tool (which, in a managed project, routes through the Sandbox guest
// provider), then calls WorkflowStart on the guest path it just wrote. Nothing is planted on the host and
// nothing is planted through a back door, so the definition the engine reads is one the agent really
// created inside the environment.
//
// The parent's step is chosen by COUNTING the tool results already in the request, never by pattern-
// matching their text: a heuristic that misread a result would make the suite fail for the wrong reason.
// The node is recognised by the host's sub-agent role prompt plus its own task marker, the same way the
// host-side workflow suite does it.
//
// The node is the scope evidence. It is asked to read a file that exists ONLY inside the project's guest
// filesystem and to report whether it found the contents. A child that lost the managed project scope
// reaches a different filesystem, where that path does not exist, and says so instead — so a broken scope
// arrives as a visible marker rather than as an invented answer.

import { createServer } from 'node:http';

/** The host-injected role prompt every delegated child carries. */
export const SUBAGENT_PROMPT = 'You are a focused sub-agent';

/** Guest-only paths. `/workspace` is the managed project's own tree; neither path exists on the host. */
export const GUEST_MARKER_PATH = '/workspace/scope-marker.txt';
export const GUEST_NODES_PATH = '/workspace/wf.json';

/** The contents of the guest-only file. A node that reports this string read the project's guest. */
export const GUEST_MARKER = 'MANAGED-GUEST-MARKER-4f1c9a';
/** The node's task marker — how the server recognises whose turn it is. */
export const NODE_TASK = 'WF-MANAGED-TASK-7b2e';
export const NODE_ID = 'guestprobe';

export const MARKERS = {
  /** The node found the guest-only file: it kept the project (and the account the provider authorizes). */
  scopeKept: 'NODE-READ-GUEST-MARKER-1a2b',
  /** The node ran but could not see the guest file — a lost or wrong scope. */
  scopeLost: 'NODE-MISSING-GUEST-MARKER-3c4d',
  /** What the node puts in its handover, so the parent's summary can be checked for the node's result. */
  nodeResult: 'WF-MANAGED-RESULT-5e6f',
  /** The parent's closing word, proving the workflow result came back into the parent turn. */
  parentDone: 'PARENT-MANAGED-DONE-8a9b',
};

/** The definition the parent writes into the guest. One node, no deps: this suite is about the managed
 *  route and the child's scope, not about scheduling, which the host-side suite already covers. */
export const workflowDefinition = () => JSON.stringify({
  title: 'Managed guest run',
  nodes: [{
    id: NODE_ID,
    task: `Task marker: ${NODE_TASK}. Use the Read tool on ${GUEST_MARKER_PATH} and report whether you could read its contents.`,
  }],
});

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

/**
 * @returns {Promise<{ baseUrl: string, requests: object[], nodeRequests: object[], close: () => Promise<void> }>}
 */
export async function startScriptedModel() {
  const requests = [];
  /** Every request the NODE made — the runner reads the child's own wire traffic off these. */
  const nodeRequests = [];
  let toolCallSeq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    requests.push({ path: url.pathname, body });

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unhandled ${req.method} ${url.pathname}` }));
      return;
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const allText = messages.map(contentText).join('\n');
    const awaitingTool = messages.at(-1)?.role === 'tool';
    const lastTool = awaitingTool ? contentText(messages.at(-1)) : '';

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-managed-workflow', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const delta = (d, finishReason = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finishReason }] });
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

    // --- the workflow node -------------------------------------------------------------------------
    if (allText.includes(SUBAGENT_PROMPT) && allText.includes(NODE_TASK)) {
      nodeRequests.push(body);
      if (!awaitingTool) {
        callTool('Read', { file_path: GUEST_MARKER_PATH });
        finish();
        return;
      }
      // Behavioural, not merely observational: the node states which filesystem it actually reached, so a
      // child that lost the managed scope reports it instead of quietly answering from somewhere else.
      const verdict = lastTool.includes(GUEST_MARKER) ? MARKERS.scopeKept : MARKERS.scopeLost;
      say(`Node report: ${verdict}.\n\n## Handover\n${MARKERS.nodeResult} ${verdict}`);
      finish();
      return;
    }
    if (allText.includes(SUBAGENT_PROMPT)) {
      say('Unrecognised sub-agent task.');
      finish();
      return;
    }

    if (!Array.isArray(body?.tools) || body.tools.length === 0) {
      // Toolless completions are housekeeping (conversation titling), never an agent turn.
      say('Managed workflow checks');
      finish();
      return;
    }

    // --- the parent ---------------------------------------------------------------------------------
    // Step by COUNT of tool results, so no step depends on reading another step's output.
    const step = messages.filter((m) => m?.role === 'tool').length;
    if (step === 0) callTool('Write', { file_path: GUEST_MARKER_PATH, content: GUEST_MARKER });
    else if (step === 1) callTool('Write', { file_path: GUEST_NODES_PATH, content: workflowDefinition() });
    else if (step === 2) callTool('WorkflowStart', { nodesFile: GUEST_NODES_PATH, title: 'Managed guest run' });
    // The workflow's own summary is echoed back so the runner can assert on the parent's persisted reply
    // as well as on the tool result, the way the host-side suite does.
    else say(`${MARKERS.parentDone}\n${lastTool}`);
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
    nodeRequests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
