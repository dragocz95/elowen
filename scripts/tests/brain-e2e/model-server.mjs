// Scripted OpenAI-compatible model server for the real-daemon brain E2E harness.
//
// Fakes ONLY the nondeterministic model (same philosophy as the CLI tmux + web Playwright suites): it
// serves `POST /v1/chat/completions` with `stream:true` and returns a deterministic SSE stream of
// OpenAI chat-completion chunks. A turn drives exactly one tool round-trip:
//   1. first request (no `tool` role in the messages)  → text deltas + one tool_call, finish `tool_calls`
//   2. follow-up request (a `tool` result is present)  → final text deltas, finish `stop`
// pi-ai's openai-completions client (the official `openai` SDK under the hood) POSTs to
// `<baseUrl>/chat/completions`; keeping a `/v1` in the base makes the route `/v1/chat/completions`.
//
// The server is scriptable and stateful so a single instance can drive several turns: `setFail(true)`
// flips it to return HTTP 500 (used to prove the scenario fails loudly when the model mis-behaves).

import { createServer } from 'node:http';

/** Read and JSON-parse a request body; tolerate an empty/garbage body (returns null value). */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** One OpenAI streaming chunk, wire-encoded as an SSE `data:` frame. */
function chunkFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Start the scripted model server on an ephemeral loopback port.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.toolName] Tool the model calls on the first request (must exist in the
 *   daemon). Pass `null` for a plain-text turn: the model streams text and stops with NO tool call — one
 *   request, no follow-up (used by surfaces where the sender lacks the owner tools).
 * @param {string} [opts.toolArgs]   JSON string of the tool arguments (default '{}').
 * @param {string} [opts.firstText]  Text streamed before the tool call (or the whole answer in no-tool mode).
 * @param {string} [opts.finalText]  Text streamed on the follow-up (post-tool) request, or appended in no-tool mode.
 * @returns {Promise<{ baseUrl: string, port: number, requests: object[], setFail: (v:boolean)=>void, close: ()=>Promise<void> }>}
 */
export async function startModelServer(opts = {}) {
  const noTool = opts.toolName === null; // explicit null → answer directly, never call a tool
  const toolName = opts.toolName ?? 'ElowenListMissions';
  const toolArgs = opts.toolArgs ?? '{}';
  const firstText = opts.firstText ?? 'Let me check the Elowen missions for you. ';
  const finalText = opts.finalText ?? 'E2E-BRAIN-DONE: there are no active missions right now.';

  const requests = [];
  let fail = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    requests.push({ method: req.method, path: url.pathname, body });

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unhandled ${req.method} ${url.pathname}` }));
      return;
    }

    // Teeth mode: a provider error must surface as a loud, streamed brain `error` event.
    if (fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'E2E injected provider failure', type: 'server_error' } }));
      return;
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const hasToolResult = messages.some((m) => m && m.role === 'tool');

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    const id = 'chatcmpl-e2e';
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: 'chat.completion.chunk', created, model: 'mock-model' };
    const delta = (d, finish = null) =>
      chunkFrame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
    const usage = (prompt, completion) =>
      chunkFrame({ ...base, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });

    if (noTool) {
      // Plain-text turn: stream a couple of accumulating text deltas and stop — no tool call, so a
      // single request completes the turn (a sender without the owner toolset just gets an answer).
      res.write(delta({ role: 'assistant', content: firstText }));
      res.write(delta({ content: finalText }));
      res.write(delta({}, 'stop'));
      res.write(usage(90, 12));
    } else if (!hasToolResult) {
      // First model turn: stream a couple of text deltas (assert they ACCUMULATE, not replace), then a
      // single tool call the daemon actually executes.
      res.write(delta({ role: 'assistant', content: firstText }));
      res.write(delta({ content: 'One moment. ' }));
      res.write(delta({ tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: toolName, arguments: toolArgs } }] }));
      res.write(delta({}, 'tool_calls'));
      res.write(usage(120, 18));
    } else {
      // Follow-up turn: the tool result is in context — answer and stop.
      res.write(delta({ role: 'assistant', content: finalText }));
      res.write(delta({}, 'stop'));
      res.write(usage(160, 24));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model server did not bind a TCP port');
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    setFail: (v) => { fail = !!v; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
