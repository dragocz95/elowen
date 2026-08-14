#!/usr/bin/env node
// WhatsApp chat-adapter E2E scenario against a REAL built daemon + the REAL WhatsApp plugin.
//
// Wiring under test (the shared shared elowen-plugin-shared cores over the hardest surface — Baileys):
//   scripted inbound text  ──HTTP bridge──▶  fake in-process Baileys socket (loaded INSIDE the daemon via
//   the adapter's `WHATSAPP_E2E_SOCKET_MODULE` seam)  ──messages.upsert──▶  real whatsapp adapter
//   ──▶  PlatformOrchestrator  ──▶  real brain channel session  ──▶  scripted OpenAI model server  ──▶
//   streamed reply  ──▶  the adapter's sock.sendMessage, captured on the fake and read back over the bridge.
//
// Why a bridge and not a wire fake (as Telegram/Discord use): Baileys speaks an ENCRYPTED Noise-protocol
// WebSocket with Signal E2E encryption + QR/multi-device pairing — there is no wire to fake without
// reimplementing Signal. The smallest faithful seam is therefore a socket-factory override that hands the
// adapter a fake "connected" socket, skipping only auth/pairing while the entire inbound→brain→outbound
// pipeline runs for real. The fake lives in the daemon process, so an HTTP bridge carries injects/captures
// out to this runner. `useMultiFileAuthState` (local file IO, no network) still runs — it is harmless.
//
// Boots via the #1 brain-e2e harness (real dist/daemon on a throwaway port + temp DB/HOME + injected
// provider). The whatsapp plugin is configured (an admin senderPolicy for our number) over PUT /config and
// switched on over PATCH /plugins/whatsapp, which hot-reloads the registry so the adapter "connects".
//
// Scenarios:
//   1. A private text message round-trips to the brain and the reply is SENT back via sock.sendMessage to
//      the sender's JID, as WhatsApp-correct text (single-asterisk `*bold*`, never Discord's `**` / no
//      Discord backslash escaping), quoting the trigger — plus the 👀/✅ status reactions & typing presence.
//   2. /status through the shared runControlCommand core (a live session exists → the status line, with the
//      model wrapped in WhatsApp single-asterisk bold).
//   3. /new (fresh conversation) + /fast — bogus arg (the fastUsage fallthrough), `off`, and `on` (the
//      fastAvailable gate) — all routed through the shared control core.
//   4. TEETH: a provider error surfaces as the adapter's "⚠️ …" error reply. (A control-handler regression
//      trips a scenario-2/3 assertion and fails loudly.)
// Every wait is deadline-bounded on the bridge-captured calls — no sleep-based flakiness.
//
// SAFETY: throwaway ports (harness auto-selects; the bridge binds an ephemeral loopback port), temp dirs
// under os.tmpdir(), full teardown in finally. Never touches the prod DB/config/ports/services.

import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelServer } from '../brain-e2e/model-server.mjs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOCKET_MODULE = join(here, 'fake-baileys-socket.mjs');

const USER_NUMBER = '4242424242';
const USER_JID = `${USER_NUMBER}@s.whatsapp.net`; // the private chat is keyed by the sender's JID
const BOT_JID = '10000000001@s.whatsapp.net';
const REPLY_MARKER = 'E2E-WHATSAPP-REPLY';
const FIRST_TEXT = 'Right away. ';
const FINAL_TEXT = `${REPLY_MARKER}: hello from the Elowen brain.`;

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free loopback TCP port (bind :0, read it back) — never collides with prod's 4400/4500. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error('no free port'))));
    });
  });
}

async function put(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function patch(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** A thin client over the in-daemon fake-socket bridge: inject inbound texts, read captured sock calls. */
function bridgeClient(bridgeUrl) {
  const getCalls = async () => {
    const res = await fetch(`${bridgeUrl}/calls`);
    if (!res.ok) throw new Error(`bridge /calls → HTTP ${res.status}`);
    return (await res.json()).calls ?? [];
  };
  return {
    async health() {
      try {
        const res = await fetch(`${bridgeUrl}/health`);
        return res.ok ? await res.json() : null;
      } catch { return null; }
    },
    async waitConnected(timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const h = await this.health();
        if (h?.connected) return;
        await sleep(100);
      }
      throw new Error(`fake socket did not connect within ${timeoutMs}ms (bridge unreachable or adapter not started)`);
    },
    async injectText(text) {
      const res = await fetch(`${bridgeUrl}/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jid: USER_JID, text, pushName: 'Tester' }),
      });
      if (!res.ok) throw new Error(`bridge /inject → HTTP ${res.status}`);
    },
    getCalls,
    /** All text-message sends (excludes reactions/edits/presence) to the sender's chat. */
    async textSends() {
      return (await getCalls()).filter((c) => c.method === 'sendMessage' && c.kind === 'text');
    },
    /** Inject `text`, then wait until a NEW text send matches `pred`. Deadline-bounded — a miss fails loud. */
    async expectReply(text, pred, label, timeoutMs = 45_000) {
      const before = (await this.textSends()).length;
      await this.injectText(text);
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const fresh = (await this.textSends()).slice(before);
        const hit = fresh.find((c) => pred(c.text ?? ''));
        if (hit) return hit;
        await sleep(120);
      }
      const seen = (await this.textSends()).slice(before).map((c) => c.text);
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}\ntext sends since: ${JSON.stringify(seen)}`);
    },
  };
}

async function main() {
  const model = await startModelServer({ toolName: null, firstText: FIRST_TEXT, finalText: FINAL_TEXT });
  const bridgePort = await freePort();
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  const bridge = bridgeClient(bridgeUrl);

  // The seam env-vars ride through spawnRealDaemon's env filter (it drops only ELOWEN_*/XDG/CLAUDE/CODEX);
  // these non-ELOWEN names are inherited by the daemon child, where the adapter reads them.
  process.env.WHATSAPP_E2E_SOCKET_MODULE = SOCKET_MODULE;
  process.env.WHATSAPP_E2E_BRIDGE_PORT = String(bridgePort);
  process.env.WHATSAPP_E2E_BOT_JID = BOT_JID;

  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;
    console.log(`daemon up on ${baseUrl}; model on ${model.baseUrl}; fake WhatsApp bridge on ${bridgeUrl}`);

    // 1) Configure the whatsapp plugin: an admin senderPolicy for our number (so control commands are
    //    permitted) + plain 'en' service texts. PUT /config stores the plugin-config slice; it does NOT
    //    reload plugins on its own.
    const cfg = await put(baseUrl, '/config', token, {
      plugins: {
        config: {
          whatsapp: {
            language: 'en',
            reactions: true,
            streaming: true,
            senderPolicies: [{ roleId: USER_NUMBER, admin: true, projectIds: [] }],
          },
        },
      },
    });
    assert(cfg.status === 200, `PUT /config → 200 (got ${cfg.status}: ${cfg.text})`);

    // 2) Enable the plugin — PATCH /plugins/:name hot-reloads the registry, so the adapter runs connect() →
    //    startSocket(), which (via the seam) builds the fake socket and emits connection.update 'open'.
    const enable = await patch(baseUrl, '/plugins/whatsapp', token, { enabled: true });
    assert(enable.status === 200, `PATCH /plugins/whatsapp → 200 (got ${enable.status}: ${enable.text})`);

    // Wiring proof: the fake socket was constructed (seam used) and the bridge is live.
    await bridge.waitConnected(20_000);
    console.log('PASS wiring: whatsapp adapter built the fake socket via the seam and is "connected".');

    // ── Scenario 1: real message round-trip ──────────────────────────────────────────────────────────
    const reply = await bridge.expectReply('Hi Elowen, are you there?', (t) => t.includes(REPLY_MARKER), 'brain reply round-trip');
    assert(reply.jid === USER_JID, `reply targets the sender's JID (got ${reply.jid})`);
    assert(reply.text.includes(FINAL_TEXT), `reply carries the model's final text; got "${reply.text}"`);
    assert(reply.quoted === true, 'the answer quotes the triggering message (WhatsApp reply-quote)');
    // WhatsApp-correct formatting: single-asterisk emphasis only — never Discord's `**bold**`, and no
    // Discord-style backslash escaping of markdown punctuation.
    assert(!/\*\*/.test(reply.text), `no Discord-style double-asterisk bold in the reply; got "${reply.text}"`);
    assert(!/\\[_*[\]()~`>#+=|{}.!-]/.test(reply.text), `no Discord-style backslash escaping; got "${reply.text}"`);
    // The adapter drove the typing indicator and the status reactions over the same fake socket.
    const calls = await bridge.getCalls();
    assert(calls.some((c) => c.method === 'sendPresenceUpdate' && c.presence === 'composing'), 'drove a composing presence');
    assert(calls.some((c) => c.method === 'sendMessage' && c.kind === 'react' && c.react === '👀'), 'sent the 👀 thinking reaction');
    assert(calls.some((c) => c.method === 'sendMessage' && c.kind === 'react' && c.react === '✅'), 'sent the ✅ done reaction');
    assert(model.requests.length >= 1, `model server served the turn (>=1 request), got ${model.requests.length}`);
    console.log('PASS scenario 1: message round-tripped through the real brain; reply sent as WhatsApp text (quoted).');

    // ── Scenario 2: /status through the shared control core (a live session now exists) ───────────────
    const status = await bridge.expectReply('/status', (t) => t.startsWith('🧠') && /Context/.test(t), '/status reply');
    assert(status.text.includes('mock-model'), `/status reports the model; got "${status.text}"`);
    // WhatsApp-specific formatting: single-asterisk bold around the model — never Discord's double asterisk.
    assert(/\*[^*]*mock-model[^*]*\*/.test(status.text), `/status uses WhatsApp single-asterisk bold; got "${status.text}"`);
    assert(!/\*\*[^*]*mock-model[^*]*\*\*/.test(status.text), `/status does NOT use Discord double-asterisk bold; got "${status.text}"`);
    console.log('PASS scenario 2: /status via runControlCommand returned the live model + context line.');

    // ── Scenario 3: /new + /fast (shared control core) ───────────────────────────────────────────────
    await bridge.expectReply('/new', (t) => t.includes('Fresh conversation started'), '/new reply');
    // The fastUsage fallthrough: a bogus arg must reply with the usage hint, NOT toggle.
    await bridge.expectReply('/fast wat', (t) => t.startsWith('Usage:') && t.includes('/fast'), '/fast <bogus> → usage hint');
    // /fast off is switchable even on a non-OAuth model (the stale-fast-off path).
    await bridge.expectReply('/fast off', (t) => t.includes('Fast mode is') && t.includes('off'), '/fast off reply');
    // /fast on hits the fastAvailable gate (our provider is a plain API key, not OpenAI OAuth).
    await bridge.expectReply('/fast on', (t) => /OAuth|not available|unavailable/i.test(t), '/fast on → unavailable gate');
    console.log('PASS scenario 3: /new resets the conversation; /fast usage/off/on all routed through the shared core.');

    // ── Scenario 4: TEETH — a provider failure surfaces as the adapter's error reply ─────────────────
    model.setFail(true);
    const err = await bridge.expectReply('This turn must fail.', (t) => t.startsWith('⚠️'), 'error reply on provider failure');
    assert(err.jid === USER_JID, `error reply targets the sender's JID (got ${err.jid})`);
    console.log('PASS teeth: an injected provider error surfaced as the adapter\'s "⚠️ …" reply.');
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

main().then(() => {
  console.log('PASS test:e2e:whatsapp — real daemon + real whatsapp plugin + fake Baileys socket verified.');
  process.exit(0);
}).catch((err) => {
  console.error(`FAIL test:e2e:whatsapp — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
