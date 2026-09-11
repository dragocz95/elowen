#!/usr/bin/env node
// Does the LAZY MCP connect in a sub-agent runner actually work?
//
// The parity harness next door proves a runner DECLARES the same bridged tools whether it connected at
// boot or registered from the daemon's snapshot. That is only half the claim. The other half is that a
// declared-but-unconnected tool still WORKS when the model calls it — that a quiet boot did not simply
// trade a slow runner for a broken one.
//
// So this boots a real daemon with a scripted stdio MCP server, turns the sub-agent runner on, and
// delegates a task whose child immediately calls a bridged tool TWICE IN PARALLEL. It then asserts, at the
// process level:
//
//   • before the first call, the runner has spawned NO MCP server of its own (the daemon has its own copy,
//     which is why every count here is scoped to the RUNNER's pid — a count of all `parity` processes
//     would be green no matter what the runner did);
//   • after the calls, EXACTLY ONE server process exists under the runner, and the runner logged exactly
//     one connect: two concurrent first calls shared one connect rather than racing two;
//   • both calls returned the server's real answer, so the connection was genuinely usable.
//
// SAFETY: the same throwaway-daemon harness as the other E2E suites — ephemeral port, temp data dir,
// never prod's 4400/4500 and never the prod DB.

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';

const TASK_MARKER = 'LAZY-MCP-TASK-9f21a';
const SUBAGENT_PROMPT = 'You are a focused sub-agent';
const TURN_DEADLINE_MS = 180_000;

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_MCP_SERVER = join(here, '..', 'subagent-parity', 'mock-mcp-server.mjs');
const MCP_SERVER_NAME = 'parity';
const BRIDGED_TOOL = 'mcp__parity__echo_text';
const ECHO_A = 'lazy-connect-a';
const ECHO_B = 'lazy-connect-b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contentText = (m) => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
};

/** Every live process whose parent is `ppid` and whose command line runs the scripted MCP server. Scoped
 *  to a parent on purpose: the DAEMON connected one at boot, so an unscoped count proves nothing about
 *  the runner. */
function mcpChildrenOf(ppid) {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf-8' });
  return out.split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m && Number(m[2]) === ppid && m[3].includes(MOCK_MCP_SERVER))
    .map((m) => Number(m[1]));
}

/** The pid of the forked runner, from the line the daemon writes when its handshake completes. */
function runnerPid(log) {
  let pid = null;
  for (const m of log.matchAll(/sub-agent runner ready \(pid (\d+)\)/g)) pid = Number(m[1]);
  return pid;
}

/** Scripted OpenAI-compatible model, streaming. The parent delegates once; the child answers by calling
 *  the bridged tool twice IN ONE assistant message (so both calls are dispatched together), then replies.
 *  `onChildStep` runs before each child answer, so the test can inspect the world at that exact moment —
 *  which is the only way to observe "before the first call". */
function startModel(onChildStep) {
  let seq = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* housekeeping pings */ }
      if (req.method !== 'POST' || !String(req.url).includes('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unhandled ${req.method} ${req.url}` }));
        return;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const allText = messages.map(contentText).join('\n');
      const isChild = allText.includes(SUBAGENT_PROMPT);
      const afterTools = messages.at(-1)?.role === 'tool';
      if (isChild) await onChildStep(afterTools ? 'after' : 'before', messages);

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
      const base = { id: 'chatcmpl-lazy', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
      const usage = () => frame({ ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } });
      const say = (text) => { delta({ role: 'assistant', content: text }); delta({}, 'stop'); usage(); };
      const callTools = (calls) => {
        delta({ role: 'assistant', content: 'Calling the bridged tool. ' });
        delta({
          tool_calls: calls.map((c, index) => {
            seq += 1;
            return { index, id: `call_${seq}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } };
          }),
        });
        delta({}, 'tool_calls');
        usage();
      };

      if (isChild && !afterTools) {
        // BOTH calls in ONE assistant message: they are dispatched together, so they race for the very
        // first connect. That race is what single-flight has to collapse into one.
        callTools([
          { name: BRIDGED_TOOL, args: { text: ECHO_A } },
          { name: BRIDGED_TOOL, args: { text: ECHO_B } },
        ]);
      } else if (isChild) say('child done');
      else if (!Array.isArray(body?.tools) || body.tools.length === 0) say('Lazy MCP run');
      else if (afterTools) say('parent done');
      else {
        seq += 1;
        delta({ role: 'assistant', content: 'Delegating. ' });
        delta({ tool_calls: [{ index: 0, id: `call_${seq}`, type: 'function', function: { name: 'Delegate', arguments: JSON.stringify({ task: `${TASK_MARKER} — call the bridged tool`, background: false }) } }] });
        delta({}, 'tool_calls');
        usage();
      }

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

/** Count `idle` events so a send can be awaited to settlement (POST /brain/send returns on admission). */
async function watchIdle(baseUrl, token, session) {
  const res = await fetch(`${baseUrl}/brain/stream?session=${encodeURIComponent(session)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  });
  const reader = res.body.getReader();
  const state = { idle: 0 };
  (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) if (line.includes('"idle"')) state.idle += 1;
      }
    } catch { /* torn down with the daemon */ }
  })();
  state.stop = () => reader.cancel().catch(() => {});
  return state;
}

async function main() {
  let daemon = null;
  const observed = { runnerPid: null, before: null, after: null, toolResults: [] };
  const model = await startModel(async (phase, messages) => {
    if (!daemon) return;
    const pid = runnerPid(daemon.logText());
    observed.runnerPid ??= pid;
    if (!pid) return;
    if (phase === 'before') { observed.before = mcpChildrenOf(pid); return; }
    observed.after = mcpChildrenOf(pid);
    observed.toolResults = messages.filter((m) => m?.role === 'tool').map(contentText);
  });
  daemon = await spawnRealDaemon({ providerBaseUrl: `http://127.0.0.1:${model.port}/v1` });
  try {
    const api = async (path, body) => {
      const res = await fetch(`${daemon.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
      return res.json();
    };

    // The operator's own switch, set the way an operator would — no test-only back door.
    const switchRes = await fetch(`${daemon.baseUrl}/config`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: { subagentRunnerEnabled: true } }),
    });
    if (!switchRes.ok) throw new Error(`enabling the sub-agent runner failed: ${switchRes.status} ${await switchRes.text()}`);

    const mcpRes = await fetch(`${daemon.baseUrl}/plugins/mcp/config`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        values: {
          servers: [{
            name: MCP_SERVER_NAME, enabled: true, transport: 'stdio',
            command: process.execPath, args: [MOCK_MCP_SERVER],
          }],
        },
      }),
    });
    if (!mcpRes.ok) throw new Error(`configuring the scripted MCP server failed: ${mcpRes.status} ${await mcpRes.text()}`);
    const statusRes = await fetch(`${daemon.baseUrl}/plugins/mcp/servers`, { headers: { authorization: `Bearer ${daemon.token}` } });
    const servers = statusRes.ok ? await statusRes.json() : [];
    const scripted = (Array.isArray(servers) ? servers : servers?.servers ?? []).find((s) => s?.name === MCP_SERVER_NAME);
    if (scripted?.status !== 'connected') throw new Error(`the scripted MCP server did not connect in the daemon: ${JSON.stringify(scripted ?? servers)}`);
    console.log(`daemon MCP server: connected (${scripted.toolCount} tools)`);

    const start = await api('/brain/start', { fresh: true });
    const session = start.sessionId;
    const idle = await watchIdle(daemon.baseUrl, daemon.token, session);
    const before = idle.idle;
    await api('/brain/send', { text: 'delegate one task please', session, mode: 'build' });
    const until = Date.now() + TURN_DEADLINE_MS;
    while (idle.idle === before && Date.now() < until) await sleep(200);
    idle.stop();

    const log = daemon.logText();
    const failures = [];
    if (!log.includes('sub-agent runner ready')) failures.push('the sub-agent runner never came up — this run proves nothing');
    if (log.includes('running this delegated turn in-process')) failures.push('the dispatcher fell back in-process — this run proves nothing');
    if (observed.runnerPid == null) failures.push('could not resolve the runner pid from the daemon log');

    // The runner's own statement that it took the snapshot path; `before` below is the process-level proof.
    const declared = log.split('\n').filter((l) => /runner:\d+ .*declared \d+ bridged tool\(s\) from an inherited snapshot/.test(l));
    if (declared.length !== 1) failures.push(`expected the runner to declare its bridged tools from a snapshot exactly once, saw ${declared.length}`);

    if (observed.before === null) failures.push('the child never took its first step — no "before" observation');
    else if (observed.before.length !== 0) failures.push(`the runner had already spawned ${observed.before.length} MCP server process(es) BEFORE the first bridged call: ${observed.before.join(', ')}`);

    if (observed.after === null) failures.push('the child never came back from its bridged tool calls — the lazy connect did not produce a usable tool');
    else if (observed.after.length !== 1) failures.push(`expected EXACTLY ONE MCP server process under the runner after two concurrent first calls, saw ${observed.after.length}: ${observed.after.join(', ') || 'none'}`);

    // The same claim from the other side: two connects would have logged two lines.
    const connects = log.split('\n').filter((l) => /runner:\d+ .*mcp: connected "parity"/.test(l));
    if (connects.length !== 1) failures.push(`expected exactly ONE connect in the runner, saw ${connects.length}`);

    const answers = observed.toolResults.join('\n');
    for (const expected of [ECHO_A, ECHO_B]) {
      if (!answers.includes(expected)) failures.push(`the bridged tool did not answer "${expected}" — a lazily connected tool must actually WORK (results: ${JSON.stringify(observed.toolResults)})`);
    }

    if (failures.length) {
      console.log('FAIL — the lazy MCP connect in the sub-agent runner is not behaving:');
      for (const f of failures) console.log(`  • ${f}`);
      return 1;
    }
    console.log(`PASS — runner pid ${observed.runnerPid}: no MCP server process before the first bridged call, exactly one after two concurrent ones, both calls answered`);
    for (const line of log.split('\n')) if (/runner:\d+ .*boot: /.test(line)) console.log(`  ${line.trim()}`);
    return 0;
  } finally {
    await daemon.stop();
    await model.close();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
