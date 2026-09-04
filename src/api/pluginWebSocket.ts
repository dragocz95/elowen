/** The daemon's WebSocket upgrade surface for plugin routes: `/ws/plugins/<plugin>/<path>`.
 *
 *  It hangs off the SAME Node http server the REST app is served from (port 4400), because the browser
 *  reaches it through the nginx `location /ws/` block the installer writes — one proxy_pass, one port, no
 *  second daemon-side process to supervise.
 *
 *  That path bypasses the web BFF, so the browser carries no Elowen bearer token and none of Hono's auth
 *  middleware can run here. Authentication is therefore by one-shot TICKET (see plugins/wsTickets.ts),
 *  minted by the plugin from an already authenticated API request and redeemed HERE, BEFORE the
 *  handshake: an unusable ticket gets a plain HTTP 401 and no 101 at all, so a client can distinguish
 *  "not authorised" from "the handler hung up on me". */

import { WebSocketServer, type RawData, type WebSocket as WsSocket } from 'ws';
import { logger } from '../shared/logger.js';
import { clientOrigin } from './clientIp.js';
import { accessContextFor, createAccessHelpers } from './context.js';
import { webSocketTickets } from '../plugins/wsTickets.js';
import { isPluginAllowedForUser } from '../shared/pluginAccess.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerDeps } from './deps.js';
import type { PluginApiAuth, PluginWebSocketConnection } from '../plugins/api.js';

/** Everything this handler owns. Nginx proxies the whole `/ws/` prefix to the daemon, so the plugin
 *  namespace is nested one level deeper to leave room for core sockets later. */
const MOUNT = '/ws/plugins/';

/** Per-frame cap. Generous for the byte protocols this carries (an RFB update, a clipboard transfer) and
 *  still a bound, because a frame is buffered whole before the handler sees it. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const log = logger('plugin-ws');

/** ws hands a message as a Buffer, or as the fragment array when a message arrived fragmented. */
function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

/** Answer an upgrade request with a plain HTTP status and hang up. Deliberately body-less and
 *  reason-less: the client learns whether it may connect and nothing about why not. */
function refuse(socket: Duplex, status: number, text: string): void {
  // `end`, not `write` + `destroy`: destroying discards anything still queued, and a client that never
  // receives the status sees a bare connection reset — indistinguishable from the daemon being down.
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  else socket.destroy();
}

/** Same-origin rule for the handshake. A WebSocket upgrade is NOT covered by CORS — the browser sends it
 *  cross-origin without a preflight — so `Origin` is the only thing standing between a page on another
 *  site and a socket opened with the visitor's credentials. There is no configured public origin in the
 *  daemon's `security.*` config to compare against, and inventing a second deployment setting beside the
 *  install wizard's `publicUrl` would be a parallel source of truth; the request's own `Host` is what
 *  nginx already had to route by, so that is the comparison.
 *
 *  A request with NO Origin at all is accepted: that is a non-browser client (a CLI, a test, a native
 *  viewer), which is not what this rule protects against. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  const host = hostnameOf(req.headers.host);
  if (host === undefined) return false;
  try {
    // HOSTNAME, not host:port. The installed vhost forwards `Host $host`, which nginx defines WITHOUT
    // the port, so on any deployment served on a non-default port the browser's Origin would carry a
    // port the daemon never sees and every legitimate socket would be refused.
    return new URL(origin).hostname === host;
  } catch {
    // Includes the literal `null` origin a sandboxed iframe sends.
    return false;
  }
}

/** The hostname of a `Host` header value, port stripped, IPv6 literals kept in their brackets so the two
 *  sides of the comparison are written the same way. */
function hostnameOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  try { return new URL(`http://${value}`).hostname; } catch { return undefined; }
}

/** The one seam this needs from the running server. Structural rather than `http.Server` because
 *  `@hono/node-server`'s `serve()` types its return as a union that also covers an http2 server, and
 *  nothing here cares which concrete class emits the upgrade. */
type UpgradeCapableServer = {
  on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

/** Mount the plugin WebSocket dispatcher on a running http server. Returns a handle whose `close()`
 *  detaches the listener and hangs up every live connection — called by the daemon's terminal shutdown
 *  and by tests. */
export function attachPluginWebSocketRoutes(server: UpgradeCapableServer, d: ServerDeps): { close(): void } {
  const gates = createAccessHelpers(d);
  // noServer: the upgrade is routed by us, not by ws — the same server also serves REST, and ws must not
  // claim every upgrade on it. perMessageDeflate stays off (ws's default): RFB frames are already
  // compressed and per-message deflate would add a zlib context per connection for nothing.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const handle = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    // Whoever is knocking, resolved through the ONE place that decides whether a proxy header may be
    // believed. Used for the refusal logs only — never the ticket, which must not reach a log line.
    const who = clientOrigin({ req: { header: (name: string) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    } } }, d.config.get().security.trustProxy).value;

    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); }
    catch { return refuse(socket, 400, 'Bad Request'); }

    // Registering ANY 'upgrade' listener disables Node's own "destroy what nobody handled" default, so a
    // path outside this mount would otherwise leave the socket hanging open forever. This is the daemon's
    // only upgrade owner; a second one would have to take over this refusal.
    if (!url.pathname.startsWith(MOUNT)) return refuse(socket, 404, 'Not Found');

    if (!originAllowed(req)) {
      log.warn(`websocket upgrade from ${who} refused: origin '${String(req.headers.origin)}' does not match host '${String(req.headers.host)}'`);
      return refuse(socket, 403, 'Forbidden');
    }

    const rest = url.pathname.slice(MOUNT.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return refuse(socket, 404, 'Not Found');
    const plugin = decodeURIComponent(rest.slice(0, slash));
    const routePath = rest.slice(slash + 1);

    const registry = await d.plugins?.get().catch(() => undefined);
    const match = registry?.wsRoute(plugin, routePath);
    if (!registry || !match) return refuse(socket, 404, 'Not Found');

    // One-shot: `redeem` spends the ticket on the ATTEMPT, so a replay of the same string never reaches
    // the checks below. A ticket minted by ANOTHER plugin is refused here too — the mount it was issued
    // for is part of what the ticket authorises.
    const presented = url.searchParams.get('ticket');
    const ticket = presented === null ? undefined : webSocketTickets.redeem(presented);
    if (!ticket || ticket.plugin !== plugin) {
      log.warn(`websocket upgrade from ${who} to /ws/plugins/${plugin}/${routePath} refused: no valid ticket`);
      return refuse(socket, 401, 'Unauthorized');
    }

    // The ticket names an ACCOUNT; its authority is resolved now, from the live stores, so a ticket
    // minted before a demotion cannot carry the permissions the account no longer has.
    const user = (ticket.userId !== null ? d.users?.get(ticket.userId) : undefined) ?? undefined;
    const c = accessContextFor(user);
    // 401 rather than 403 throughout: the ticket IS the credential here, and one that does not clear the
    // route's access level is simply not a credential for this route.
    if (match.access === 'admin' && gates.notAdminUnlessSetup(c)) {
      log.warn(`websocket upgrade from ${who} to /ws/plugins/${plugin}/${routePath} refused: ticket owner is not an admin`);
      return refuse(socket, 401, 'Unauthorized');
    }
    // Per-user grant, checked centrally exactly as the API dispatcher does it, so a grantable plugin
    // cannot grow an ungated surface by opening a socket instead of a route.
    if (registry.userGrantable.has(plugin) && !isPluginAllowedForUser(user, { name: plugin, userGrantable: true })) {
      log.info(`plugin ${plugin} websocket refused for user ${ticket.userId ?? 'anonymous'}: not granted`);
      return refuse(socket, 403, 'Forbidden');
    }

    const projects = gates.accessibleProjects(c);
    const auth: PluginApiAuth = {
      userId: ticket.userId,
      admin: !gates.notAdmin(c),
      tokenScope: 'user',
      accessibleProjects: projects === null ? null : [...projects],
    };
    const query: Record<string, string> = {};
    // The ticket is spent and must not travel any further — not into a plugin that logs its own
    // connection parameters, and not into a crash dump.
    url.searchParams.forEach((value, key) => { if (key !== 'ticket') query[key] = value; });

    wss.handleUpgrade(req, socket, head, (ws) => {
      accept(ws, registry, { plugin, routePath, auth, payload: ticket.payload, params: match.params, query, handler: match.handler, logger: match.logger });
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // The handler is async (it resolves the plugin registry). Nothing it awaits can reject — every
    // failure path answers a status — but a stray throw must destroy the socket rather than surface as an
    // unhandled rejection with the client left hanging.
    void handle(req, socket, head).catch((error: unknown) => {
      log.error('websocket upgrade failed', error);
      refuse(socket, 500, 'Internal Server Error');
    });
  };
  server.on('upgrade', onUpgrade);

  return {
    close(): void {
      server.off('upgrade', onUpgrade);
      d.plugins?.peek()?.closeWebSockets(1001, 'daemon shutting down');
      wss.close();
    },
  };
}

/** Everything resolved during the handshake, handed to the accepted connection. */
interface AcceptedRoute {
  plugin: string;
  routePath: string;
  auth: PluginApiAuth;
  payload: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  handler: (conn: PluginWebSocketConnection) => void | Promise<void>;
  logger: { warn: (m: string) => void };
}

/** Wrap an upgraded socket in the plugin-facing connection and run the route's handler.
 *
 *  Registered on the registry GENERATION that matched the route, so a plugin reload can hang up exactly
 *  the connections its old code is still driving. */
function accept(ws: WsSocket, registry: { liveWebSockets: Set<{ plugin: string; close: (code: number, reason: string) => void }> }, route: AcceptedRoute): void {
  const controller = new AbortController();
  const shut = (code: number, reason: string): void => {
    // A close handshake needs the socket readable; a paused one would never see the peer's reply.
    ws.resume();
    try { ws.close(code, reason); } catch { ws.terminate(); }
  };
  const entry = { plugin: route.plugin, close: shut };
  registry.liveWebSockets.add(entry);

  // Paused until the handler has had its say. An async handler that registers `onMessage` after an await
  // would otherwise silently drop every frame that arrived in between — ws discards a 'message' with no
  // listener. Pausing applies real TCP backpressure instead of buffering those frames in the daemon.
  ws.pause();
  let resumed = false;
  const resume = (): void => { if (!resumed) { resumed = true; ws.resume(); } };

  const conn: PluginWebSocketConnection = {
    auth: route.auth,
    payload: route.payload,
    params: route.params,
    query: route.query,
    // `binary: true` is what keeps a byte protocol intact: without it ws would send a Uint8Array as a
    // TEXT frame, and the peer would receive UTF-8-mangled bytes.
    send: (data) => { if (typeof data === 'string') ws.send(data); else ws.send(data, { binary: true }); },
    onMessage: (cb) => {
      ws.on('message', (raw: RawData, isBinary: boolean) => {
        const bytes = toBuffer(raw);
        cb(isBinary ? bytes : bytes.toString('utf8'), isBinary);
      });
      resume();
    },
    onClose: (cb) => { ws.on('close', (code: number, reason: Buffer) => cb(code, reason.toString('utf8'))); },
    close: (code, reason) => shut(code ?? 1000, reason ?? ''),
    signal: controller.signal,
    bufferedAmount: () => ws.bufferedAmount,
  };

  ws.on('close', () => {
    registry.liveWebSockets.delete(entry);
    controller.abort();
  });
  // A transport error ends the connection anyway ('close' follows); log it under the plugin's name so an
  // operator sees whose socket died rather than an anonymous one.
  ws.on('error', (error: Error) => { route.logger.warn(`websocket transport error on ${route.routePath}: ${error.message}`); });

  // The handler owns the conversation from here. A throw is the PLUGIN's failure, not the daemon's: close
  // 1011 (internal error) and report it under the plugin's logger, never let it reach the process.
  void (async () => { await route.handler(conn); })()
    .catch((error: unknown) => {
      route.logger.warn(`websocket handler for ${route.routePath} failed: ${error instanceof Error ? error.message : String(error)}`);
      shut(1011, 'handler failed');
    })
    // A handler that never reads still has to let the close handshake through.
    .finally(resume);
}
