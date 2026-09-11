// Scripted OpenAI-compatible model for the sub-agent persistence + continuation E2E suite.
//
// One server serves FOUR different kinds of completion, and how each one is chosen matters:
//   1. PARENT turns are driven by the mode the RUNNER sets before every send (delegate / fillers /
//      listcontinue / scoped). Nothing is inferred, so the suite can never fail because a heuristic
//      misread a payload — the same reason continuity-e2e/model.mjs works this way.
//   2. The CHILD's first turn is recognised by CONTENT: the host's sub-agent system prompt plus the
//      delegated task marker. It has to be content-based, because a child turn arrives interleaved with
//      the parent turn that spawned it and carries no mode of its own.
//   3. The CHILD's CONTINUATION turn is the whole point of the suite. It answers with the "context
//      carried over" marker ONLY when its own history still holds the original task AND its own first
//      answer; otherwise it answers "context lost". A continuation that resumes on an empty transcript
//      therefore fails the suite loudly instead of looking like a success.
//   4. Housekeeping completions (conversation titling) are answered as plain text, so a background
//      inference can never be mistaken for an agent turn.

import { createServer } from 'node:http';

/** Unique strings the runner asserts on. Kept in one place so run.mjs and the script cannot drift. */
export const MARKERS = {
  task: 'SUBAGENT-TASK-9f21a',
  firstAnswer: 'CHILD-FIRST-ANSWER-3b7c',
  followUp: 'FOLLOW-UP-4d19e',
  contextOk: 'CONTEXT-CARRIED-OVER-5e2f',
  contextLost: 'CONTEXT-LOST-6a1b',
  fillerTask: 'FILLER-TASK',
  fillerAnswer: 'FILLER-ANSWER',
  parentDone: 'PARENT-DONE-7c4d',
  noChildId: 'NO-CHILD-ID-IN-LISTING',
};

/** The host-injected role prompt every delegated child carries — how a child request is told apart from
 *  a parent one (see plugins/subagent/index.mjs). */
export const SUBAGENT_PROMPT = 'You are a focused sub-agent';
/** A fragment of the DelegateList result body, used to tell that listing's tool result apart from the
 *  DelegateContinue one inside the SAME parent turn. */
export const LISTING_HEADER = 'in this conversation (newest first)';
/** Live channel sessions the daemon keeps in memory (its configured minimum). */
export const CHANNEL_SESSION_CAP = 4;
/** Unrelated delegations run AFTER the target child so the LRU really drops it: with the cap above, the
 *  last of these spawns is the one that evicts the oldest idle channel session — the target. From then on
 *  continuing it can only work by rehydrating its transcript from SQLite. */
export const FILLER_DELEGATIONS = CHANNEL_SESSION_CAP;

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

/** Pull the TARGET child's session id out of a DelegateList result: the id line whose task line carries
 *  the original task marker. Deliberately not "the first id in the listing" — the fillers are newer and
 *  are listed first, so picking blindly would continue the wrong sub-agent and prove nothing. */
function childIdFromListing(listing) {
  const lines = listing.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^-\s+(brain-ch-subagent-\S+)/.exec(lines[i].trim());
    if (match && (lines[i + 1] ?? '').includes(MARKERS.task)) return match[1];
  }
  return '';
}

const PARENT_MODES = {
  // Hand one self-contained task to a fresh sub-agent, then report what it said.
  delegate: ({ say, callTool, awaitingTool }) => (awaitingTool
    ? say(`The sub-agent reported back: ${MARKERS.firstAnswer}.`)
    : callTool('Delegate', { task: `Size the widget and report the number. Task marker: ${MARKERS.task}.`, background: false })),
  // Unrelated delegations, one after another inside a single turn, purely to push the target child out of
  // the live-session LRU.
  fillers: ({ say, callTool, messages }) => {
    const done = messages.filter((m) => m?.role === 'tool' && contentText(m).includes(MARKERS.fillerAnswer)).length;
    return done < FILLER_DELEGATIONS
      ? callTool('Delegate', { task: `Unrelated side task. Task marker: ${MARKERS.fillerTask}-${done + 1}.`, background: false })
      : say(`All ${FILLER_DELEGATIONS} side tasks are done.`);
  },
  // List this conversation's past sub-agents, find the target in that listing, and send it a follow-up —
  // exactly the two steps an agent takes, with the id coming from the listing rather than from the fixture.
  listcontinue: ({ say, callTool, awaitingTool, lastTool }) => {
    if (!awaitingTool) return callTool('DelegateList', {});
    if (lastTool.includes(LISTING_HEADER)) {
      const id = childIdFromListing(lastTool);
      return id
        ? callTool('DelegateContinue', { id, message: `Add the unit to that number. Follow-up marker: ${MARKERS.followUp}.`, background: false })
        : say(MARKERS.noChildId);
    }
    return say(`The sub-agent answered the follow-up. ${MARKERS.parentDone}`);
  },
  // A DIFFERENT conversation asking the same question — it must see none of the above.
  scoped: ({ say, callTool, awaitingTool }) => (awaitingTool
    ? say(MARKERS.parentDone)
    : callTool('DelegateList', {})),
};

/**
 * @returns {Promise<{ baseUrl: string, requests: object[], setMode: (m: string) => void, close: () => Promise<void> }>}
 */
export async function startScriptedModel() {
  const requests = [];
  let mode = 'delegate';
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
    // "Does one exist anywhere" would stay true for the rest of the session after the first tool use.
    const awaitingTool = messages.at(-1)?.role === 'tool';
    const lastTool = awaitingTool ? contentText(messages.at(-1)) : '';

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-subagent', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
    // Deliberately small and constant: this suite must never trip auto-compaction, which would summarise
    // away the very transcript the continuation is asserted to still carry.
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

    if (allText.includes(SUBAGENT_PROMPT)) {
      if (allText.includes(MARKERS.followUp)) {
        // THE assertion of this suite: the continued child answers from its own preserved transcript, or
        // says plainly that it has none.
        const carried = allText.includes(MARKERS.task) && allText.includes(MARKERS.firstAnswer);
        say(carried
          ? `Adding the unit to my earlier answer: 42 mm. ${MARKERS.contextOk}`
          : `I was given no earlier context to build on. ${MARKERS.contextLost}`);
      } else if (allText.includes(MARKERS.task)) {
        say(`The widget is 42. ${MARKERS.firstAnswer}`);
      } else {
        const filler = new RegExp(`${MARKERS.fillerTask}-(\\d+)`).exec(allText);
        say(filler ? `Side task ${filler[1]} handled. ${MARKERS.fillerAnswer}-${filler[1]}` : 'Unrecognised sub-agent task.');
      }
    } else if (!Array.isArray(body?.tools) || body.tools.length === 0) {
      // A toolless completion is housekeeping (conversation titling), never an agent turn.
      say('Widget sizing');
    } else {
      const respond = PARENT_MODES[mode];
      if (typeof respond === 'function') respond({ say, callTool, awaitingTool, lastTool, messages });
      else say(`Nothing scripted for mode "${mode}".`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setMode: (m) => { mode = m; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
