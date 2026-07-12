import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const logPath = process.env.ELOWEN_TMUX_LOG;
if (!logPath) throw new Error('ELOWEN_TMUX_LOG is required');

const TOKEN = 'e2e-token';
const SESSION_ID = 'e2e-session';
const SCENARIO = process.env.ELOWEN_TMUX_SCENARIO ?? 'long';
const streams = new Set();
const firstTimers = new Set();
const goalTimers = new Set();
let firstProgress = null;
let sendCount = 0;
let currentCards = [];
let currentGoal = null;
const shortHistory = [];
const childHistory = [
  { id: 'child-u1', role: 'user', text: 'E2E CHILD TASK INPUT' },
  { id: 'child-a1', role: 'assistant', text: 'E2E CHILD UNIQUE HISTORY — drill-in loaded' },
];
const longHistory = Array.from({ length: 90 }, (_, index) => [
  { role: 'user', text: `E2E HISTORY QUESTION ${index}` },
  { role: 'assistant', text: `## E2E HISTORY ANSWER ${index}\n\n- stable row one\n- stable row two\n\nE2E HISTORY MARKER ${index}` },
]).flat();

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
  if (event.type === 'card') {
    currentCards = [...currentCards.filter((card) => card.id !== event.card.id), event.card];
  }
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

function stopGoalTurn() {
  for (const timer of goalTimers) clearTimeout(timer);
  goalTimers.clear();
}

function sqliteUtc(epoch = Date.now()) {
  return new Date(epoch).toISOString().replace('T', ' ').slice(0, 19);
}

function runGoalTurn(text) {
  stopGoalTurn();
  const createdAt = sqliteUtc();
  currentGoal = {
    session_id: SESSION_ID,
    user_id: 1,
    status: 'active',
    goal: text,
    draft: '',
    subgoals: '[]',
    turns_used: 0,
    turn_budget: 4,
    last_verdict: '',
    last_evidence: '',
    paused_reason: '',
    created_at: createdAt,
    updated_at: createdAt,
  };
  emit({ type: 'goal', goal: currentGoal });
  later(60, () => emit({ type: 'step', step: 1, maxSteps: 8 }), goalTimers);
  later(100, () => emit({
    type: 'tool', id: 'goal-tool', name: 'run_command',
    detail: 'verify isolated goal project', command: 'git status --short',
  }), goalTimers);
  later(180, () => emit({ type: 'tool_progress', id: 'goal-tool', text: 'E2E GOAL TOOL RUNNING' }), goalTimers);
  later(420, () => emit({
    type: 'tool_output', id: 'goal-tool',
    output: { title: 'console output', kind: 'console', text: 'E2E GOAL TOOL COMPLETE', tone: 'success' },
  }), goalTimers);
  later(700, () => emit({ type: 'text', delta: 'E2E GOAL WORKING — deterministic autonomous turn.' }), goalTimers);
  later(4_800, () => emit({ type: 'text', delta: '\nE2E GOAL COMPLETE — tmux lifecycle verified.' }), goalTimers);
  later(4_900, () => emit({
    type: 'idle', model: 'mock/e2e-model',
    usage: { tokens: 64, contextWindow: 100000, percent: 0.06, totalTokens: 64, cost: 0.001 },
  }), goalTimers);
  return new Promise((resolve) => {
    later(5_000, () => {
      currentGoal = {
        ...currentGoal,
        status: 'done',
        turns_used: 1,
        last_verdict: 'done',
        last_evidence: 'tmux lifecycle verified',
        updated_at: sqliteUtc(),
      };
      shortHistory.push({
        id: 'goal-a1', role: 'assistant',
        text: 'E2E GOAL WORKING — deterministic autonomous turn.\nE2E GOAL COMPLETE — tmux lifecycle verified.',
      });
      emit({ type: 'goal', goal: currentGoal });
      resolve(currentGoal);
    }, goalTimers);
  });
}

function runGoalLiveness(text) {
  shortHistory.push(
    { id: 'goal-u2', role: 'user', text },
    { id: 'goal-a2', role: 'assistant', text: 'E2E POST-GOAL INPUT ACCEPTED' },
  );
  later(30, () => emit({ type: 'user', text }));
  later(60, () => emit({ type: 'text', delta: 'E2E POST-GOAL INPUT ACCEPTED' }));
  later(90, () => emit({
    type: 'idle', model: 'mock/e2e-model',
    usage: { tokens: 80, contextWindow: 100000, percent: 0.08, totalTokens: 80, cost: 0.002 },
  }));
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
  later(150, () => emit({ type: 'tool', id: 'delegate-e2e', name: 'delegate', detail: 'verify the CLI panels' }));
  later(180, () => emit({
    type: 'subagent', id: 'delegate-e2e', sessionId: 'e2e-child', status: 'running',
    task: 'verify the CLI panels', detail: 'checking resize', tools: 2, tokens: 321, seconds: 4,
    model: 'mock/e2e-child',
  }));
  later(220, () => emit({ type: 'tool_progress', id: 'final-tool', text: 'E2E TOOL STREAMING' }));
  later(240, () => emit({
    type: 'card',
    card: {
      id: 'e2e-todos', title: 'Todos', pinned: true,
      items: [
        { text: 'stream response', status: 'completed' },
        { text: 'survive resize', status: 'in_progress' },
        { text: 'accept another input', status: 'pending' },
        { text: 'keep the footer unique', status: 'pending' },
        { text: 'preserve the editor', status: 'pending' },
        { text: 'drag the transcript scrollbar', status: 'pending' },
        { text: 'fit short terminal menus', status: 'pending' },
        { text: 'verify terminal cleanup', status: 'pending' },
      ],
    },
  }));
  later(320, () => emit({
    type: 'tool_output', id: 'final-tool',
    output: {
      title: 'console output', kind: 'console', text: 'E2E TOOL OUTPUT',
      status: 'exit 0', tone: 'success',
    },
  }));
  later(420, () => emit({ type: 'text', delta: 'E2E FINAL REPLY' }));
  later(460, () => emit({
    type: 'subagent', id: 'delegate-e2e', sessionId: 'e2e-child', status: 'done',
    task: 'verify the CLI panels', detail: 'done', tools: 3, tokens: 654, seconds: 7,
    model: 'mock/e2e-child',
  }));
  later(520, () => emit({
    type: 'idle', model: 'mock/e2e-model',
    usage: { tokens: 1234, contextWindow: 100000, percent: 1.2, totalTokens: 2345, cost: 0.0123 },
  }));
}

function runAskTurn(text) {
  later(30, () => emit({ type: 'user', text }));
  later(70, () => emit({
    type: 'ask', id: 'e2e-ask',
    questions: [{
      header: 'Deployment',
      question: 'Which deterministic rollout option should the terminal harness choose on this short screen?',
      multiSelect: false,
      custom: false,
      options: Array.from({ length: 12 }, (_, index) => ({
        label: index === 11 ? 'Option 12 — final visible choice' : `Option ${index + 1}`,
        description: `Deterministic choice ${index + 1} used to exercise the constrained ask viewport`,
      })),
    }],
  }));
}

function runShortTurn(text) {
  shortHistory.push(
    { id: 'short-u1', role: 'user', text },
    { id: 'short-a1', role: 'assistant', text: 'E2E SHORT REPLY' },
  );
  later(20, () => emit({ type: 'user', text }));
  later(35, () => emit({ type: 'text', delta: 'E2E SHORT REPLY' }));
  later(55, () => emit({
    type: 'idle', model: 'mock/e2e-model',
    usage: { tokens: 24, contextWindow: 100000, percent: 0.02, totalTokens: 24, cost: 0.0001 },
  }));
}

function runControlBurst(text) {
  shortHistory.push({ id: 'short-u2', role: 'user', text });
  shortHistory.push({
    id: 'short-a2', role: 'assistant', text: 'E2E CONTROL BURST COMPLETE',
    segments: [
      ...Array.from({ length: 14 }, (_, index) => ({
        kind: 'tool', id: `unsafe-tool-${index}`, name: 'run_command',
        command: `printf column-${index}`, detail: `printf column-${index}`,
        output: {
          title: 'console output', kind: 'console',
          text: `name value-${index}\nsecond row-${index}\nrewritten-${index}`,
          status: 'exit 0', tone: 'success',
        },
      })),
      { kind: 'text', text: 'E2E CONTROL BURST COMPLETE' },
    ],
  });
  later(20, () => emit({ type: 'user', text }));
  for (let index = 0; index < 14; index += 1) {
    const id = `unsafe-tool-${index}`;
    const delay = 30 + index * 4;
    later(delay, () => emit({
      type: 'tool', id, name: 'run_command',
      detail: `column\t${index}\u001b[2J`,
      command: `printf 'column\t${index}'\u001b[2J`,
    }));
    later(delay + 1, () => emit({
      type: 'tool_progress', id,
      text: `phase\t${index}\rprogress ${index}\u001b]0;unsafe-title\u0007`,
    }));
    later(delay + 2, () => emit({
      type: 'tool_output', id,
      output: {
        title: `console\t${index}\u001b[31m`, kind: 'console',
        text: `name\tvalue-${index}\nsecond\trow-${index}\rrewritten-${index}\u001b[2J\u001b]0;unsafe-title\u0007`,
        status: `exit\t0`, tone: 'success',
      },
    }));
  }
  later(105, () => emit({ type: 'text', delta: 'E2E CONTROL BURST COMPLETE' }));
  later(125, () => emit({
    type: 'idle', model: 'mock/e2e-model',
    usage: { tokens: 3456, contextWindow: 100000, percent: 3.4, totalTokens: 3456, cost: 0.02 },
  }));
}

function runReopenTurn(text) {
  shortHistory.push(
    { id: 'short-u3', role: 'user', text },
    { id: 'short-a3', role: 'assistant', text: 'E2E REOPEN HEALTHY' },
  );
  later(20, () => emit({ type: 'user', text }));
  later(40, () => emit({ type: 'text', delta: 'E2E REOPEN HEALTHY' }));
  later(60, () => emit({
    type: 'idle', model: 'mock/e2e-model',
    usage: { tokens: 4567, contextWindow: 100000, percent: 4.5, totalTokens: 4567, cost: 0.03 },
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
      cards: currentCards,
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
  if (req.method === 'GET' && url.pathname === '/brain/goal') {
    json(res, 200, currentGoal);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/me/terminal-settings') {
    json(res, 200, { theme: 'default', showThoughtsCli: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/messages') {
    const requestedSession = url.searchParams.get('session');
    const history = requestedSession === 'e2e-child'
      ? childHistory
      : process.env.ELOWEN_TMUX_LONG === '1' ? longHistory : shortHistory;
    json(res, 200, history);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/commands') {
    json(res, 200, { commands: [
      { name: 'help', description: 'Show commands and keyboard shortcuts', kind: 'info', surfaces: ['cli'] },
      { name: 'editor', description: 'Open the external editor', kind: 'info', surfaces: ['cli'] },
      { name: 'sessions', description: 'Switch conversations', kind: 'picker', surfaces: ['cli'] },
      { name: 'model', description: 'Choose a model', kind: 'picker', surfaces: ['cli'] },
      { name: 'theme', description: 'Choose a terminal theme', kind: 'picker', surfaces: ['cli'] },
      { name: 'think', description: 'Choose reasoning effort', kind: 'picker', surfaces: ['cli'] },
      { name: 'compact', description: 'Compact conversation context', kind: 'action', surfaces: ['cli'] },
      { name: 'status', description: 'Show daemon status', kind: 'info', surfaces: ['cli'] },
      { name: 'tools', description: 'Inspect runtime tools', kind: 'info', surfaces: ['cli'] },
      { name: 'skills', description: 'Inspect installed skills', kind: 'info', surfaces: ['cli'] },
      { name: 'plan', description: 'Switch to plan mode', kind: 'mode', surfaces: ['cli'] },
      { name: 'build', description: 'Switch to build mode', kind: 'mode', surfaces: ['cli'] },
      { name: 'new', description: 'Start a new conversation', kind: 'action', surfaces: ['cli'] },
      { name: 'stop', description: 'Stop the active conversation', kind: 'action', surfaces: ['cli'] },
    ] });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/brain/rate-limits') {
    json(res, 200, {
      provider: 'openai-codex', planType: 'pro', fetchedAt: 1_900_000_000_000, stale: false,
      primary: { usedPercent: 23, windowMinutes: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 14, windowMinutes: 10_080, resetsAt: 1_900_500_000 },
    });
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
  if (req.method === 'POST' && url.pathname === '/brain/goal' && SCENARIO === 'goal') {
    const text = typeof body.value?.text === 'string' ? body.value.text : '';
    const goal = await runGoalTurn(text);
    json(res, 201, goal);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/brain/send') {
    sendCount += 1;
    json(res, 200, { ok: true });
    const text = typeof body.value?.text === 'string' ? body.value.text : '';
    if (SCENARIO === 'goal') {
      runGoalLiveness(text);
      return;
    }
    if (SCENARIO === 'short-controls') {
      if (sendCount === 1) runShortTurn(text);
      else if (sendCount === 2) runControlBurst(text);
      else if (sendCount === 3) runReopenTurn(text);
      return;
    }
    if (sendCount === 1) runFirstTurn(text);
    else if (sendCount === 2) {
      later(25, () => emit({ type: 'queue', items: [{ id: 'queued-e2e', text }] }));
    } else if (sendCount === 3) runSecondTurn(text);
    else if (sendCount === 4) runAskTurn(text);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/brain/answer') {
    json(res, 200, { ok: true, matched: true });
    later(30, () => emit({ type: 'text', delta: 'E2E ASK ANSWER ACCEPTED' }));
    later(60, () => emit({
      type: 'idle', model: 'mock/e2e-model',
      usage: { tokens: 1300, contextWindow: 100000, percent: 1.3, totalTokens: 2400, cost: 0.013 },
    }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/brain/abort') {
    stopFirstTurn();
    emit({ type: 'queue', items: [] });
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
  stopGoalTurn();
  for (const stream of streams) stream.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
