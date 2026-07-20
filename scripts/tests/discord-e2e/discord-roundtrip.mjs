#!/usr/bin/env node
// Discord chat-adapter E2E scenario against a REAL built daemon + the REAL Discord plugin.
//
// Wiring under test (the shared plugins/_shared cores over the Discord surface — REST + gateway, distinct
// from Telegram's grammY long-poll):
//   fake Discord gateway (WS)  ──MESSAGE_CREATE / INTERACTION_CREATE──▶  real discord plugin (pointed at the
//   fake via the `apiBase` + `gatewayUrl` seam)  ──▶  PlatformOrchestrator  ──▶  real brain channel session
//   ──▶  scripted OpenAI model server  ──▶  streamed reply  ──▶  the bot's POST /channels/:id/messages and
//   interaction callbacks, captured on the fake REST server.
//
// Boots via the #1 brain-e2e harness (real dist/daemon on a throwaway port + temp DB/HOME + injected
// provider). The discord plugin is configured (botToken + apiBase + gatewayUrl + an admin rolePolicy) over
// PUT /config and switched on over PATCH /plugins/discord, which hot-reloads the registry so the adapter
// connects to the fake (GET /users/@me → register slash commands → gateway Identify).
//
// Scenarios:
//   1. A guild text message round-trips to the brain and the reply is POSTed back as a real Discord reply
//      (message_reference to the trigger — a Discord-specific behavior Telegram's plain sendMessage lacks).
//   2. /status as a SLASH-COMMAND interaction through the shared runControlCommand core → an ephemeral
//      (flags 64) interaction callback carrying markdown-bold `**mock-model**` (Discord-specific formatting).
//   3. /new + /fast off + /fast on — all as slash interactions routed through the shared control core.
//   4. TEETH: a provider error surfaces as the bot's "⚠️ …" channel reply.
// Every wait is deadline-bounded on the fake's captured calls — no sleep-based flakiness.
//
// SAFETY: throwaway ports (harness auto-selects; the fake binds ephemeral loopback ports), temp dirs under
// os.tmpdir(), full teardown in finally. Never touches the prod DB/config/ports/services.

import { startModelServer } from '../brain-e2e/model-server.mjs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { startFakeDiscord } from './fake-discord.mjs';

const GUILD_ID = '7000000000000001';
const CHANNEL_ID = '9000000000000001';
const USER_ID = '4242424242424242';
const ROLE_ID = '5550000000000001'; // mapped admin:true in the rolePolicy below
const REPLY_MARKER = 'E2E-DISCORD-REPLY';
const FIRST_TEXT = 'Right away. ';
const FINAL_TEXT = `${REPLY_MARKER}: hello from the Elowen brain.`;

let idSeq = 0;
const nextId = () => `${Date.now()}${(idSeq += 1)}`;

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
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

/** A guild MESSAGE_CREATE payload from our admin sender in the test channel. */
function messageFrame(text) {
  return {
    id: nextId(),
    type: 0,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    content: text,
    author: { id: USER_ID, username: 'tester', global_name: 'Tester', bot: false },
    member: { roles: [ROLE_ID], nick: 'Tester' },
    mentions: [],
    attachments: [],
  };
}

/** A slash-command INTERACTION_CREATE (type 2) from our admin sender. */
function slashFrame(name, options) {
  return {
    id: nextId(),
    token: `tok-${nextId()}`,
    type: 2,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: { user: { id: USER_ID, username: 'tester' }, roles: [ROLE_ID] },
    data: { name, ...(options ? { options } : {}) },
  };
}

/** Inject a message and wait until the bot POSTs a channel message whose body satisfies `pred`. */
async function expectChannelSend(fake, text, pred, label, timeoutMs = 45_000) {
  const before = fake.channelSends().length;
  fake.injectMessage(messageFrame(text));
  await fake.waitForCall(
    () => fake.channelSends().slice(before).some((c) => pred(c.body ?? {})),
    timeoutMs,
    `${label} (sends so far: ${JSON.stringify(fake.channelSends().map((c) => c.body?.content))})`,
  );
  return fake.channelSends().slice(before).find((c) => pred(c.body ?? {})).body;
}

/** Inject a slash command and wait until its interaction callback content satisfies `pred`. */
async function expectInteractionReply(fake, name, options, pred, label, timeoutMs = 30_000) {
  const before = fake.interactionReplies().length;
  fake.injectInteraction(slashFrame(name, options));
  await fake.waitForCall(
    () => fake.interactionReplies().slice(before).some((c) => pred(String(c.body?.data?.content ?? ''))),
    timeoutMs,
    `${label} (replies so far: ${JSON.stringify(fake.interactionReplies().map((c) => c.body?.data?.content))})`,
  );
  return fake.interactionReplies().slice(before).find((c) => pred(String(c.body?.data?.content ?? ''))).body;
}

async function main() {
  const model = await startModelServer({ toolName: null, firstText: FIRST_TEXT, finalText: FINAL_TEXT });
  const fake = await startFakeDiscord();
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;
    console.log(`daemon up on ${baseUrl}; model on ${model.baseUrl}; fake Discord REST ${fake.apiBase} / gateway ${fake.gatewayUrl}`);

    // 1) Configure the discord plugin: botToken (required), the apiBase + gatewayUrl seams pointed at the
    //    fake, an admin rolePolicy for our sender's role, 'en' service texts. PUT /config stores the
    //    plugin-config slice unfiltered (→ adapter cfg); it does NOT reload plugins on its own.
    const cfg = await put(baseUrl, '/config', token, {
      plugins: {
        config: {
          discord: {
            botToken: 'e2e-discord-token',
            apiBase: fake.apiBase,
            gatewayUrl: fake.gatewayUrl,
            language: 'en',
            reactions: true,
            rolePolicies: [{ roleId: ROLE_ID, name: 'Operator', admin: true, projectIds: [] }],
          },
        },
      },
    });
    assert(cfg.status === 200, `PUT /config → 200 (got ${cfg.status}: ${cfg.text})`);

    // 2) Enable the plugin — PATCH /plugins/:name hot-reloads the registry, so the adapter connects to the
    //    fake: GET /users/@me → register slash commands → open the gateway and Identify.
    const enable = await patch(baseUrl, '/plugins/discord', token, { enabled: true });
    assert(enable.status === 200, `PATCH /plugins/discord → 200 (got ${enable.status}: ${enable.text})`);

    // Confirm the plugin actually connected against our fake.
    await fake.waitForCall((calls) => calls.some((c) => c.method === 'GET' && c.path === '/users/@me'), 20_000, 'bot GET /users/@me (connect)');
    await fake.waitForCall(
      (calls) => calls.some((c) => c.method === 'PUT' && /^\/applications\/[^/]+\/commands$/.test(c.path)),
      20_000, 'slash-command registration (PUT /applications/:id/commands)',
    );
    await fake.waitForGateway(20_000);
    const reg = fake.callsOf('PUT', /^\/applications\/[^/]+\/commands$/)[0];
    assert(Array.isArray(reg?.body) && reg.body.some((c) => c.name === 'fast' && c.type === 1),
      'slash-command registration published the shared command menu (incl. /fast as CHAT_INPUT)');
    console.log('PASS wiring: discord plugin connected to the fake REST + gateway and registered slash commands.');

    // ── Scenario 1: real message round-trip ──────────────────────────────────────────────────────────
    const reply = await expectChannelSend(fake, 'Hi Elowen, are you there?', (b) => String(b.content ?? '').includes(REPLY_MARKER), 'brain reply round-trip');
    assert(reply.content.includes(FINAL_TEXT), `reply carries the model's final text; got "${reply.content}"`);
    // Discord-correct behavior: the answer is a real REPLY to the triggering message (message_reference),
    // which Telegram's plain sendMessage does not carry.
    assert(reply.message_reference && typeof reply.message_reference.message_id === 'string',
      `reply is a Discord reply (message_reference present); got ${JSON.stringify(reply.message_reference)}`);
    assert(reply.message_reference.fail_if_not_exists === false, 'reply reference degrades gracefully (fail_if_not_exists:false)');
    assert(model.requests.length >= 1, `model server served the turn (>=1 request), got ${model.requests.length}`);
    console.log('PASS scenario 1: message round-tripped through the real brain; reply POSTed as a Discord reply.');

    // ── Scenario 2: /status slash command through the shared control core (a live session now exists) ──
    const statusBody = await expectInteractionReply(fake, 'status', undefined, (t) => t.includes('mock-model') && /Context/.test(t), '/status interaction reply');
    assert(statusBody.type === 4, `/status answered with an immediate interaction callback (type 4); got ${statusBody.type}`);
    assert(statusBody.data?.flags === 64, `/status reply is ephemeral (flags 64); got ${statusBody.data?.flags}`);
    // Discord-specific formatting: the status line wraps the model in markdown bold — Telegram's is plain text.
    assert(/\*\*[^*]*mock-model[^*]*\*\*/.test(String(statusBody.data.content)), `/status uses Discord markdown bold around the model; got "${statusBody.data.content}"`);
    console.log('PASS scenario 2: /status via runControlCommand returned an ephemeral, markdown-bold live status.');

    // ── Scenario 3: /new + /fast (shared control core, over slash interactions) ───────────────────────
    await expectInteractionReply(fake, 'new', undefined, (t) => t.includes('Fresh conversation started'), '/new interaction reply');
    // /fast off is switchable even on a non-OAuth model (the stale-fast-off path) — Discord bold on "off".
    await expectInteractionReply(fake, 'fast', [{ name: 'state', value: 'off' }], (t) => t.includes('**off**'), '/fast off interaction reply');
    // /fast on hits the fastAvailable gate (our provider is a plain API key, not OpenAI OAuth).
    await expectInteractionReply(fake, 'fast', [{ name: 'state', value: 'on' }], (t) => /OAuth|not available|unavailable/i.test(t), '/fast on → unavailable gate');
    console.log('PASS scenario 3: /new resets the conversation; /fast off/on both routed through the shared core.');

    // ── Scenario 4: TEETH — a provider failure surfaces as the bot's error reply ─────────────────────
    model.setFail(true);
    const errBody = await expectChannelSend(fake, 'This turn must fail.', (b) => String(b.content ?? '').startsWith('⚠️'), 'error reply on provider failure');
    assert(errBody.content.startsWith('⚠️'), `error reply starts with the warning glyph; got "${errBody.content}"`);
    console.log('PASS teeth: an injected provider error surfaced as the bot\'s "⚠️ …" reply.');
  } finally {
    if (daemon) await daemon.stop();
    await fake.close();
    await model.close();
  }
}

main().then(() => {
  console.log('PASS test:e2e:discord — real daemon + real discord plugin + fake REST/gateway verified.');
  process.exit(0);
}).catch((err) => {
  console.error(`FAIL test:e2e:discord — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
