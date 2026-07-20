// A tiny fake Discord API for the Discord-adapter E2E suite: a REST surface (HTTP) plus a real gateway
// (WebSocket) — mirroring the fake Telegram Bot API, but over Discord's two transports.
//
// The Discord plugin is a dependency-free gateway client: it talks REST over `fetch` to `<apiBase><path>`
// (Bot-token auth) and holds a persistent gateway WebSocket. This fake implements exactly the surface the
// adapter drives:
//   REST:  GET /users/@me, GET /oauth2/applications/@me, PUT /applications/:id/commands (slash-command
//          registration), GET /channels/:id (channel meta), POST /channels/:id/messages (the bot's
//          replies — CAPTURED), PATCH .../messages/:mid (live edits — CAPTURED), POST /channels/:id/typing,
//          reaction PUT/DELETE, and POST /interactions/:id/:token/callback (slash-command replies —
//          CAPTURED). Any unmodeled route returns a realistic empty object.
//   Gateway: op 10 Hello → the adapter Identifies (op 2) → we dispatch READY (op 0). Heartbeats (op 1)
//          are ACKed (op 11). `injectMessage`/`injectInteraction` push MESSAGE_CREATE / INTERACTION_CREATE
//          dispatch frames so the adapter's own handlers run, exactly as a live gateway would drive them.
//
// SAFETY: binds ephemeral loopback ports (never 4400/4500), never reaches the real discord.com.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/** Read and JSON-parse a request body; tolerate an empty/garbage body (returns {}). */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Start the fake Discord API (REST server + gateway WS server) on ephemeral loopback ports.
 *
 * @param {object} [opts]
 * @param {string} [opts.botId]  The bot user id reported by GET /users/@me (default 'bot-e2e').
 * @param {string} [opts.appId]  The application id reported by GET /oauth2/applications/@me (default 'app-e2e').
 * @returns {Promise<{
 *   apiBase: string, gatewayUrl: string, botId: string, appId: string, calls: object[],
 *   injectMessage: (m: object) => object,
 *   injectInteraction: (i: object) => object,
 *   callsOf: (method: string, pathRe: RegExp) => object[],
 *   channelSends: () => object[],
 *   interactionReplies: () => object[],
 *   waitForCall: (predicate: (calls: object[]) => boolean, timeoutMs: number, label: string) => Promise<object[]>,
 *   waitForGateway: (timeoutMs: number) => Promise<void>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeDiscord(opts = {}) {
  const botId = opts.botId ?? 'bot-e2e';
  const appId = opts.appId ?? 'app-e2e';

  const calls = [];       // every captured REST call (GET meta reads included — they're cheap + few)
  const callWaiters = []; // { predicate, resolve } resolved as new calls land
  let msgSeq = 100000;

  const notifyCalls = () => {
    for (let i = callWaiters.length - 1; i >= 0; i -= 1) {
      if (callWaiters[i].predicate(calls)) { callWaiters[i].resolve(calls); callWaiters.splice(i, 1); }
    }
  };

  // ── REST server ──────────────────────────────────────────────────────────────────────────────────
  const rest = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const body = await readJson(req);
    calls.push({ method, path, body, at: Date.now() });
    notifyCalls();

    const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const noContent = () => { res.writeHead(204); res.end(); };

    // Identity / app.
    if (method === 'GET' && path === '/users/@me') return json({ id: botId, username: 'elowen_e2e', bot: true });
    if (method === 'GET' && path === '/oauth2/applications/@me') return json({ id: appId });
    // Slash-command registration (global or guild) — Discord returns the registered set; the adapter ignores it.
    if (method === 'PUT' && /^\/applications\/[^/]+\/(commands|guilds\/[^/]+\/commands)$/.test(path)) return json([]);
    // Channel metadata.
    if (method === 'GET' && /^\/channels\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      return json({ id, name: 'e2e-channel', topic: '', type: 0 });
    }
    // The bot's outgoing/edited messages — the reply capture. Return a message id so postAsk/edit chains work.
    if (method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(path)) return json({ id: `m${++msgSeq}` });
    if (method === 'PATCH' && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(path)) return json({ id: path.split('/')[4] });
    if (method === 'DELETE' && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(path)) return noContent();
    // Typing indicator + reaction add/remove — Discord answers 204.
    if (method === 'POST' && /^\/channels\/[^/]+\/typing$/.test(path)) return noContent();
    if ((method === 'PUT' || method === 'DELETE') && /\/reactions\//.test(path)) return noContent();
    // Interaction callback — the slash-command reply capture.
    if (method === 'POST' && /^\/interactions\/[^/]+\/[^/]+\/callback$/.test(path)) return noContent();
    // Deferred interaction edit (/compact path) — the webhook @original edit.
    if (method === 'PATCH' && /^\/webhooks\/[^/]+\/[^/]+\/messages\/@original$/.test(path)) return json({ id: `m${++msgSeq}` });

    // Anything unmodeled: a realistic empty object (never breaks rest()'s res.json()).
    return json({});
  });

  await new Promise((resolve, reject) => {
    rest.once('error', reject);
    rest.listen(0, '127.0.0.1', resolve);
  });
  const restAddr = rest.address();
  if (!restAddr || typeof restAddr === 'string') throw new Error('fake Discord REST server did not bind a TCP port');
  const restPort = restAddr.port;

  // ── Gateway WS server ────────────────────────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', resolve);
  });
  const wsPort = wss.address().port;

  let socket = null;             // the adapter's single gateway connection
  const gatewayWaiters = [];     // resolvers waiting for the adapter to Identify (gateway live)
  let identified = false;

  const dispatch = (t, d) => {
    if (!socket || socket.readyState !== socket.OPEN) throw new Error(`cannot dispatch ${t}: gateway not connected`);
    socket.send(JSON.stringify({ op: 0, t, s: null, d }));
  };

  wss.on('connection', (ws) => {
    socket = ws;
    // Hello: a long heartbeat interval keeps the fake quiet; op 1 is still ACKed below for correctness.
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.op === 1) { ws.send(JSON.stringify({ op: 11 })); return; } // heartbeat → ACK
      if (frame.op === 2 || frame.op === 6) { // Identify or Resume → READY/RESUMED
        if (frame.op === 2) {
          dispatch('READY', { session_id: 'e2e-session', resume_gateway_url: `ws://127.0.0.1:${wsPort}` });
          identified = true;
          for (const r of gatewayWaiters.splice(0)) r();
        } else {
          ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: null, d: {} }));
        }
      }
    });
  });

  return {
    apiBase: `http://127.0.0.1:${restPort}`,
    gatewayUrl: `ws://127.0.0.1:${wsPort}`,
    botId,
    appId,
    calls,
    /** Push a guild MESSAGE_CREATE so the adapter's real onMessage runs. */
    injectMessage(m) { dispatch('MESSAGE_CREATE', m); return m; },
    /** Push an INTERACTION_CREATE (slash command / component) so the adapter's real onInteraction runs. */
    injectInteraction(i) { dispatch('INTERACTION_CREATE', i); return i; },
    callsOf: (method, pathRe) => calls.filter((c) => c.method === method && pathRe.test(c.path)),
    /** Outgoing channel message POSTs — the bot's replies. */
    channelSends: () => calls.filter((c) => c.method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(c.path)),
    /** Slash-command interaction callback POSTs — the bot's ephemeral command replies. */
    interactionReplies: () => calls.filter((c) => c.method === 'POST' && /^\/interactions\/[^/]+\/[^/]+\/callback$/.test(c.path)),
    waitForCall(predicate, timeoutMs, label) {
      if (predicate(calls)) return Promise.resolve(calls);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve };
        const timer = setTimeout(() => {
          const idx = callWaiters.indexOf(entry);
          if (idx !== -1) callWaiters.splice(idx, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for: ${label}\ncalls so far: ${calls.map((c) => `${c.method} ${c.path}`).join(', ')}`));
        }, timeoutMs);
        entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
        callWaiters.push(entry);
      });
    },
    /** Resolve once the adapter has connected + Identified — i.e. the gateway is live and can be driven. */
    waitForGateway(timeoutMs) {
      if (identified) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for the gateway Identify`)), timeoutMs);
        gatewayWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
    close() {
      return new Promise((resolve) => {
        try { socket?.close(); } catch { /* already closed */ }
        wss.close(() => {
          rest.closeAllConnections?.();
          rest.close(() => resolve());
        });
      });
    },
  };
}
