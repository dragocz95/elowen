#!/usr/bin/env node
// Teams chat-adapter E2E scenario against a REAL built daemon + the REAL msteams plugin.
//
// Wiring under test (the shared shared elowen-plugin-shared cores over the Bot Framework surface — an inbound
// signed webhook + outbound Connector REST, distinct from Discord's gateway and Telegram's long-poll):
//   fake Bot Framework ──signed activity POST /hooks/msteams/messages──▶ real msteams plugin (JWT
//   verified against the fake's JWKS via the `openIdMetadataUrl` seam) ──▶ PlatformOrchestrator ──▶
//   real brain channel session ──▶ scripted OpenAI model server ──▶ the bot's Connector replies /
//   live-trace PUT edits, captured on the fake (its base = the activities' `serviceUrl`).
//
// Boots via the #1 brain-e2e harness (real dist/daemon on a throwaway port + temp DB/HOME + injected
// provider). The msteams plugin is configured over PUT /config (credentials + both fake seams + an
// admin rolePolicy) and switched on over PATCH /plugins/msteams, which hot-reloads the registry.
//
// Scenarios:
//   1. A signed message activity is accepted (200 under Microsoft's 15s callback deadline), round-trips
//      to the brain, and the reply arrives ASYNC through the Connector as a THREADED reply — with a live
//      tool trace edited in place (PUT) along the way, Teams' equivalent of Discord's edit stream.
//   2. /status through the shared runControlCommand core → the live model + context line.
//   3. TEETH: an activity with a garbage JWT bounces at the webhook (401) and never reaches the brain.
//   4. TEETH: a provider failure surfaces as the bot's "⚠️ …" reply.
// Every wait is deadline-bounded on the fake's captured calls — no sleep-based flakiness.
//
// SAFETY: throwaway ports (harness auto-selects; the fake binds an ephemeral loopback port), temp dirs
// under os.tmpdir(), full teardown in finally. Never touches the prod DB/config/ports/services.

import { startModelServer } from '../brain-e2e/model-server.mjs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { startFakeBotFramework } from './fake-botframework.mjs';

const CONV_ID = 'a:e2e-conv-1';
const AAD_ID = 'e2e-aad-1';
const REPLY_MARKER = 'E2E-MSTEAMS-REPLY';
const FIRST_TEXT = 'Checking the missions. ';
const FINAL_TEXT = `${REPLY_MARKER}: hello from the Elowen brain.`;

let idSeq = 0;
const nextId = () => `in-${Date.now()}-${(idSeq += 1)}`;

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

/** A personal-chat message activity from our admin sender. */
function messageActivity(text) {
  return {
    type: 'message',
    id: nextId(),
    from: { id: '29:e2e-user', aadObjectId: AAD_ID, name: 'E2E Tester' },
    recipient: { id: '28:e2e-app-id', name: 'Elowen' },
    conversation: { id: CONV_ID, conversationType: 'personal', tenantId: 'e2e-tenant' },
    text,
  };
}

/** Inject a message and wait until the bot posts a reply whose text satisfies `pred`. */
async function expectReply(fake, daemonBase, text, pred, label, timeoutMs = 45_000) {
  const before = fake.replies().length;
  const status = await fake.injectActivity(daemonBase, messageActivity(text));
  assert(status === 200, `${label}: webhook accepted the signed activity (got ${status})`);
  await fake.waitForCall(
    () => fake.replies().slice(before).some((c) => pred(String(c.body?.text ?? ''))),
    timeoutMs,
    `${label} (replies so far: ${JSON.stringify(fake.replies().map((c) => c.body?.text))})`,
  );
  return fake.replies().slice(before).find((c) => pred(String(c.body?.text ?? ''))).body;
}

async function main() {
  // The scripted tool name is deliberately UNKNOWN to the daemon: the unknown-tool error result is the
  // one deterministic way a channel turn edits its trace bubble in place (the "needs attention" row).
  // The old default (ElowenListMissions) only produced that edit by accident — the tool was absent from
  // channel sessions pre-extraction; the agents plugin now composes it everywhere and refuses with a
  // clean text result, whose hidden output re-renders the row identically (no PUT to observe).
  const model = await startModelServer({ toolName: 'E2eProbeMissingTool', firstText: FIRST_TEXT, finalText: FINAL_TEXT });
  const fake = await startFakeBotFramework();
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;
    console.log(`daemon up on ${baseUrl}; model on ${model.baseUrl}; fake Bot Framework ${fake.base}`);

    // 1) Configure the msteams plugin: credentials (required), both fake seams, an admin rolePolicy for
    //    our sender's Entra object id. PUT /config stores the plugin-config slice; no reload on its own.
    const cfg = await put(baseUrl, '/config', token, {
      plugins: {
        config: {
          msteams: {
            appId: fake.appId,
            appPassword: 'e2e-secret',
            tenantId: 'e2e-tenant',
            oauthTokenUrl: fake.tokenUrl,
            openIdMetadataUrl: fake.metadataUrl,
            language: 'en',
            rolePolicies: [{ roleId: AAD_ID, name: 'Operator', admin: true, projectIds: [] }],
          },
        },
      },
    });
    assert(cfg.status === 200, `PUT /config → 200 (got ${cfg.status}: ${cfg.text})`);

    // 2) Enable the plugin — PATCH /plugins/:name hot-reloads the registry; the adapter validates the
    //    credentials eagerly against the fake token endpoint.
    const enable = await patch(baseUrl, '/plugins/msteams', token, { enabled: true });
    assert(enable.status === 200, `PATCH /plugins/msteams → 200 (got ${enable.status}: ${enable.text})`);
    await fake.waitForCall((calls) => calls.some((c) => c.path === '/oauth/token'), 20_000, 'eager credential check (POST /oauth/token)');
    console.log('PASS wiring: msteams plugin enabled and authenticated against the fake token endpoint.');

    // ── Scenario 1: signed activity → async threaded reply, with the live trace edited in place ──────
    const reply = await expectReply(fake, baseUrl, 'Hi Elowen, are you there?', (t) => t.includes(REPLY_MARKER), 'brain reply round-trip');
    assert(reply.text.includes(FINAL_TEXT), `reply carries the model's final text; got "${reply.text}"`);
    assert(reply.textFormat === 'markdown', `reply is markdown-formatted (got ${reply.textFormat})`);
    assert(model.requests.length >= 1, `model server served the turn (>=1 request), got ${model.requests.length}`);
    // The model called a tool → the default status trace posted a progress bubble and edited it (PUT).
    assert(fake.updates().length >= 1, `the live trace edited a message in place (PUT); got ${fake.updates().length} updates`);
    console.log('PASS scenario 1: signed activity accepted fast, reply delivered async via the Connector, trace edited live.');

    // ── Scenario 2: /status through the shared control core (a live session now exists) ──────────────
    const statusReply = await expectReply(fake, baseUrl, '/status', (t) => t.includes('mock-model') && /Context/.test(t), '/status reply');
    assert(/🧠 .*mock-model/.test(statusReply.text) && /📊 Context \d/.test(statusReply.text),
      `/status carries the model + context lines; got "${statusReply.text}"`);
    console.log('PASS scenario 2: /status via runControlCommand returned the live model + context line.');

    // ── Scenario 3: TEETH — a garbage JWT bounces at the webhook and never reaches the brain ─────────
    const turnsBefore = model.requests.length;
    const badStatus = await fake.injectActivity(baseUrl, messageActivity('forged message'), { badToken: true });
    assert(badStatus === 401, `forged token → 401 at the webhook (got ${badStatus})`);
    assert(model.requests.length === turnsBefore, 'the forged activity never started a brain turn');
    console.log('PASS teeth: an unsigned activity was rejected at the webhook with 401.');

    // ── Scenario 4: TEETH — a provider failure surfaces as the bot's error reply ─────────────────────
    model.setFail(true);
    const errReply = await expectReply(fake, baseUrl, 'This turn must fail.', (t) => t.startsWith('⚠️'), 'error reply on provider failure');
    assert(errReply.text.startsWith('⚠️'), `error reply starts with the warning glyph; got "${errReply.text}"`);
    console.log('PASS teeth: an injected provider error surfaced as the bot\'s "⚠️ …" reply.');
  } finally {
    if (daemon) await daemon.stop();
    await fake.close();
    await model.close();
  }
}

main().then(() => {
  console.log('PASS test:e2e:msteams — real daemon + real msteams plugin + fake Bot Framework verified.');
  process.exit(0);
}).catch((err) => {
  console.error(`FAIL test:e2e:msteams — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
