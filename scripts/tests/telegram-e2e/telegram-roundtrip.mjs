#!/usr/bin/env node
// Telegram chat-adapter E2E scenario against a REAL built daemon + the REAL Telegram plugin.
//
// Wiring under test (the just-refactored plugins/_shared cores had no end-to-end coverage):
//   fake Telegram Bot API  ──getUpdates──▶  real telegram plugin (grammY, pointed at the fake via the
//   `apiRoot` seam)  ──▶  PlatformOrchestrator  ──▶  real brain channel session  ──▶  scripted OpenAI
//   model server  ──▶  streamed reply  ──▶  the bot's sendMessage/editMessageText, captured on the fake.
//
// Boots via the #1 brain-e2e harness (real dist/daemon on a throwaway port + temp DB/HOME + injected
// provider). The telegram plugin is configured (botToken + apiRoot + an admin rolePolicy) over PUT /config
// and switched on over PATCH /plugins/telegram, which hot-reloads the registry so the adapter connects.
//
// Scenarios:
//   1. A private text message round-trips to the brain and the reply is sent back as Telegram plain text
//      (no parse_mode / no markdown escaping — the shared live-trace `style` is all-identity for Telegram).
//   2. /status through the shared runControlCommand core (a real session exists → the status line).
//   3. /new (fresh conversation) and /fast — with a bogus arg (the `fastUsage` fallthrough that was a real
//      bug), with `off`, and with `on` (the fastAvailable gate) — all through the shared core.
//   4. TEETH: a provider error surfaces as the bot's "⚠️ …" error reply.
// Every wait is deadline-bounded on the fake's captured calls — no sleep-based flakiness.
//
// SAFETY: throwaway ports (harness auto-selects; the fake binds an ephemeral loopback port), temp dirs
// under os.tmpdir(), full teardown in finally. Never touches the prod DB/config/ports/services.

import { startModelServer } from '../brain-e2e/model-server.mjs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { startFakeTelegram } from './fake-telegram.mjs';

const USER_ID = 4242424242;   // the Telegram sender (also the private chat id)
const REPLY_MARKER = 'E2E-TELEGRAM-REPLY';
const FIRST_TEXT = 'Right away. ';
const FINAL_TEXT = `${REPLY_MARKER}: hello from the Elowen brain.`;

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function put(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function patch(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** The text of every sendMessage the bot issued (the plain-text replies the adapter posts). */
const sentTexts = (fake) => fake.callsOf('sendMessage').map((c) => c.params?.text ?? '');

/** Inject a message and wait until the bot posts a sendMessage whose text satisfies `pred`. Returns the
 *  first matching call's params. Deadline-bounded — a missing reply fails loudly. */
async function expectReply(fake, inject, pred, label, timeoutMs = 45_000) {
  const before = fake.callsOf('sendMessage').length;
  fake.injectText({ text: inject, userId: USER_ID });
  await fake.waitForCall(
    (calls) => calls.filter((c) => c.method === 'sendMessage').slice(before).some((c) => pred(c.params?.text ?? '')),
    timeoutMs,
    `${label} (sent so far: ${JSON.stringify(sentTexts(fake))})`,
  );
  return fake.callsOf('sendMessage').slice(before).find((c) => pred(c.params?.text ?? '')).params;
}

async function main() {
  const model = await startModelServer({ toolName: null, firstText: FIRST_TEXT, finalText: FINAL_TEXT });
  const fake = await startFakeTelegram();
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;
    console.log(`daemon up on ${baseUrl}; model on ${model.baseUrl}; fake Telegram on ${fake.baseUrl}`);

    // 1) Configure the telegram plugin: botToken (required), the apiRoot seam pointed at the fake, an
    //    admin rolePolicy for our sender (so control commands are permitted), plain-text 'en' service texts.
    //    PUT /config stores the plugin-config slice unfiltered (ctx.config → this.cfg.apiRoot); it does NOT
    //    reload plugins on its own.
    const cfg = await put(baseUrl, '/config', token, {
      plugins: {
        config: {
          telegram: {
            botToken: 'e2e-telegram-token',
            apiRoot: fake.baseUrl,
            language: 'en',
            reactions: true,
            rolePolicies: [{ roleId: String(USER_ID), admin: true, projectIds: [] }],
          },
        },
      },
    });
    assert(cfg.status === 200, `PUT /config → 200 (got ${cfg.status}: ${cfg.text})`);

    // 2) Enable the plugin — PATCH /plugins/:name hot-reloads the registry, so the adapter connects to the
    //    fake (getMe → deleteWebhook → getUpdates) using the config just stored.
    const enable = await patch(baseUrl, '/plugins/telegram', token, { enabled: true });
    assert(enable.status === 200, `PATCH /plugins/telegram → 200 (got ${enable.status}: ${enable.text})`);

    // Confirm the plugin actually started listening against our fake.
    await fake.waitForCall((calls) => calls.some((c) => c.method === 'getMe'), 20_000, 'bot getMe (init)');
    await fake.waitForCall((calls) => calls.some((c) => c.method === 'setMyCommands'), 20_000, 'publishCommands (setMyCommands)');
    await fake.waitForPoll(20_000);
    const setCmds = fake.callsOf('setMyCommands')[0];
    assert(Array.isArray(setCmds?.params?.commands) && setCmds.params.commands.some((c) => c.command === 'fast'),
      'setMyCommands published the shared command menu (incl. /fast)');
    console.log('PASS wiring: telegram plugin connected to the fake Bot API and is long-polling.');

    // ── Scenario 1: real message round-trip ──────────────────────────────────────────────────────────
    const replyParams = await expectReply(fake, 'Hi Elowen, are you there?', (t) => t.includes(REPLY_MARKER), 'brain reply round-trip');
    assert(replyParams.parse_mode === undefined, `reply is plain text — no parse_mode (got ${JSON.stringify(replyParams.parse_mode)})`);
    assert(String(replyParams.chat_id) === String(USER_ID), `reply targets the sender's chat (got ${replyParams.chat_id})`);
    // The model streamed two accumulating deltas; both must be present in the posted reply.
    assert(replyParams.text.includes(FINAL_TEXT), `reply carries the model's final text; got "${replyParams.text}"`);
    // Telegram-correct formatting: the plain-text surface never Discord-escapes (no backslash-escapes here).
    assert(!/\\[_*[\]()~`>#+=|{}.!-]/.test(replyParams.text), `no Discord-style backslash escaping in the reply; got "${replyParams.text}"`);
    // The adapter also drove the typing indicator over the same fake transport.
    assert(fake.callsOf('sendChatAction').some((c) => c.params?.action === 'typing'), 'sent a typing chat action');
    // At least two model requests? No — no-tool mode is a single request. Assert the model actually ran once.
    assert(model.requests.length >= 1, `model server served the turn (>=1 request), got ${model.requests.length}`);
    console.log('PASS scenario 1: message round-tripped through the real brain; reply posted as Telegram plain text.');

    // ── Scenario 2: /status through the shared control core (a live session now exists) ───────────────
    const statusParams = await expectReply(fake, '/status', (t) => t.startsWith('🧠') && /Context/.test(t), '/status reply');
    assert(statusParams.text.includes('mock-model'), `/status reports the model; got "${statusParams.text}"`);
    console.log('PASS scenario 2: /status via runControlCommand returned the live model + context line.');

    // ── Scenario 3: /new + /fast (shared control core) ───────────────────────────────────────────────
    await expectReply(fake, '/new', (t) => t.includes('Fresh conversation started'), '/new reply');
    // The fastUsage fallthrough that was a real bug: a bogus arg must reply with the usage hint, NOT toggle.
    await expectReply(fake, '/fast wat', (t) => t === 'Usage: /fast, /fast on, or /fast off.', '/fast <bogus> → usage hint');
    // /fast off is switchable even on a non-OAuth model (the stale-fast-off path).
    await expectReply(fake, '/fast off', (t) => t.includes('Fast mode is off'), '/fast off reply');
    // /fast on hits the fastAvailable gate (our provider is a plain API key, not OpenAI OAuth).
    await expectReply(fake, '/fast on', (t) => /priority|OAuth|not available|unavailable|není/i.test(t), '/fast on → unavailable gate');
    console.log('PASS scenario 3: /new resets the conversation; /fast usage/off/on all routed through the shared core.');

    // ── Scenario 4: TEETH — a provider failure surfaces as the bot's error reply ─────────────────────
    model.setFail(true);
    const errParams = await expectReply(fake, 'This turn must fail.', (t) => t.startsWith('⚠️'), 'error reply on provider failure');
    assert(errParams.parse_mode === undefined, 'error reply is plain text too');
    console.log('PASS teeth: an injected provider error surfaced as the bot\'s "⚠️ …" reply.');
  } finally {
    if (daemon) await daemon.stop();
    await fake.close();
    await model.close();
  }
}

main().then(() => {
  console.log('PASS test:e2e:telegram — real daemon + real telegram plugin + fake Bot API verified.');
  process.exit(0);
}).catch((err) => {
  console.error(`FAIL test:e2e:telegram — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
