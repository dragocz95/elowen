import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const logPath = process.env.ELOWEN_TMUX_LOG;
if (!logPath) throw new Error('ELOWEN_TMUX_LOG is required');

const TOKEN = 'e2e-token';
const SESSION_ID = 'e2e-session';
const streams = new Set();
const firstTimers = new Set();
let firstProgress = null;
let sendCount = 0;

function log(entry) {
  appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function emit(event) {
  log({ kind: 'event', event });
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) stream.write(frame);
}

function later(delay, fn, bucket = null) {
  const timer = setTimeout(() => {
    bucket?.delete(timer);
    fn();
  }, delay);
  timer.unref?.();
  bucket?.add(timer);
  return timer;
}

function stopFirstTurn() {
  for (const timer of firstTimers) clearTimeout(timer);
  firstTimers.clear();
  if (firstProgress) clearInterval(firstProgress);
  firstProgress = null;
}

function runFirstTurn(text) {
  later(40, () => emit({ type: 'user', text }), firstTimers);
  later(80, () => emit({ type: 'step', step: 1, maxSteps: 8 }), firstTimers);
  later(120, () => {
    emit({
      type: 'tool', id: 'long-tool', name: 'run_command',
      detail: 'sleep e2e-long-run', command: 'sleep e2e-long-run',
    });
    let phase = 0;
    firstProgress = setInterval(() => {
      phase += 1;
      emit({ type: 'tool_progress', id: 'long-tool', text: `E2E LONG PHASE ${phase}` });
    }, 100);
    firstProgress.unref?.();
  }, firstTimers);
}

function runSecondTurn(text) {
  later(40, () => emit({ type: 'user', text }));
  later(80, () => emit({ type: 'step', step: 1, maxSteps: 8 }));
  later(130, () => emit({
    type: 'tool', id: 'final-tool', name: 'run_command',
    detail: 'npm run e2e-demo', command: 'npm run e2e-demo',
  }));
  later(220, () => emit({ type: 'tool_progress', id: 'final-tool', text: 'E2E TOOL STREAMING' }));
  later(320, () => emit({
    type: 'tool_output', id: 'final-tool',
    output: {
      title: 'console output', kind: 'console', text: 'E2E TOOL OUTPUT',
      status: 'exit 0', tone: 'success',
    },
  }));
  later(420, () => emit({ type: 'text', delta: 'E2E FINAL REPLY' }));
  later(520, () => emit({
    type: 'idle', model: 'mock/e2e-model',
    usage: { tokens: 1234, contextWindow: 100000, percent: 1.2, totalTokens: 2345, cost: 0.0123 },
  }));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return { raw: '', value: null };
  try { return { raw, value: JSON.parse(raw) }; }
  catch { return { raw, value: null }; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const body = await readBody(req);
  log({
    kind: 'request', method: req.method, path: url.pathname,
    query: Object.fromEntries(url.searchParams), body: body.value ?? body.raw,
    authorization: req.headers.authorization === `Bearer ${TOKEN}` ? 'ok' : 'missing-or-wrong',
  });

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/brain/start') {
    json(res, 201, { sessionId: SESSION_ID });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/status') {
    json(res, 200, {
      running: true,
      sessionId: SESSION_ID,
      title: 'E2E Harness',
      model: 'mock/e2e-model',
      usage: { tokens: 1200, contextWindow: 100000, percent: 1.2, totalTokens: 1200, cost: 0.01 },
      statusline: null,
      thinkingLevel: 'high',
      thinkingLevels: ['low', 'medium', 'high'],
      thinkingLevelLabels: {},
      fast: false,
      fastAvailable: false,
      pendingAsk: null,
      cards: [],
      queued: [],
      lspEnabled: true,
      yolo: false,
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/processes') {
    json(res, 200, []);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/me/terminal-settings') {
    json(res, 200, { theme: 'default', showThoughtsCli: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/messages') {
    json(res, 200, []);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/commands') {
    json(res, 200, { commands: [] });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/rate-limits') {
    json(res, 200, null);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/plugins/mcp/servers') {
    json(res, 200, []);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    streams.add(res);
    res.write(': connected\n\n');
    req.on('close', () => streams.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/brain/send') {
    sendCount += 1;
    json(res, 200, { ok: true });
    const text = typeof body.value?.text === 'string' ? body.value.text : '';
    if (sendCount === 1) runFirstTurn(text);
    else if (sendCount === 2) runSecondTurn(text);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/brain/abort') {
    stopFirstTurn();
    emit({ type: 'idle', model: 'mock/e2e-model' });
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/brain/session/stop') {
    stopFirstTurn();
    json(res, 200, { stopped: true, disposed: true });
    return;
  }

  json(res, 404, { error: `unhandled ${req.method} ${url.pathname}` });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind a TCP port');
  log({ kind: 'ready', port: address.port });
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

function shutdown() {
  stopFirstTurn();
  for (const stream of streams) stream.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
