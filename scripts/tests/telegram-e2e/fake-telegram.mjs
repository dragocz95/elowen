// A tiny fake Telegram Bot API server for the Telegram-adapter E2E suite.
//
// grammY (the transport used by plugins/telegram) talks to the Bot API over plain HTTP: it POSTs a JSON
// body to `<apiRoot>/bot<token>/<method>` and expects `{ ok: true, result: … }` back (or `{ ok: false,
// … }`, which it turns into a GrammyError). This server implements exactly the long-poll surface the
// adapter drives — getMe, deleteWebhook, getUpdates (delivers scripted inbound updates, then long-polls
// "empty"), setMyCommands, sendMessage, editMessageText, sendChatAction, setMessageReaction,
// answerCallbackQuery, deleteMessage — and CAPTURES every outbound call so the test can assert what the
// bot sent back. Any unmodeled method returns a realistic `{ ok: true, result: true }`.
//
// SAFETY: binds an ephemeral loopback port (never 4400/4500), never reaches the real api.telegram.org.

import { createServer } from 'node:http';

/** Read and JSON-parse a request body; tolerate an empty/garbage body (returns {}). */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Start the fake Bot API server on an ephemeral loopback port.
 *
 * @param {object} [opts]
 * @param {string} [opts.username]  The bot's @username reported by getMe (default 'elowen_e2e_bot').
 * @returns {Promise<{
 *   baseUrl: string, port: number, botUser: object, calls: object[],
 *   injectText: (m: { text: string, userId: number, chatId?: number, firstName?: string, username?: string }) => object,
 *   callsOf: (method: string) => object[],
 *   waitForCall: (predicate: (calls: object[]) => boolean, timeoutMs: number, label: string) => Promise<object[]>,
 *   waitForPoll: (timeoutMs: number) => Promise<void>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeTelegram(opts = {}) {
  const botUser = {
    id: 7_000_000_001,
    is_bot: true,
    first_name: 'Elowen E2E',
    username: opts.username ?? 'elowen_e2e_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  const calls = [];        // every captured outbound call (getUpdates excluded — it's polling noise)
  const callWaiters = [];   // { predicate, resolve } resolved as new calls land
  let updateSeq = 0;
  let messageSeq = 1000;
  let pollCount = 0;
  const pollWaiters = [];   // resolvers waiting for the next getUpdates poll to be observed
  const pending = [];       // queued Update objects not yet delivered to a getUpdates call
  let idlePoll = null;      // resolver of the in-flight "empty" long-poll, woken by an inject

  const notifyCalls = () => {
    for (let i = callWaiters.length - 1; i >= 0; i -= 1) {
      if (callWaiters[i].predicate(calls)) { callWaiters[i].resolve(calls); callWaiters.splice(i, 1); }
    }
  };
  const wakePoll = () => { if (idlePoll) { const r = idlePoll; idlePoll = null; r(); } };

  /** Queue an incoming private text message from a user. The next getUpdates delivers it. */
  function injectText({ text, userId, chatId, firstName = 'Tester', username = 'tester' }) {
    const cid = chatId ?? userId;
    const update = {
      update_id: ++updateSeq,
      message: {
        message_id: ++messageSeq,
        from: { id: userId, is_bot: false, first_name: firstName, username, language_code: 'en' },
        chat: { id: cid, type: 'private', first_name: firstName, username },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    };
    pending.push(update);
    wakePoll();
    return update;
  }

  /** The `result` for a modeled method (getUpdates handled separately). */
  function resultFor(method, params) {
    switch (method) {
      case 'getMe':
        return botUser;
      case 'sendMessage':
      case 'editMessageText':
        return {
          message_id: method === 'editMessageText' && params.message_id ? params.message_id : ++messageSeq,
          date: Math.floor(Date.now() / 1000),
          chat: { id: params.chat_id, type: 'private' },
          text: params.text ?? '',
          ...(botUser.id ? { from: botUser } : {}),
        };
      // deleteWebhook / setMyCommands / sendChatAction / setMessageReaction / answerCallbackQuery /
      // deleteMessage — and any method we did not model — return a realistic boolean result.
      default:
        return true;
    }
  }

  async function handleGetUpdates() {
    pollCount += 1;
    for (const r of pollWaiters.splice(0)) r();
    if (pending.length) return pending.splice(0, pending.length);
    // No queued updates: hold the long-poll briefly (woken instantly by an inject) instead of busy-looping.
    await new Promise((resolve) => {
      const timer = setTimeout(() => { if (idlePoll === resolve) idlePoll = null; resolve(); }, 250);
      if (typeof timer.unref === 'function') timer.unref();
      idlePoll = () => { clearTimeout(timer); resolve(); };
    });
    return pending.splice(0, pending.length);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = url.pathname.match(/\/bot[^/]+\/([A-Za-z]+)$/);
    const method = match ? match[1] : '';
    const params = await readJson(req);

    let result;
    if (method === 'getUpdates') {
      result = await handleGetUpdates(params);
    } else {
      calls.push({ method, params, at: Date.now() });
      notifyCalls();
      result = resultFor(method, params);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Telegram server did not bind a TCP port');
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`, // NO trailing slash — grammY rejects an apiRoot that ends in '/'
    port,
    botUser,
    calls,
    injectText,
    callsOf: (m) => calls.filter((c) => c.method === m),
    waitForCall(predicate, timeoutMs, label) {
      if (predicate(calls)) return Promise.resolve(calls);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve };
        const timer = setTimeout(() => {
          const idx = callWaiters.indexOf(entry);
          if (idx !== -1) callWaiters.splice(idx, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for: ${label}\ncalls so far: ${calls.map((c) => `${c.method}(${JSON.stringify(c.params?.text ?? '')})`).join(', ')}`));
        }, timeoutMs);
        entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
        callWaiters.push(entry);
      });
    },
    /** Resolve once the bot has issued a getUpdates poll — i.e. long-polling is live. */
    waitForPoll(timeoutMs) {
      if (pollCount > 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for the bot to start polling`)), timeoutMs);
        pollWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
    close() {
      wakePoll(); // release any in-flight long-poll so its response completes
      return new Promise((resolve) => {
        server.closeAllConnections?.(); // drop grammY's keep-alive sockets so close() doesn't hang
        server.close(() => resolve());
      });
    },
  };
}
