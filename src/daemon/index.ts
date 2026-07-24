import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { buildApp } from './bootstrap.js';
import { terminalWsHandler } from '../terminal/wsHandler.js';
import { loadPty } from '../terminal/ptyLoader.js';
import { logger, LOG_DIR } from '../shared/logger.js';

const log = logger('daemon');

// Default Anthropic prompt-cache retention to 1h (pi-ai's PI_CACHE_RETENTION knob, read per request at
// stream time). Long sessions keep cache-read hits across thinking pauses instead of re-caching the whole
// prefix every 5 idle minutes; the tool-result clearing gate (brain/session/toolResultClearing) reads the
// same variable so its idle threshold always tracks the real TTL. `??=` keeps an operator override
// (systemd unit) winning over the default.
process.env.PI_CACHE_RETENTION ??= 'long';

// A long-running daemon must survive a stray rejection/exception from one of its many fire-and-forget
// loops (deriver/scheduler/janitor/reconcile/relay). Node's default would exit the process and drop
// every live mission's orchestrator; log and keep running instead.
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));

// Runtime env. Bound to locals so control-flow narrowing works in the guards below.
const relayUrl = process.env.ELOWEN_RELAY_URL;
const bootstrapUser = process.env.ELOWEN_BOOTSTRAP_USER;
const bootstrapPass = process.env.ELOWEN_BOOTSTRAP_PASS;

// buildApp is async (it awaits the brain ModelRuntime). A boot failure must exit non-zero and loudly:
// without this the rejection would be swallowed by the unhandledRejection handler above (meant to keep a
// RUNNING daemon alive), leaving a half-started process that systemd reads as a clean exit.
let built: Awaited<ReturnType<typeof buildApp>>;
try {
  built = await buildApp({
    dbPath: process.env.ELOWEN_DB ?? `${process.env.HOME}/.config/elowen/elowen.db`,
    project: { id: 1, slug: process.env.ELOWEN_PROJECT ?? 'elowen', path: process.env.ELOWEN_PROJECT_PATH ?? process.cwd() },
    relay: relayUrl ? { baseUrl: relayUrl, apiKey: process.env.ELOWEN_RELAY_KEY ?? '', model: process.env.ELOWEN_RELAY_MODEL ?? 'gpt-4o-mini' } : null,
    bootstrap: bootstrapUser && bootstrapPass ? { username: bootstrapUser, password: bootstrapPass } : null,
    allowOpen: process.env.ELOWEN_ALLOW_OPEN === '1',
  });
} catch (e) {
  log.error('daemon boot failed', e);
  process.exit(1);
}
const { app, startLoops, tickets, tmux } = built;

// Real-PTY terminal stream: the browser opens wss://…/ws/terminal?ticket=… straight at the daemon
// (nginx proxies /ws/ here), the handler redeems the single-use ticket and bridges a tmux-attached PTY
// to the socket. The upgrade is handled by node-server itself (v2 built-in WS): the `ws` server below
// is passed to `serve()` as `websocket.server` and must stay `noServer` — node-server owns the upgrade.
app.get('/ws/terminal', upgradeWebSocket(terminalWsHandler({
  tickets,
  loadPty,
  // A client resize must also resize the tmux *window* — the advisor session is `window-size manual`,
  // so the PTY size alone won't reflow the content to fill the panel.
  resizeWindow: (session, cols, rows) => { void tmux.resize(session, cols, rows); },
})));

startLoops();
// Bind to localhost by default: a daemon token can spawn agents (effectively RCE), so the daemon
// must not be publicly reachable. Front it with the web app's BFF proxy (or a reverse proxy). Set
// ELOWEN_HOST=0.0.0.0 to expose it deliberately (e.g. web app on a separate host).
const host = (process.env.ELOWEN_HOST) ?? '127.0.0.1';
const server = serve({
  fetch: app.fetch,
  port: Number((process.env.ELOWEN_PORT) ?? 4400),
  hostname: host,
  websocket: { server: new WebSocketServer({ noServer: true }) },
}, info => log.info(`elowen serve on ${host}:${info.port} — logs → ${LOG_DIR}`));
// Without an error handler an EADDRINUSE (zombie daemon still holding the port) crashes with a bare
// stack trace; give it a clear exit message instead.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') log.error(`port ${(process.env.ELOWEN_PORT) ?? 4400} already in use, exiting`);
  else log.error('server error', e);
  process.exit(1);
});
