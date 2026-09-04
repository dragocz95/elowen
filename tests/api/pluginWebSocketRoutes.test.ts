import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import WebSocket from 'ws';
import { makeTestApp } from '../helpers/testApp.js';
import { attachPluginWebSocketRoutes } from '../../src/api/pluginWebSocket.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { webSocketTickets } from '../../src/plugins/wsTickets.js';
import type { AddressInfo } from 'node:net';

// The loader only reads real plugin folders, so the fixture is written to disk and swept afterwards.
let pluginRoots: string[] = [];
const teardown: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.splice(0)) await fn();
  for (const p of pluginRoots) rmSync(p, { recursive: true, force: true });
  pluginRoots = [];
});

/** An on-disk plugin exercising the WebSocket surface: an echo route, a ':param' route, an admin-only
 *  route, a route whose handler throws, and one deliberately NOT declared in provides.wsRoutes. The two
 *  API routes are how the test mints tickets and reads back what the socket handler observed — a closed
 *  socket cannot report on itself. */
function wsPluginProvider(): PluginRegistryProvider {
  const root = mkdtempSync(join(tmpdir(), 'plugin-ws-'));
  pluginRoots.push(root);
  const dir = join(root, 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', apiVersion: '1', description: 'demo', entry: 'index.mjs',
    provides: {
      apiRoutes: ['ticket', 'state'],
      wsRoutes: ['echo', 'session/:id', 'admin-only', 'boom'],
    },
  }));
  writeFileSync(join(dir, 'index.mjs'), `
    const state = { connections: 0, aborted: 0, closed: [], seen: null };
    export function register(ctx){
      ctx.registerApiRoute({ path: 'ticket', access: 'user', handler: async (req) => {
        const body = await req.json();
        return { body: ctx.issueWebSocketTicket({
          userId: body.userId === undefined ? req.auth.userId : body.userId,
          payload: body.payload,
          ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
        }) };
      }});
      ctx.registerApiRoute({ path: 'state', access: 'user', handler: async () => ({ body: {
        ...state,
        hasRegisterWebSocketRoute: typeof ctx.registerWebSocketRoute === 'function',
        hasIssueWebSocketTicket: typeof ctx.issueWebSocketTicket === 'function',
      } }) });

      ctx.registerWebSocketRoute({ path: 'echo', access: 'user', handler: (conn) => {
        state.connections += 1;
        state.seen = { auth: conn.auth, payload: conn.payload, params: conn.params, query: conn.query };
        conn.signal.addEventListener('abort', () => { state.aborted += 1; });
        conn.onClose((code) => { state.closed.push(code); });
        conn.onMessage((data, isBinary) => {
          if (!isBinary && data === 'flood') {
            // Queue far more than a socket can flush in one tick, then report what is still buffered.
            for (let i = 0; i < 16; i++) conn.send(new Uint8Array(1024 * 1024));
            conn.send('buffered:' + conn.bufferedAmount());
            return;
          }
          conn.send(data);
        });
      }});
      ctx.registerWebSocketRoute({ path: 'session/:id', access: 'user', handler: (conn) => {
        conn.send(JSON.stringify(conn.params));
      }});
      ctx.registerWebSocketRoute({ path: 'admin-only', access: 'admin', handler: (conn) => { conn.send('secret'); }});
      ctx.registerWebSocketRoute({ path: 'boom', access: 'user', handler: () => { throw new Error('handler exploded'); }});
      // Undeclared path — the registry must refuse it at register time.
      ctx.registerWebSocketRoute({ path: 'undeclared', access: 'user', handler: () => {} });
    }
  `);
  return new PluginRegistryProvider(() => loadPlugins({
    dirs: [root], enabled: ['demo'], logger: { info() {}, warn() {}, error() {} },
  }));
}

/** A real daemon on a real ephemeral port — this surface is an HTTP upgrade, so Hono's fetch-based test
 *  client cannot exercise it at all. */
async function startDaemon(opts: Parameters<typeof makeTestApp>[0] = {}) {
  const made = await makeTestApp({ ...opts, extra: { plugins: wsPluginProvider(), ...(opts.extra ?? {}) } });
  const server = await new Promise<ServerType>((resolve) => {
    const s: ServerType = serve({ fetch: made.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const attached = attachPluginWebSocketRoutes(server, made.serverDeps);
  teardown.push(async () => {
    attached.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  });
  return { ...made, port, attached, base: `ws://127.0.0.1:${port}` };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

type TestApp = Awaited<ReturnType<typeof startDaemon>>['app'];

async function mintTicket(app: TestApp, token: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request('/plugins/demo/api/ticket', {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { ticket: string }).ticket;
}

async function pluginState(app: TestApp, token: string) {
  const res = await app.request('/plugins/demo/api/state', { headers: bearer(token) });
  return await res.json() as {
    connections: number; aborted: number; closed: number[];
    seen: { auth: { userId: number | null; admin: boolean; tokenScope: string; accessibleProjects: number[] | null }; payload: unknown; params: Record<string, string>; query: Record<string, string> } | null;
    hasRegisterWebSocketRoute: boolean; hasIssueWebSocketTicket: boolean;
  };
}

interface Frame { data: Buffer; isBinary: boolean }

/** A client whose frame listener is attached before the socket is handed over. A per-await
 *  `once('message')` would drop every frame that lands between two awaits, and several of these routes
 *  answer the moment they are opened. */
interface Client {
  ws: WebSocket;
  next(): Promise<Frame>;
  closed: Promise<{ code: number; reason: string }>;
}

/** Resolve on the 101, or reject with the HTTP status the daemon answered instead. */
function open(url: string, options: { origin?: string; protocols?: string | string[] } = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options.protocols ?? [], options.origin === undefined ? {} : { origin: options.origin });
    const queued: Frame[] = [];
    const waiting: ((frame: Frame) => void)[] = [];
    ws.on('message', (data, isBinary) => {
      const frame: Frame = { data: data as Buffer, isBinary };
      const waiter = waiting.shift();
      if (waiter) waiter(frame); else queued.push(frame);
    });
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.once('close', (code, reason) => res({ code, reason: reason.toString('utf8') }));
    });
    const next = (): Promise<Frame> => {
      const ready = queued.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<Frame>((res, rej) => {
        waiting.push(res);
        void closed.then(() => rej(new Error('closed before a frame arrived')));
      });
    };
    ws.on('open', () => resolve({ ws, next, closed }));
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      reject(Object.assign(new Error(`upgrade refused with ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.on('error', (error) => reject(error));
  });
}

/** The refusal status, or 101 when the socket actually opened. */
async function refusalStatus(url: string, options?: Parameters<typeof open>[1]): Promise<number> {
  try {
    const client = await open(url, options);
    client.ws.close();
    await client.closed;
    return 101;
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
}

describe('plugin WebSocket routes (/ws/plugins/:name/*)', () => {
  it('redeems a valid ticket, upgrades, and echoes a binary frame byte-for-byte', async () => {
    const { app, token, base } = await startDaemon();
    const ticket = await mintTicket(app, token, { payload: { sessionId: 'vnc-1' } });
    const client = await open(`${base}/ws/plugins/demo/echo?ticket=${ticket}&scale=2`);

    // Exactly the bytes an RFB handshake would carry, including ones that are not valid UTF-8 on their own.
    const payload = Buffer.from([0x52, 0x46, 0x42, 0x00, 0xff, 0xfe, 0x80, 0x01]);
    client.ws.send(payload);
    const echoed = await client.next();
    expect(echoed.isBinary).toBe(true);
    expect(Buffer.compare(echoed.data, payload)).toBe(0);

    const state = await pluginState(app, token);
    expect(state.connections).toBe(1);
    expect(state.seen?.payload).toEqual({ sessionId: 'vnc-1' });
    expect(state.seen?.auth.tokenScope).toBe('user');
    // The spent ticket must not travel on into the plugin; every other parameter must.
    expect(state.seen?.query).toEqual({ scale: '2' });
    client.ws.close();
    await client.closed;
  });

  it('passes a requested subprotocol back, so a noVNC client gets its "binary" negotiation', async () => {
    const { app, token, base } = await startDaemon();
    const client = await open(`${base}/ws/plugins/demo/echo?ticket=${await mintTicket(app, token)}`, { protocols: 'binary' });
    expect(client.ws.protocol).toBe('binary');
    client.ws.close();
    await client.closed;
  });

  it('hands the handler the decoded :param segments', async () => {
    const { app, token, base } = await startDaemon();
    const client = await open(`${base}/ws/plugins/demo/session/abc-42?ticket=${await mintTicket(app, token)}`);
    const first = await client.next();
    expect(JSON.parse(first.data.toString('utf8'))).toEqual({ id: 'abc-42' });
    client.ws.close();
    await client.closed;
  });

  it('spends the ticket on the first use — a replay is refused before the upgrade', async () => {
    const { app, token, base } = await startDaemon();
    const ticket = await mintTicket(app, token);
    const client = await open(`${base}/ws/plugins/demo/echo?ticket=${ticket}`);
    client.ws.close();
    await client.closed;
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo?ticket=${ticket}`)).toBe(401);
  });

  it('refuses an expired ticket', async () => {
    const { app, token, base } = await startDaemon();
    const ticket = await mintTicket(app, token, { ttlMs: 0 });
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo?ticket=${ticket}`)).toBe(401);
  });

  it('refuses a missing ticket and a made-up one', async () => {
    const { base } = await startDaemon();
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo`)).toBe(401);
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo?ticket=nonsense`)).toBe(401);
  });

  it('refuses a ticket another plugin minted, even when it is otherwise valid', async () => {
    const { base } = await startDaemon();
    // Issued straight against the store so the foreign owner is unambiguous: a plugin can only ever mint
    // in its own name through PluginContext.
    const { ticket } = webSocketTickets.issue({ plugin: 'someone-else', userId: 1, ttlMs: 60_000 });
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo?ticket=${ticket}`)).toBe(401);
  });

  it('refuses an admin route to a ticket minted for an ordinary account', async () => {
    // The tenancy gate is only live with a userProjects store; without it every caller reads as admin.
    const { app, token, deps, base } = await startDaemon({ userProjects: true });
    deps.users.setAdmin(deps.users.list()[0]!.id, true);
    const plain = deps.users.create('josef', 'pw');
    const plainToken = deps.users.issueToken(plain.id);

    expect(await refusalStatus(`${base}/ws/plugins/demo/admin-only?ticket=${await mintTicket(app, plainToken)}`)).toBe(401);
    // The same route with an admin's ticket proves the refusal is about the ACCOUNT, not the route.
    expect(await refusalStatus(`${base}/ws/plugins/demo/admin-only?ticket=${await mintTicket(app, token)}`)).toBe(101);
  });

  it('resolves the ticket owner against the live stores, not against whoever asked for the upgrade', async () => {
    const { app, token, deps, base } = await startDaemon({ userProjects: true });
    deps.users.setAdmin(deps.users.list()[0]!.id, true);
    const plain = deps.users.create('josef', 'pw');
    const client = await open(`${base}/ws/plugins/demo/echo?ticket=${await mintTicket(app, deps.users.issueToken(plain.id))}`);
    client.ws.send('hi');
    await client.next();
    const state = await pluginState(app, token);
    expect(state.seen?.auth.userId).toBe(plain.id);
    expect(state.seen?.auth.admin).toBe(false);
    expect(state.seen?.auth.accessibleProjects).toEqual([]);
    client.ws.close();
    await client.closed;
  });

  it('refuses an upgrade whose Origin is not the host it is connecting to', async () => {
    const { app, token, base } = await startDaemon();
    const ticket = await mintTicket(app, token);
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo?ticket=${ticket}`, { origin: 'https://evil.example' })).toBe(403);
    // Refused BEFORE the ticket is redeemed, so a cross-site probe cannot burn a legitimate ticket.
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo?ticket=${ticket}`)).toBe(101);
  });

  it('accepts an Origin that matches the request Host', async () => {
    const { app, token, port, base } = await startDaemon();
    const ticket = await mintTicket(app, token);
    expect(await refusalStatus(`${base}/ws/plugins/demo/echo?ticket=${ticket}`, { origin: `http://127.0.0.1:${port}` })).toBe(101);
  });

  it('404s a path no plugin declared, including one the manifest did not allow', async () => {
    const { app, token, base } = await startDaemon();
    expect(await refusalStatus(`${base}/ws/plugins/demo/undeclared?ticket=${await mintTicket(app, token)}`)).toBe(404);
    expect(await refusalStatus(`${base}/ws/plugins/demo/nope?ticket=${await mintTicket(app, token)}`)).toBe(404);
    expect(await refusalStatus(`${base}/ws/plugins/other/echo?ticket=${await mintTicket(app, token)}`)).toBe(404);
    // Not our mount at all: answered rather than left hanging, because registering an upgrade listener
    // disables Node's own default for unhandled upgrades.
    expect(await refusalStatus(`${base}/ws/something-else`)).toBe(404);
  });

  it('closes with 1011 when the handler throws, without taking the daemon down', async () => {
    const { app, token, base } = await startDaemon();
    const client = await open(`${base}/ws/plugins/demo/boom?ticket=${await mintTicket(app, token)}`);
    expect((await client.closed).code).toBe(1011);
    // The daemon is still serving.
    expect((await app.request('/health')).status).toBe(200);
  });

  it('reports the socket\'s real buffered bytes, so a handler can apply backpressure', async () => {
    const { app, token, base } = await startDaemon();
    const client = await open(`${base}/ws/plugins/demo/echo?ticket=${await mintTicket(app, token)}`);
    client.ws.send('flood');
    let reported: number | undefined;
    while (reported === undefined) {
      const frame = await client.next();
      if (!frame.isBinary) reported = Number(frame.data.toString('utf8').replace('buffered:', ''));
    }
    expect(reported).toBeGreaterThan(0);
    client.ws.close();
    await client.closed;
  });

  it('hangs up the whole generation with 1001 and aborts the handler signal when the plugin reloads', async () => {
    const { app, token, base, serverDeps } = await startDaemon();
    const client = await open(`${base}/ws/plugins/demo/echo?ticket=${await mintTicket(app, token)}`);
    client.ws.send('hi');
    await client.next(); // the handler is live

    const registry = await serverDeps.plugins!.get();
    expect(registry.liveWebSockets.size).toBe(1);
    registry.closeWebSockets(1001, 'plugin reloaded');

    const closed = await client.closed;
    expect(closed.code).toBe(1001);
    expect(closed.reason).toBe('plugin reloaded');
    await vi.waitFor(async () => {
      const state = await pluginState(app, token);
      expect(state.aborted).toBe(1);
      expect(state.closed).toEqual([1001]);
    });
    expect(registry.liveWebSockets.size).toBe(0);
  });

  it('hangs up live sockets when the dispatcher is detached at daemon shutdown', async () => {
    const { app, token, base, attached } = await startDaemon();
    const client = await open(`${base}/ws/plugins/demo/echo?ticket=${await mintTicket(app, token)}`);
    attached.close();
    expect((await client.closed).code).toBe(1001);
  });

  // A plugin written against a newer daemon has to be able to ask an older one whether this surface
  // exists at all, so the NAME is part of the contract, not an implementation detail.
  it('exposes registerWebSocketRoute and issueWebSocketTicket on PluginContext by those names', async () => {
    const { app, token } = await startDaemon();
    const state = await pluginState(app, token);
    expect(state.hasRegisterWebSocketRoute).toBe(true);
    expect(state.hasIssueWebSocketTicket).toBe(true);
  });
});
