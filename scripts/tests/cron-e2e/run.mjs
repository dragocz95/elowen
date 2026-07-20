#!/usr/bin/env node
// Cron / check-collector E2E scenario against a REAL built daemon.
//
// Proves the "invisible" scheduled path end to end — the one the UI never exercises:
//   enable the bundled `cronjob` plugin over the real admin API → create a job whose `check` collector
//   (a shell command) prints deterministic data → the plugin's scheduler ticks on wall-clock time →
//   runCheck() execs the collector → its stdout is injected into a brain turn → the daemon calls the
//   scripted OpenAI-compatible model server over real HTTP, carrying the collector output → the turn's
//   reply persists as the job's own channel conversation.
//
// The mechanism (traced in src + plugins/cronjob/index.mjs):
//   - Jobs are NOT in SQLite; they live in <pluginDataRoot>/cronjob/jobs.json, upserted via
//     PUT /plugins/cronjob/jobs/:id (admin-only). The scheduler (CronAdapter) re-reads that file every
//     `tickMs` (default 30s, min 10s — lowered here to 10s via PATCH /plugins/cronjob/config).
//   - A one-shot job (`runAt` in the past, no `lastRun`) is due on the very next tick — the deterministic
//     trigger. No wall-clock cron wait, no bare sleep: we poll the model server's request log with a hard
//     deadline until the collector's marker arrives.
//   - A job's `check` prints non-empty stdout → the tick appends it to the prompt under
//     "--- Check output (fresh data to act on) ---" and runs the brain turn (index.mjs:450-452). Empty
//     stdout or a non-zero exit → the turn is SKIPPED (index.mjs:432-434) — which is exactly the teeth:
//     a broken collector propagates nothing, the deadline poll times out, and the test fails loudly.
//
// Assertion surfaces (both driven by the single tick):
//   1. PRIMARY  — the scripted model server received a chat-completion request whose user message carries
//      the collector's marker UNDER the "Check output" framing (the collector's stdout reached the brain).
//   2. SECONDARY — the turn persisted as the job's channel session (brain-ch-cron-job-<id>): the reply
//      marker is stored and reloads (the brain acted on the data and the result is durable).
//   3. TERTIARY — the one-shot job was consumed (deleted) after firing (the scheduler actually ran it).
//
// Run with: node scripts/tests/cron-e2e/run.mjs
// PROD-safe: throwaway ephemeral port + temp HOME/DB (spawnRealDaemon), never touches prod DB/ports/systemd.

import { startModelServer } from '../brain-e2e/model-server.mjs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';

// Optional break switch used ONLY to demonstrate the teeth: make the collector print nothing so the tick
// skips the brain turn and the primary deadline poll must time out (a loud failure). Not set in CI.
const BREAK_COLLECTOR = process.env.CRON_E2E_BREAK_COLLECTOR === '1';

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(baseUrl, method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json, text };
}

/** Poll `fn()` until it returns a truthy value or the hard deadline elapses. No bare sleeps on the path
 *  under test — every wait is a deadline-bounded poll that fails loudly on timeout. */
async function pollUntil(fn, timeoutMs, intervalMs, label) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Flatten a chat-completion request body's messages into one searchable string (user content can be a
 *  plain string or an array of content parts). */
function messagesText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .map((m) => {
      if (typeof m?.content === 'string') return `${m.role}:${m.content}`;
      if (Array.isArray(m?.content)) return `${m.role}:${m.content.map((p) => p?.text ?? '').join(' ')}`;
      return '';
    })
    .join('\n');
}

async function main() {
  // Unique markers so nothing from a previous run or another surface can produce a false positive.
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const COLLECTOR_MARKER = `E2E_CRON_COLLECTOR_${nonce}`;
  const CHECK_VALUE = `newbookings=3 value=42`;
  const REPLY_MARKER = `E2E_CRON_REPLY_${nonce}`;
  const jobId = `e2e-${nonce}`;
  const channelSessionId = `brain-ch-cron-job-${jobId}`;

  // The collector: a trivial shell `check` that prints deterministic data (the real mechanism is any
  // shell command; a real deployment points this at a script under the collectors dir). In break mode it
  // prints NOTHING, so the scheduler skips the turn — the teeth.
  const checkCommand = BREAK_COLLECTOR
    ? `printf ''`
    : `printf '%s' '${COLLECTOR_MARKER} ${CHECK_VALUE}'`;

  // Plain-text model turn (no tool): the scheduled turn just needs the brain to answer. The reply carries
  // its own marker so we can prove it persisted to the job's channel session.
  const model = await startModelServer({
    toolName: null,
    firstText: 'Collector output received. ',
    finalText: `${REPLY_MARKER} acknowledged 3 new bookings.`,
  });

  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;
    console.log(`daemon up on ${baseUrl}; model server on ${model.baseUrl}`);

    // 1) Shorten the scheduler tick to its 10s minimum, then enable the bundled cronjob plugin. Both apply
    //    live (each hot-reloads the plugin registry); enabling connects the CronAdapter and starts its
    //    tick loop with the stored tickMs.
    const cfg = await req(baseUrl, 'PATCH', '/plugins/cronjob/config', token, { values: { tickMs: 10000 } });
    assert(cfg.status === 200, `PATCH /plugins/cronjob/config -> 200 (got ${cfg.status}: ${cfg.text})`);
    const enable = await req(baseUrl, 'PATCH', '/plugins/cronjob', token, { enabled: true });
    assert(enable.status === 200, `PATCH /plugins/cronjob {enabled:true} -> 200 (got ${enable.status}: ${enable.text})`);

    // 2) Create a one-shot job due NOW: runAt in the past + no lastRun -> due on the very next tick. Its
    //    `check` collector prints the marker; the prompt deliberately does NOT contain the marker, so the
    //    marker can only reach the model via the collector's stdout being injected into the turn.
    const job = {
      name: 'e2e-collector',
      schedule: 'in 5s', // required non-empty field; ignored for a one-shot (runAt decides)
      prompt: 'A scheduled check produced fresh data below. Acknowledge it.',
      check: checkCommand,
      runAt: new Date(Date.now() - 2000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    const created = await req(baseUrl, 'PUT', `/plugins/cronjob/jobs/${jobId}`, token, job);
    assert(created.status === 200, `PUT /plugins/cronjob/jobs/${jobId} -> 200 (got ${created.status}: ${created.text})`);

    // Sanity: the job is on disk and armed (no lastRun for a one-shot) before the tick fires.
    const listBefore = await req(baseUrl, 'GET', '/plugins/cronjob/jobs', token);
    assert(Array.isArray(listBefore.json) && listBefore.json.some((j) => j.id === jobId),
      `job ${jobId} is persisted before firing`);

    // 3) PRIMARY: poll the model server's request log until a turn arrives carrying the collector's output.
    //    Deterministic — the job is due and a tick occurs within tickMs (10s); 45s is 4+ ticks of margin.
    //    If the collector is broken (break mode / a real error), nothing propagates and this times out.
    const hit = await pollUntil(
      () => model.requests.find((r) => messagesText(r.body).includes(COLLECTOR_MARKER)),
      45_000, 250, `a model turn carrying the collector marker ${COLLECTOR_MARKER}`,
    );
    const turnText = messagesText(hit.body);
    assert(turnText.includes('Check output (fresh data to act on)'),
      'the collector output reached the brain under the "Check output" framing');
    assert(turnText.includes(CHECK_VALUE),
      `the brain turn carried the collector's actual stdout value ("${CHECK_VALUE}")`);
    console.log('PASS primary: the check collector executed and its stdout reached the brain turn.');

    // 4) SECONDARY: the turn persisted as the job's own channel conversation. Poll the admin managed-sessions
    //    view until it appears, then reload its messages and assert both the injected collector data and the
    //    brain's reply marker are durable.
    await pollUntil(async () => {
      const sessions = await req(baseUrl, 'GET', '/brain/managed-sessions', token);
      return Array.isArray(sessions.json) && sessions.json.some((s) => s.id === channelSessionId);
    }, 20_000, 250, `channel session ${channelSessionId} to appear in managed-sessions`);

    const messages = await pollUntil(async () => {
      const res = await req(baseUrl, 'GET', `/brain/messages?session=${encodeURIComponent(channelSessionId)}`, token);
      if (!Array.isArray(res.json)) return null;
      const hasReply = res.json.some((m) => m.role === 'assistant' && typeof m.text === 'string' && m.text.includes(REPLY_MARKER));
      return hasReply ? res.json : null;
    }, 20_000, 250, `the persisted reply "${REPLY_MARKER}" in the job's channel session`);

    const userMsg = messages.find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.includes(COLLECTOR_MARKER));
    assert(userMsg, 'the persisted transcript reloads with the injected collector output');
    console.log('PASS secondary: the scheduled turn persisted as the job\'s channel conversation with the reply.');

    // 5) TERTIARY: the one-shot was consumed (deleted) once it fired — proof the scheduler actually ran it,
    //    not merely that a request appeared from somewhere.
    const consumed = await pollUntil(async () => {
      const list = await req(baseUrl, 'GET', '/plugins/cronjob/jobs', token);
      return Array.isArray(list.json) && !list.json.some((j) => j.id === jobId);
    }, 20_000, 250, `one-shot job ${jobId} to be consumed after firing`);
    assert(consumed, 'one-shot job removed after firing');
    console.log('PASS tertiary: the one-shot job was consumed by the scheduler after it fired.');

    console.log('PASS cron/collector E2E: schedule -> check collector -> daemon ingest -> brain turn -> persisted.');
  } finally {
    // Best-effort: remove the job (a one-shot is already gone; a stray recurring one would not survive
    // teardown anyway since the whole temp DB/config dir is deleted), then stop the daemon and model server.
    if (daemon) {
      try { await req(daemon.baseUrl, 'DELETE', `/plugins/cronjob/jobs/${jobId}`, daemon.token); } catch { /* best effort */ }
      await daemon.stop();
    }
    await model.close();
  }
}

main().then(() => {
  console.log('PASS test:e2e:cron — real daemon cron check-collector path verified.');
  process.exit(0);
}).catch((err) => {
  console.error(`FAIL test:e2e:cron — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
