// A tiny fake Bot Framework for the Teams-adapter E2E suite: ONE HTTP server plays every Microsoft
// role the plugin talks to —
//   * the Entra token endpoint (POST /oauth/token — the plugin's `oauthTokenUrl` seam),
//   * the OpenID metadata + JWKS host (GET /metadata, GET /keys — the `openIdMetadataUrl` seam),
//     signing the inbound activity JWTs with its own RS256 key so the adapter's REAL verifier accepts them,
//   * the Bot Connector REST surface (its base URL travels as each activity's `serviceUrl`): replies,
//     free-standing sends, live-trace updates (PUT), typing and the conversation roster — all CAPTURED.
// `injectActivity` signs an activity token and POSTs it to the daemon's /hooks/msteams/messages — the
// same path Azure takes.
//
// SAFETY: binds an ephemeral loopback port (never 4400/4500), never reaches login.microsoftonline.com,
// login.botframework.com or smba.trafficmanager.net.

import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const ISSUER = 'https://api.botframework.com';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.appId] Audience of the signed activity tokens (default 'e2e-app-id').
 * @returns {Promise<{
 *   base: string, appId: string, tokenUrl: string, metadataUrl: string, calls: object[],
 *   injectActivity: (daemonBase: string, activity: object, opts?: {badToken?: boolean}) => Promise<number>,
 *   replies: () => object[], sends: () => object[], updates: () => object[],
 *   waitForCall: (predicate: (calls: object[]) => boolean, timeoutMs: number, label: string) => Promise<object[]>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeBotFramework(opts = {}) {
  const appId = opts.appId ?? 'e2e-app-id';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e-key', alg: 'RS256', use: 'sig' };

  const calls = [];       // every captured connector call
  const callWaiters = []; // { predicate, resolve } resolved as new calls land
  let actSeq = 1000;

  const notifyCalls = () => {
    for (let i = callWaiters.length - 1; i >= 0; i -= 1) {
      if (callWaiters[i].predicate(calls)) { callWaiters[i].resolve(calls); callWaiters.splice(i, 1); }
    }
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = await readJson(req);
    const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    // ── Entra token endpoint (oauthTokenUrl seam) ──
    if (method === 'POST' && path === '/oauth/token') {
      calls.push({ method, path, body, at: Date.now() });
      notifyCalls();
      return json({ access_token: 'e2e-connector-token', token_type: 'Bearer', expires_in: 3600 });
    }
    // ── OpenID metadata + JWKS (openIdMetadataUrl seam) ──
    if (method === 'GET' && path === '/metadata') return json({ jwks_uri: `${base}/keys` });
    if (method === 'GET' && path === '/keys') return json({ keys: [jwk] });

    // ── Bot Connector surface (this server's base is the activities' serviceUrl) ──
    calls.push({ method, path, body, at: Date.now() });
    notifyCalls();
    if (method === 'POST' && /^\/v3\/conversations\/[^/]+\/activities(\/[^/]+)?$/.test(path)) return json({ id: `act-${++actSeq}` });
    if (method === 'PUT' && /^\/v3\/conversations\/[^/]+\/activities\/[^/]+$/.test(path)) return json({ id: path.split('/')[5] });
    if (method === 'DELETE' && /^\/v3\/conversations\/[^/]+\/activities\/[^/]+$/.test(path)) return json({});
    if (method === 'GET' && /^\/v3\/conversations\/[^/]+\/members\/[^/]+$/.test(path)) {
      return json({ id: path.split('/')[5], name: 'E2E Tester', aadObjectId: 'e2e-aad-1', userPrincipalName: 'tester@e2e.example' });
    }
    if (method === 'GET' && /^\/v3\/conversations\/[^/]+\/members$/.test(path)) {
      return json([{ id: '29:e2e-user', name: 'E2E Tester', aadObjectId: 'e2e-aad-1', userPrincipalName: 'tester@e2e.example' }]);
    }
    return json({});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fake Bot Framework did not bind a TCP port');
  const base = `http://127.0.0.1:${addr.port}`;

  const isSend = (c) => c.method === 'POST' && /^\/v3\/conversations\/[^/]+\/activities$/.test(c.path) && c.body?.type !== 'typing';
  const isReply = (c) => c.method === 'POST' && /^\/v3\/conversations\/[^/]+\/activities\/[^/]+$/.test(c.path);
  const isUpdate = (c) => c.method === 'PUT' && /^\/v3\/conversations\/[^/]+\/activities\/[^/]+$/.test(c.path);

  return {
    base,
    appId,
    tokenUrl: `${base}/oauth/token`,
    metadataUrl: `${base}/metadata`,
    calls,
    /** Sign the activity's service JWT and POST it to the daemon webhook — Azure's exact delivery path.
     *  Returns the webhook's HTTP status (200 on accept, 401 with `badToken`). */
    async injectActivity(daemonBase, activity, { badToken = false } = {}) {
      const withUrl = { serviceUrl: base, ...activity };
      const token = badToken
        ? 'not-a-jwt'
        : await new SignJWT({ serviceUrl: base })
          .setProtectedHeader({ alg: 'RS256', kid: 'e2e-key' })
          .setIssuer(ISSUER).setAudience(appId).setIssuedAt().setExpirationTime('5m')
          .sign(privateKey);
      const res = await fetch(`${daemonBase}/hooks/msteams/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(withUrl),
      });
      await res.text();
      return res.status;
    },
    /** Threaded replies (POST …/activities/:replyToId) — the bot answering a trigger. */
    replies: () => calls.filter(isReply),
    /** Free-standing sends (POST …/activities, typing excluded). */
    sends: () => calls.filter(isSend),
    /** In-place edits (PUT …/activities/:id) — the live trace / streamed answer. */
    updates: () => calls.filter(isUpdate),
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
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
