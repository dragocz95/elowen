#!/usr/bin/env node
// REST / SSE / WebSocket daemon contract E2E — against the REAL built daemon (`dist/daemon/index.js`).
//
// Three areas, each exercised against a freshly-booted real daemon (throwaway port + temp DB/config, full
// teardown in finally, zero prod impact):
//
//   1) AUTH GUARD MATRIX — enumerated straight from src/api/auth.ts (isPublic allow-list, the
//      `users.count() === 0` setup-mode open, else Bearer required) and the route registrations. Driven on
//      a PLAIN no-bootstrap daemon so the fresh-install 0-user state and the transition into re-engaged
//      auth are both observable in ONE process.
//   2) SSE STREAM LIFECYCLE — GET /brain/stream against a fully-wired daemon (spawnRealDaemon + a scripted
//      model server): authed open delivers frames and idles, an UNAUTHED open is rejected, and a client
//      disconnect closes cleanly with no hang.
//   3) WEBSOCKET CHANNEL — GET /ws/terminal (the @hono/node-server WS upgrade). It is public in isPublic; its
//      capability is the single-use ticket minted through the core ticket store, which is reachable ONLY
//      from an authenticated route holding the `reads:['terminals']` grant. Asserts the ticket gate:
//      no/garbage ticket is rejected (close 4001 'ticket'), the mint is Bearer-gated and grant-gated, and
//      a valid ticket passes the gate exactly once.
//
// TEETH: an unauthed protected request that wrongly succeeds, an SSE open that wrongly bypasses auth, or a
// WS that accepts a ticketless client all fail the run loudly. No bare sleeps — every wait is deadline-
// bounded polling or a stream/socket event.
//
// Run with: node scripts/tests/api-e2e/run.mjs

import { execFileSync } from 'node:child_process';
import { bootPlainDaemon } from './boot.mjs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { startModelServer } from '../brain-e2e/model-server.mjs';

let passes = 0;
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  passes += 1;
}
function ok(message) { console.log(`  ok: ${message}`); }

// ---- HTTP helpers -----------------------------------------------------------------------------------

/** GET returning { status, json } — never throws on a non-2xx (the status IS the assertion target). */
async function get(baseUrl, path, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json, contentType: res.headers.get('content-type') ?? '' };
}

async function postJson(baseUrl, path, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json };
}

/** POST with EXTRA request headers — for the origin-attribution area, where the whole point is what the
 *  daemon reads off `x-real-ip`. Separate from postJson so the plain helper stays unambiguous. */
async function postJsonWithHeaders(baseUrl, path, token, body, extra) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json };
}

async function patchJson(baseUrl, path, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json };
}

/** Turn a discovered plugin on, performing the same two-step consent handshake the UI does: the first call
 *  answers 409 listing the grants it wants, the second repeats them back. Reading them off the refusal
 *  instead of hardcoding a list keeps this working when a manifest changes what it asks for. */
async function enablePlugin(baseUrl, token, name) {
  let r = await patchJson(baseUrl, `/plugins/${name}`, token, { enabled: true });
  if (r.status === 409 && Array.isArray(r.json?.grants)) {
    r = await patchJson(baseUrl, `/plugins/${name}`, token, { enabled: true, acknowledgeGrants: r.json.grants });
  }
  assert(r.status === 200, `[enable/${name}] PATCH /plugins/${name} {enabled:true} → 200 (got ${r.status} ${JSON.stringify(r.json)})`);
  return r;
}

// ---- SSE helper (same frame parsing as scripts/tests/brain-e2e/chat-turn.mjs) ------------------------

/** Open a real SSE stream and expose parsed brain events + a deadline-bounded waitFor. Parses standard
 *  `data:` frames; `:` comment lines (the `: connected` / `: ping` keep-alives) are ignored. */
async function openStream(baseUrl, path, token) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream open failed: HTTP ${res.status}`);

  const events = [];
  const waiters = [];
  let ended = false;
  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(events)) { waiters[i].resolve(events); waiters.splice(i, 1); }
    }
  };

  const reader = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let dataLine = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          try { events.push(JSON.parse(dataLine)); notify(); } catch { /* non-JSON frame */ }
        }
      }
    } catch { /* stream aborted on close */ } finally { ended = true; }
  })();

  return {
    events,
    contentType: res.headers.get('content-type') ?? '',
    waitFor(predicate, timeoutMs, label) {
      if (predicate(events)) return Promise.resolve(events);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for: ${label}\nevents so far: ${events.map((e) => e.type).join(', ')}`));
        }, timeoutMs);
        entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
        waiters.push(entry);
      });
    },
    /** Abort the client side and resolve once the reader loop has actually unwound (proves no hang). */
    async close(deadlineMs = 5_000) {
      controller.abort();
      const until = Date.now() + deadlineMs;
      while (!ended && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      await Promise.race([reader, new Promise((r) => setTimeout(r, 200))]);
      return ended;
    },
  };
}

// ---- WebSocket helper -------------------------------------------------------------------------------

/** Open a WS to `url`, then resolve with the observed lifecycle within `deadlineMs`. A close resolves
 *  immediately with its code/reason; if the socket stays open past the deadline we resolve open+not-closed
 *  (the daemon accepted a bridge — used only for the valid-ticket path). Node 22 ships a global WebSocket. */
function wsProbe(url, deadlineMs = 5_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const result = { opened: false, closed: false, code: null, reason: null, errored: false };
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch { /* already closing */ } resolve(result); };
    const timer = setTimeout(finish, deadlineMs);
    ws.addEventListener('open', () => { result.opened = true; });
    ws.addEventListener('error', () => { result.errored = true; });
    ws.addEventListener('close', (e) => { result.closed = true; result.code = e.code; result.reason = e.reason; finish(); });
  });
}

const toWs = (baseUrl) => baseUrl.replace(/^http/, 'ws');

// ---- fixture plugins for the WS ticket area ---------------------------------------------------------

/** The session name the mint routes below issue tickets for. Any string works — the core ticket store
 *  does not interpret it; who may ask for one is the mint route's business. */
const WS_SESSION = 'elowen-e2e';

/** GRANTED minter: the shape a plugin takes when it owns a terminal surface. Root-mounts an
 *  authenticated route that calls the core `host.terminals().ticketIssue` seam — the SAME single-use
 *  store `/ws/terminal` redeems — and declares the `reads:['terminals']` capability that seam is gated on.
 *
 *  Why a fixture and not a product plugin: the ticket mint used to be `POST /sessions/:name/ws-ticket`
 *  from the bundled `agents` plugin, which now lives in the plugin registry and is not in this package
 *  (and cannot be fetched from CI). The daemon-side subject never moved — the ticket store, the
 *  `/ws/terminal` upgrade in src/daemon/index.ts, its isPublic exemption and the auth guard in front of
 *  every non-exempt route are all core. So the mint gets a fixture SUBJECT and the gate keeps its teeth. */
const WS_TICKET_PLUGIN = {
  name: 'e2e-ws-ticket',
  manifest: {
    provides: { apiRoutes: ['/e2e-terminal/ws-ticket/:session'] },
    capabilities: { reads: ['terminals'] },
  },
  register: `
  ctx.registerApiRoute({
    rootMount: '/e2e-terminal/ws-ticket/:session', path: '', method: 'POST', access: 'user',
    handler: async (req) => ({ body: { ticket: ctx.host.terminals().ticketIssue(req.params.session, req.auth.userId) } }),
  });`,
};

/** UNGRANTED minter: identical route, manifest deliberately WITHOUT reads:['terminals']. The host seam
 *  must refuse it, so an admin-installed plugin cannot reach the terminal capability without declaring
 *  (and having consented to) the power it is asking for. */
const WS_TICKET_UNGRANTED_PLUGIN = {
  name: 'e2e-ws-ticket-ungranted',
  manifest: { provides: { apiRoutes: ['/e2e-terminal-ungranted/ws-ticket/:session'] } },
  register: `
  ctx.registerApiRoute({
    rootMount: '/e2e-terminal-ungranted/ws-ticket/:session', path: '', method: 'POST', access: 'user',
    handler: async (req) => ({ body: { ticket: ctx.host.terminals().ticketIssue(req.params.session, req.auth.userId) } }),
  });`,
};

// ---- prod-safety guard: prod daemon PID must be untouched -------------------------------------------

function prodDaemonPid() {
  try {
    const out = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'elowen-daemon'], { encoding: 'utf8' }).trim();
    return out && out !== '0' ? out : null;
  } catch { return null; }
}

// =====================================================================================================
// 3) WEBSOCKET CHANNEL — /ws/terminal ticket gate, on the re-engaged plain daemon.
// =====================================================================================================
async function websocketChannel(baseUrl, token) {
  console.log('\n[3] WEBSOCKET CHANNEL — /ws/terminal (ticket gate)');
  const wsBase = toWs(baseUrl);

  const mintPath = `/e2e-terminal/ws-ticket/${WS_SESSION}`;
  const ungrantedMintPath = `/e2e-terminal-ungranted/ws-ticket/${WS_SESSION}`;

  // Nothing in THIS package mints a terminal ticket any more (the `agents` plugin that root-mounted
  // POST /sessions/:name/ws-ticket moved to the plugin registry), so the two fixture plugins written
  // into the daemon's plugin dir before boot supply the mint. Hold the enable to 200: if a minter
  // cannot be turned on, this area has nothing to test and must say so rather than quietly checking
  // the wrong thing.
  await enablePlugin(baseUrl, token, WS_TICKET_PLUGIN.name);
  await enablePlugin(baseUrl, token, WS_TICKET_UNGRANTED_PLUGIN.name);
  ok('enabled the granted + ungranted fixture minters (root-mounted routes over the core ticket store)');

  // The mint endpoint is Bearer-gated (NOT in isPublic): tokenless → 401 unauthorized. The guard runs
  // before the plugin dispatcher, so this is the daemon refusing, not the plugin.
  let p = await postJson(baseUrl, mintPath, null, {});
  assert(p.status === 401 && p.json?.error === 'unauthorized',
    `[ws-ticket/no-token] POST ${mintPath} → 401 tokenless (got ${p.status} ${JSON.stringify(p.json)})`);
  ok('POST <mint> → 401 tokenless (capability mint is Bearer-gated)');

  // Grant gate: the same route in a plugin that did not declare reads:['terminals'] must NOT get a
  // ticket, even with a valid admin Bearer. The seam throws, the dispatcher answers 500 — what matters
  // is that no capability came back.
  p = await postJson(baseUrl, ungrantedMintPath, token, {});
  assert(p.status !== 200 && !p.json?.ticket,
    `[ws-ticket/no-grant] an ungranted plugin gets NO ticket from host.terminals() (got ${p.status} ${JSON.stringify(p.json)})`);
  ok(`POST <ungranted mint> → ${p.status}, no ticket (reads:['terminals'] is enforced at the host seam)`);

  // No ticket → the upgrade is accepted but the handler immediately closes 4001 'ticket' (the gate).
  let w = await wsProbe(`${wsBase}/ws/terminal`);
  assert(w.closed && w.code === 4001 && w.reason === 'ticket',
    `[ws/no-ticket] /ws/terminal with no ticket closes 4001 'ticket' (got ${JSON.stringify(w)})`);
  ok("WS /ws/terminal (no ticket) → closed 4001 'ticket' (ticketless client rejected)");

  // Garbage ticket → same rejection (consume() returns null for an unknown id).
  w = await wsProbe(`${wsBase}/ws/terminal?ticket=deadbeefdeadbeefdeadbeef`);
  assert(w.closed && w.code === 4001 && w.reason === 'ticket',
    `[ws/garbage-ticket] /ws/terminal with a garbage ticket closes 4001 'ticket' (got ${JSON.stringify(w)})`);
  ok("WS /ws/terminal (garbage ticket) → closed 4001 'ticket'");

  // Authed mint on the GRANTED plugin → a real single-use ticket out of the core store.
  p = await postJson(baseUrl, mintPath, token, {});
  assert(p.status === 200 && typeof p.json?.ticket === 'string' && p.json.ticket,
    `[ws-ticket/authed] POST ${mintPath} → 200 { ticket } with a valid Bearer (got ${p.status} ${JSON.stringify(p.json)})`);
  const ticket = p.json.ticket;
  ok('POST <mint> → 200 { ticket } with a valid Bearer');

  // Valid ticket → PAST the ticket gate. It is consumed; the handler then tries to attach a PTY. node-pty
  // is unavailable in this environment, so it closes 4001 'pty' — a DIFFERENT reason than the ticket-gate
  // rejection, which is exactly what proves the ticket was accepted. If a host DID have node-pty the socket
  // would instead stay open (a bridge); both outcomes are "not the 'ticket' rejection".
  w = await wsProbe(`${wsBase}/ws/terminal?ticket=${encodeURIComponent(ticket)}`);
  assert(!(w.closed && w.reason === 'ticket'),
    `[ws/valid-ticket] a valid ticket must pass the ticket gate (not close with reason 'ticket') (got ${JSON.stringify(w)})`);
  ok(`WS /ws/terminal (valid ticket) → passed the ticket gate (${w.closed ? `closed 4001 '${w.reason}'` : 'bridge stayed open'})`);

  // Single-use: re-presenting the SAME (already consumed) ticket is rejected like an unknown one.
  w = await wsProbe(`${wsBase}/ws/terminal?ticket=${encodeURIComponent(ticket)}`);
  assert(w.closed && w.code === 4001 && w.reason === 'ticket',
    `[ws/replayed-ticket] a consumed ticket is single-use → closes 4001 'ticket' (got ${JSON.stringify(w)})`);
  ok("WS /ws/terminal (replayed consumed ticket) → closed 4001 'ticket' (single-use enforced)");
}

// =====================================================================================================
// 2) SSE STREAM LIFECYCLE — /brain/stream, on a fully-wired daemon (spawnRealDaemon + model server).
// =====================================================================================================
async function sseStreamLifecycle() {
  console.log('\n[2] SSE STREAM LIFECYCLE — /brain/stream');
  // No-tool model: a single plain-text turn (no owner tools needed) — enough to prove frames flow + idle.
  const model = await startModelServer({ toolName: null, firstText: 'API-E2E-SSE ', finalText: 'stream frame delivered.' });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;

    // Start a conversation, then open the authed stream bound to it BEFORE sending so no frame is missed.
    const start = await postJson(baseUrl, '/brain/start', token, { fresh: true });
    assert(start.status === 201 && typeof start.json?.sessionId === 'string' && start.json.sessionId,
      `POST /brain/start → 201 sessionId (got ${start.status} ${JSON.stringify(start.json)})`);
    const sessionId = start.json.sessionId;
    ok('POST /brain/start → 201 with a sessionId');

    // UNAUTHED open MUST be rejected (SSE-auth teeth): no event-stream body ever begins.
    const unauth = await fetch(`${baseUrl}/brain/stream?session=${encodeURIComponent(sessionId)}`, { headers: { accept: 'text/event-stream' } });
    await unauth.text().catch(() => {});
    assert(unauth.status === 401, `[sse/no-token] GET /brain/stream → 401 unauthed (got ${unauth.status})`);
    assert(!(unauth.headers.get('content-type') ?? '').includes('text/event-stream'),
      `[sse/no-token] rejected open is NOT an event-stream (got ${unauth.headers.get('content-type')})`);
    ok('GET /brain/stream unauthed → 401, no event-stream body (auth applies to SSE)');

    // Authed open → correct content-type, and it delivers frames on a real turn.
    const stream = await openStream(baseUrl, `/brain/stream?session=${encodeURIComponent(sessionId)}`, token);
    assert(stream.contentType.includes('text/event-stream'),
      `[sse/authed] content-type is text/event-stream (got "${stream.contentType}")`);
    ok(`GET /brain/stream authed → content-type "${stream.contentType.split(';')[0]}"`);

    await new Promise((r) => setTimeout(r, 200)); // let the session tap attach before the send
    const send = await postJson(baseUrl, '/brain/send', token, { text: 'Say hello for the SSE contract test.', session: sessionId, mode: 'build' });
    assert(send.status === 202, `POST /brain/send → 202 accepted (got ${send.status} ${JSON.stringify(send.json)})`);
    ok('POST /brain/send → 202 accepted');

    // At least the initial frame(s) arrive over the stream, then it reaches idle — deadline-bounded.
    await stream.waitFor((evs) => evs.length >= 1, 15_000, 'first SSE data frame');
    assert(stream.events.length >= 1, `SSE delivered at least one data frame (got ${stream.events.length})`);
    ok(`SSE delivered initial frame(s) — first event type "${stream.events[0]?.type}"`);
    await stream.waitFor((evs) => evs.some((e) => e.type === 'idle'), 45_000, 'idle frame');
    ok('SSE delivered the idle frame — turn completed over the live stream');

    // Clean close on client disconnect: aborting the client unwinds the reader with no hang, and the
    // daemon stays healthy afterwards.
    const unwound = await stream.close(5_000);
    assert(unwound, 'SSE reader unwound cleanly after client disconnect (no hang)');
    const health = await get(baseUrl, '/health');
    assert(health.status === 200 && health.json?.ok === true, `daemon healthy after the stream disconnect (got ${health.status})`);
    ok('SSE client disconnect closed cleanly; daemon still healthy');
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}


// =====================================================================================================
// 4) ORIGIN ATTRIBUTION — two real turns from two addresses, read back through GET /usage/by-origin.
//
// The end-to-end teeth for the "who, from where" view. Every unit test in this area stubs SOMETHING —
// the header, the store, or the projector. This drives real HTTP into a real daemon with a real model
// server and asserts that the two turns land on two SEPARATE rows: a breakdown, not a total, because a
// total would also come out of an implementation that attributed spend to the session instead of to the
// requesting turn. It also asserts the 403 for a non-admin as a STATUS, since a filtered-but-200 answer
// would still tell a normal account that addresses are being recorded.
// =====================================================================================================
async function originAttribution() {
  console.log('\n[4] ORIGIN ATTRIBUTION — /usage/by-origin');
  const model = await startModelServer({ toolName: null, firstText: 'API-E2E-ORIGIN ', finalText: 'attributed.' });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;

    let r = await get(baseUrl, '/usage/by-origin', token);
    assert(r.status === 200 && r.json?.trackingSince === null && Array.isArray(r.json?.rows) && r.json.rows.length === 0,
      `[origin/empty] GET /usage/by-origin → 200 with an explicitly empty window (got ${r.status} ${JSON.stringify(r.json)})`);
    ok('GET /usage/by-origin → 200 with trackingSince null before anything is recorded');

    // Two turns, two addresses. The header is the ONLY difference between them, and it has to survive the
    // whole path: HTTP → clientOrigin → the per-turn pin → the settle → the rollup.
    const addresses = ['203.0.113.7', '198.51.100.44'];
    for (const address of addresses) {
      const start = await postJsonWithHeaders(baseUrl, '/brain/start', token, { fresh: true }, { 'x-real-ip': address });
      assert(start.status === 201 && typeof start.json?.sessionId === 'string',
        `[origin/${address}] POST /brain/start → 201 (got ${start.status} ${JSON.stringify(start.json)})`);
      const sessionId = start.json.sessionId;
      const stream = await openStream(baseUrl, `/brain/stream?session=${encodeURIComponent(sessionId)}`, token);
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the tap attach before the send
      const send = await postJsonWithHeaders(
        baseUrl, '/brain/send', token,
        { text: `Say hello from ${address}.`, session: sessionId, mode: 'build' },
        { 'x-real-ip': address },
      );
      assert(send.status === 202, `[origin/${address}] POST /brain/send → 202 (got ${send.status} ${JSON.stringify(send.json)})`);
      // The rollup is written when the turn SETTLES, so the read below is only meaningful after idle.
      await stream.waitFor((evs) => evs.some((e) => e.type === 'idle'), 45_000, `idle frame for ${address}`);
      await stream.close(5_000);
      ok(`turn from ${address} settled over the live stream`);
    }

    r = await get(baseUrl, '/usage/by-origin?group=origin', token);
    assert(r.status === 200, `[origin/admin] GET /usage/by-origin → 200 (got ${r.status})`);
    const origins = (r.json?.rows ?? []).map((row) => row.origin).sort();
    assert(origins.length === 2 && origins.join(',') === [...addresses].sort().join(','),
      `[origin/admin] the two turns produced two SEPARATE rows, one per address (got ${JSON.stringify(origins)})`);
    const tokensRecorded = (r.json.rows ?? []).every((row) => row.tokens > 0 && row.turns >= 1);
    assert(tokensRecorded, `[origin/admin] each address carries real tokens and turns (got ${JSON.stringify(r.json.rows)})`);
    assert(typeof r.json.trackingSince === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.json.trackingSince),
      `[origin/admin] trackingSince names the first recorded day (got ${JSON.stringify(r.json.trackingSince)})`);
    ok(`GET /usage/by-origin → two rows, one per address (${origins.join(' + ')})`);

    // A second, non-admin account with a perfectly valid token. It is also assigned to a project, so the
    // coarse project pre-filter cannot be what produces the 403 — the route's own admin gate must.
    const created = await postJson(baseUrl, '/users', token, { username: 'origin-e2e-member', password: 'member-pw-1234' });
    assert(created.status === 200 || created.status === 201, `[origin/member] POST /users → created (got ${created.status} ${JSON.stringify(created.json)})`);
    const memberId = created.json?.id ?? created.json?.user?.id;
    assert(typeof memberId === 'number', `[origin/member] created user carries an id (got ${JSON.stringify(created.json)})`);
    const projects = await get(baseUrl, '/projects', token);
    const projectId = projects.json?.[0]?.id;
    assert(typeof projectId === 'number', `[origin/member] a project exists to assign (got ${JSON.stringify(projects.json)})`);
    const assigned = await postJson(baseUrl, `/users/${memberId}/projects`, token, { projectId });
    assert(assigned.status === 200, `[origin/member] project assigned (got ${assigned.status} ${JSON.stringify(assigned.json)})`);
    const login = await postJson(baseUrl, '/auth/login', null, { username: 'origin-e2e-member', password: 'member-pw-1234' });
    assert(login.status === 200 && typeof login.json?.token === 'string', `[origin/member] member logs in (got ${login.status})`);

    r = await get(baseUrl, '/usage/by-origin', login.json.token);
    assert(r.status === 403, `[origin/member] GET /usage/by-origin → 403 for a non-admin (got ${r.status} ${JSON.stringify(r.json)})`);
    ok('GET /usage/by-origin → 403 for a fully-assigned non-admin (the route gates, not the project filter)');

    // The reset clears the origin rollup along with the rest, so the drawer can never keep reporting
    // spend the rest of Stats has forgotten.
    const reset = await postJson(baseUrl, '/usage/reset', token, {});
    assert(reset.status === 200 && reset.json?.originsCleared >= 1,
      `[origin/reset] POST /usage/reset clears origin rows (got ${reset.status} ${JSON.stringify(reset.json)})`);
    r = await get(baseUrl, '/usage/by-origin', token);
    assert(r.status === 200 && (r.json?.rows ?? []).length === 0,
      `[origin/reset] the origin view is empty after the reset (got ${JSON.stringify(r.json)})`);
    ok('POST /usage/reset emptied the origin view too');
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

// =====================================================================================================

async function main() {
  const pidBefore = prodDaemonPid();
  console.log(pidBefore ? `prod elowen-daemon MainPID before: ${pidBefore}` : 'prod elowen-daemon not detected (PID guard best-effort)');

  // Area 1 (auth matrix) leaves the plain daemon running so area 3 (WS) can reuse it + its admin token.
  // The handle is taken from the BOOT, not from the return value: a failing assertion inside those areas
  // never returns one, and a `finally` that had nothing to stop left the child daemon alive on its
  // throwaway port with its temp dir on disk — every red run leaking one. The fixture minters are laid
  // down here because a plugin folder that appears after boot is not discovered until a rescan.
  let plainDaemon = null;
  try {
    plainDaemon = await bootPlainDaemon({ plugins: [WS_TICKET_PLUGIN, WS_TICKET_UNGRANTED_PLUGIN] });
    await runAuthAndWs(plainDaemon);
  } finally {
    if (plainDaemon) await plainDaemon.stop();
  }

  await sseStreamLifecycle();
  await originAttribution();

  const pidAfter = prodDaemonPid();
  if (pidBefore && pidAfter) {
    assert(pidBefore === pidAfter, `prod elowen-daemon MainPID unchanged (before ${pidBefore}, after ${pidAfter})`);
    ok(`prod elowen-daemon MainPID unchanged (${pidAfter}) — zero prod impact`);
  } else {
    console.log('  note: prod elowen-daemon not detected before/after — PID guard skipped (no prod on this host)');
  }
}

/** Run the auth matrix, then the WS area on the same re-engaged plain daemon (the CALLER owns the boot
 *  and the teardown). Kept together because area 3 needs area 1's live daemon + admin token. */
async function runAuthAndWs(daemon) {
  console.log('\n[1] AUTH GUARD MATRIX');
  const { baseUrl } = daemon;
  const admin = { username: 'admin', password: `e2e-${Math.random().toString(36).slice(2)}` };

  // --- Public routes reachable tokenless in ALL states (isPublic allow-list) ---
  let r = await get(baseUrl, '/health');
  assert(r.status === 200 && r.json?.ok === true, `[public/isPublic] GET /health → 200 {ok:true} tokenless (got ${r.status})`);
  ok('GET /health → 200 tokenless (isPublic)');

  r = await get(baseUrl, '/setup');
  assert(r.status === 200 && r.json?.needsSetup === true, `[public/isPublic] GET /setup → 200 needsSetup:true in setup mode (got ${r.status} ${JSON.stringify(r.json)})`);
  ok('GET /setup → 200 needsSetup:true (isPublic, 0 users)');

  let p = await postJson(baseUrl, '/auth/login', null, { username: 'nobody', password: 'x' });
  assert(p.status === 401 && p.json?.error === 'invalid credentials',
    `[public/isPublic] POST /auth/login reached the route tokenless → 401 invalid credentials (got ${p.status} ${JSON.stringify(p.json)})`);
  ok('POST /auth/login reachable tokenless — route-level 401, not guard 401 (isPublic)');

  // --- SETUP MODE (0 users): normally-protected routes OPEN tokenless (count()===0 → next()) ---
  r = await get(baseUrl, '/auth/me');
  assert(r.status === 200 && (r.json?.user === undefined || r.json?.user === null),
    `[setup-open] GET /auth/me → 200 with no user in setup mode (got ${r.status} ${JSON.stringify(r.json)})`);
  ok('GET /auth/me → 200 (no user) tokenless in setup mode (count()===0 branch)');

  r = await get(baseUrl, '/projects');
  assert(r.status === 200, `[setup-open] GET /projects → 200 tokenless in setup mode (got ${r.status})`);
  ok('GET /projects → 200 tokenless in setup mode (count()===0 branch)');

  p = await postJson(baseUrl, '/users', null, admin);
  assert(p.status === 201, `[setup-open] POST /users → 201 creating first admin (got ${p.status} ${JSON.stringify(p.json)})`);
  assert(p.json?.is_admin === true, `[setup-open] first created user is_admin:true (got ${JSON.stringify(p.json)})`);
  ok('POST /users → 201 first admin, is_admin:true (setup-mode open)');

  // --- AUTH RE-ENGAGED (>=1 user): guard enforces Bearer on the protected routes ---
  r = await get(baseUrl, '/setup');
  assert(r.status === 200 && r.json?.needsSetup === false, `[re-engaged] GET /setup → needsSetup:false after first user (got ${JSON.stringify(r.json)})`);
  ok('GET /setup → needsSetup:false after first user');

  r = await get(baseUrl, '/projects');
  assert(r.status === 401 && r.json?.error === 'unauthorized',
    `[re-engaged/no-token] GET /projects → 401 unauthorized tokenless (got ${r.status} ${JSON.stringify(r.json)})`);
  ok('GET /projects → 401 tokenless once a user exists (Bearer-required branch)');

  r = await get(baseUrl, '/auth/me');
  assert(r.status === 401 && r.json?.error === 'unauthorized',
    `[re-engaged/no-token] GET /auth/me → 401 unauthorized tokenless (got ${r.status} ${JSON.stringify(r.json)})`);
  ok('GET /auth/me → 401 tokenless once a user exists (Bearer-required branch)');

  p = await postJson(baseUrl, '/auth/login', null, admin);
  assert(p.status === 200 && typeof p.json?.token === 'string' && p.json.token, `[re-engaged] POST /auth/login → 200 token (got ${p.status})`);
  const token = p.json.token;
  ok('POST /auth/login (valid creds) → 200 with token');

  r = await get(baseUrl, '/projects', token);
  assert(r.status === 200, `[re-engaged/valid-bearer] GET /projects → 200 with valid Bearer (got ${r.status})`);
  ok('GET /projects → 200 with valid Bearer (principal resolved)');

  r = await get(baseUrl, '/auth/me', token);
  assert(r.status === 200 && r.json?.user?.is_admin === true,
    `[re-engaged/valid-bearer] GET /auth/me → 200 with the admin principal (got ${r.status} ${JSON.stringify(r.json)})`);
  ok('GET /auth/me → 200 with the resolved admin principal (valid Bearer)');

  r = await get(baseUrl, '/projects', 'not-a-real-token-deadbeef');
  assert(r.status === 401 && r.json?.error === 'unauthorized',
    `[re-engaged/garbage-bearer] GET /projects → 401 with a garbage Bearer (got ${r.status} ${JSON.stringify(r.json)})`);
  ok('GET /projects → 401 with a garbage Bearer (null principal branch)');

  r = await get(baseUrl, '/health');
  assert(r.status === 200 && r.json?.ok === true, `[public/isPublic] GET /health → 200 tokenless after re-engage (got ${r.status})`);
  ok('GET /health → 200 tokenless after auth re-engaged (isPublic state-independent)');

  // Area 3 rides the same re-engaged daemon + admin token.
  await websocketChannel(baseUrl, token);
}

main().then(() => {
  console.log(`\nPASS api-e2e — REST/SSE/WS daemon contract verified (${passes} assertions).`);
  process.exit(0);
}).catch((err) => {
  console.error(`\nFAIL api-e2e — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
