// Deterministic OpenAI-compatible model for daemon-restart recovery E2E.
//
// It holds an initial child turn open until the daemon restart tears its transport down, then answers only
// the recovery continuation. The unsafe mode instead starts a real Bash tool call that remains unanswered,
// giving recovery a persisted, observable pending tool-call suffix to answer. The ownerBash mode does the
// same in the OWNER turn itself (no delegation), so the pause/resume of a top-level conversation is
// observable on its own.

import { createServer } from 'node:http';

export const MARKERS = {
  backgroundTask: 'RECOVERY-BACKGROUND-TASK-a3d9',
  backgroundResult: 'RECOVERY-BACKGROUND-RESULT-c4e1',
  foregroundTask: 'RECOVERY-FOREGROUND-TASK-b7f2',
  foregroundResult: 'RECOVERY-FOREGROUND-RESULT-d8a6',
  unsafeTask: 'RECOVERY-UNSAFE-TASK-e2c5',
  unsafeContinued: 'RECOVERY-UNSAFE-CONTINUED-f6b4',
  unsafeParentContinue: 'RECOVERY-UNSAFE-PARENT-CONTINUE-9a73',
  unsafeChildContinue: 'RECOVERY-UNSAFE-CHILD-CONTINUE-1c84',
  ownerBashTask: 'RECOVERY-OWNER-BASH-TASK-7e21',
  ownerBashResult: 'RECOVERY-OWNER-BASH-RESULT-5d09',
  ownerSteer: 'RECOVERY-OWNER-STEER-3b6f',
  parentGotResult: 'RECOVERY-PARENT-GOT-RESULT-8c42',
};

const CHILD_PROMPT = 'You are a focused sub-agent';
// The resume is SILENT: no note of any kind enters the context. What the model sees after a restart is
// its own transcript, with the tool calls the restart cut off answered by `[interrupted …]` results —
// and for a child held mid-model-call, exactly the request it was making before. Any wording that
// announces a restart in a request is counted, so the suite can assert it never appears.
const RESUME_NOTE_WORDING = 'The daemon restarted';
const INTERRUPTED_RESULT = '[interrupted';
const SUBAGENT_RESULT_TAG = '<subagent-result';
const LISTING_HEADER = 'in this conversation (newest first)';

const contentText = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join(' ');
  return '';
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/** Start one isolated scripted provider for a recovery scenario. */
export async function startRecoveryModel({ task, result, background = false, unsafe = false, ownerBash = false }) {
  const requests = [];
  const toolCalls = [];
  let toolCallSequence = 0;
  let releaseHeld = () => {};
  const held = new Promise((resolve) => { releaseHeld = resolve; });
  let signalInitialChild = () => {};
  const initialChildArrived = new Promise((resolve) => { signalInitialChild = resolve; });
  let initialChildSignalled = false;
  let resumeNotesSeen = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    requests.push({ path: url.pathname, body, at: Date.now() });
    if (JSON.stringify(body).includes(RESUME_NOTE_WORDING)) resumeNotesSeen += 1;
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unhandled ${req.method} ${url.pathname}` }));
      return;
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const allText = messages.map(contentText).join('\n');
    const last = messages.at(-1);
    const awaitingTool = last?.role === 'tool';
    const lastTool = awaitingTool ? contentText(last) : '';
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    const base = {
      id: 'chatcmpl-recovery-e2e', object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: 'mock-model',
    };
    const delta = (value, finish = null) => frame({ ...base, choices: [{ index: 0, delta: value, finish_reason: finish }] });
    const usage = () => frame({ ...base, choices: [], usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } });
    const finish = () => { res.write('data: [DONE]\n\n'); res.end(); };
    const say = (text) => {
      res.write(delta({ role: 'assistant', content: text }));
      res.write(delta({}, 'stop'));
      res.write(usage());
      finish();
    };
    const callTool = (name, args) => {
      toolCalls.push({ name, args });
      toolCallSequence += 1;
      res.write(delta({ role: 'assistant', content: `Calling ${name}.` }));
      res.write(delta({ tool_calls: [{ index: 0, id: `call_recovery_${toolCallSequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(delta({}, 'tool_calls'));
      res.write(usage());
      finish();
    };

    const isChild = allText.includes(CHILD_PROMPT) && allText.includes(task);
    if (isChild) {
      if (allText.includes(MARKERS.unsafeChildContinue)) {
        say(`The paused child was continued deliberately. ${MARKERS.unsafeContinued}`);
        return;
      }
      // The continuation after the restart: the interrupted call is answered [interrupted] (unsafe mode),
      // or — for a child that was held mid-model-call — the same request arrives a second time from a
      // fresh transport. Either way the child simply finishes.
      if (allText.includes(INTERRUPTED_RESULT) || (!unsafe && initialChildSignalled)) {
        say(`Recovered child completed its original task. ${result}`);
        return;
      }
      if (unsafe) {
        // Long enough for a slow CI daemon to be killed after the persisted tool call is observed, but finite:
        // a detached terminal process outlives that daemon, so an endless interval would leak on every run.
        callTool('Bash', { command: 'node -e "setTimeout(() => {}, 120000)"' });
        return;
      }
      if (!initialChildSignalled) {
        initialChildSignalled = true;
        signalInitialChild();
      }
      await held;
      if (!res.destroyed && !res.writableEnded) say(`Initial child was released. ${result}`);
      return;
    }

    // The durable delivery of a recovered child's answer into its parent: acknowledge it, never re-delegate.
    if (!isChild && allText.includes(SUBAGENT_RESULT_TAG)) {
      say(`Parent received the recovered sub-agent result. ${MARKERS.parentGotResult}`);
      return;
    }

    if (ownerBash && allText.includes(task)) {
      // The resumed OWNER turn: its Bash call is answered [interrupted]; nothing else was added.
      if (allText.includes(INTERRUPTED_RESULT)) {
        say(`Owner turn resumed after the pause. ${result}`);
        return;
      }
      if (awaitingTool) { say('Owner acknowledged the tool result.'); return; }
      callTool('Bash', { command: 'node -e "setTimeout(() => {}, 120000)"' });
      return;
    }

    if (allText.includes(MARKERS.unsafeParentContinue)) {
      if (!awaitingTool) {
        callTool('DelegateList', {});
        return;
      }
      if (lastTool.includes(LISTING_HEADER)) {
        const child = /brain-ch-subagent-\S+/.exec(lastTool)?.[0] ?? '';
        if (!child) { say('Could not find the interrupted child.'); return; }
        callTool('DelegateContinue', { id: child, message: MARKERS.unsafeChildContinue });
        return;
      }
      say(`Parent received the continued child result. ${MARKERS.unsafeContinued}`);
      return;
    }

    if (allText.includes(task)) {
      if (awaitingTool) {
        say('Parent acknowledged the delegation start.');
        return;
      }
      callTool('Delegate', { task, ...(background ? { background: true } : {}) });
      return;
    }

    // Provider calls without tools are housekeeping (for example automatic conversation titling).
    say('Recovery E2E');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model server did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    toolCalls,
    initialChildArrived,
    /** How many requests carried a restart announcement — must stay 0. */
    resumeNotesSeen: () => resumeNotesSeen,
    childRequests: () => requests.filter((request) => {
      const text = (Array.isArray(request.body?.messages) ? request.body.messages : []).map(contentText).join('\n');
      return text.includes(CHILD_PROMPT) && text.includes(task);
    }),
    close: () => new Promise((resolve) => {
      releaseHeld();
      server.close(() => resolve());
    }),
  };
}
