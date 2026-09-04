import { serve } from '@hono/node-server';
import { buildApp } from './bootstrap.js';
import { attachPluginWebSocketRoutes } from '../api/pluginWebSocket.js';
import { logger, LOG_DIR } from '../shared/logger.js';
import { dbPath } from '../shared/paths.js';

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
// stdout/stderr can break under the daemon while it is still running: a piped parent (the e2e harness,
// a `| head`, a detached shell) goes away and every later write raises EPIPE. That error surfaces as an
// uncaughtException, the handler below LOGS it, logging writes to the console again, and the next EPIPE
// re-enters the handler — an unbounded loop that also appends every iteration to the day's log file. It
// really happened: two e2e runs left a 30 GB daemon-<date>.log each and filled the disk. The CLI already
// guards this (src/cli/index.ts); a service must not exit on it, so swallow it instead — the write is
// already lost and the file sink still has the record.
const onStreamError = (e: NodeJS.ErrnoException): void => {
  if (e.code !== 'EPIPE') log.error('stdio stream error', e);
};
process.stdout.on('error', onStreamError);
process.stderr.on('error', onStreamError);

// A long-running daemon must survive a stray rejection/exception from one of its many fire-and-forget
// loops (deriver/scheduler/janitor/reconcile/relay). Node's default would exit the process and drop
// every live mission's orchestrator; log and keep running instead. EPIPE is excluded for the reason
// above: logging it is what feeds the loop.
const isEpipe = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'EPIPE';
process.on('unhandledRejection', (e) => { if (!isEpipe(e)) log.error('unhandledRejection', e); });
process.on('uncaughtException', (e) => { if (!isEpipe(e)) log.error('uncaughtException', e); });

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
    // The shared resolver, not a second copy of the rule: this one interpolated an unset HOME straight
    // into the path (a literal "undefined/.config/…", relative to the cwd) and let an EMPTY ELOWEN_DB
    // through, which SQLite opens as an anonymous temporary database — every conversation lost on restart,
    // silently. The launcher always injects ELOWEN_DB, so only a directly started unit hits this.
    dbPath: dbPath(process.env),
    project: { id: 1, slug: process.env.ELOWEN_PROJECT ?? 'elowen', path: process.env.ELOWEN_PROJECT_PATH ?? process.cwd() },
    relay: relayUrl ? { baseUrl: relayUrl, apiKey: process.env.ELOWEN_RELAY_KEY ?? '', model: process.env.ELOWEN_RELAY_MODEL ?? 'gpt-4o-mini' } : null,
    bootstrap: bootstrapUser && bootstrapPass ? { username: bootstrapUser, password: bootstrapPass } : null,
    allowOpen: process.env.ELOWEN_ALLOW_OPEN === '1',
  });
} catch (e) {
  log.error('daemon boot failed', e);
  process.exit(1);
}
const { app, startLoops, serverDeps } = built;

// Bind to localhost by default: a daemon token can spawn agents (effectively RCE), so the daemon
// must not be publicly reachable. Front it with the web app's BFF proxy (or a reverse proxy). Set
// ELOWEN_HOST=0.0.0.0 to expose it deliberately (e.g. web app on a separate host).
const host = (process.env.ELOWEN_HOST) ?? '127.0.0.1';
const server = serve({
  fetch: app.fetch,
  port: Number((process.env.ELOWEN_PORT) ?? 4400),
  hostname: host,
}, info => {
  log.info(`elowen serve on ${host}:${info.port} — logs → ${LOG_DIR}`);
  // Boot reconcile terminalizes delegation rows left `running` by a previous process, which is only
  // safe when nothing else is serving them — a live delegation is registered in daemon memory, so a
  // second instance cannot tell ours apart from a crashed one and would kill it. Winning the port is
  // what establishes that: run the loops only once the bind succeeded, never before. This still does
  // not cover a second daemon started on a *different* port against the same database.
  startLoops();
});
// Plugin WebSocket routes ride on THIS server, not a sidecar: nginx proxies `/ws/` to this same port, so
// a browser socket and a REST call reach the daemon through one process and one bind. Attached after
// serve() because the upgrade listener needs the Node server object it returns.
attachPluginWebSocketRoutes(server, serverDeps);

// Without an error handler an EADDRINUSE (zombie daemon still holding the port) crashes with a bare
// stack trace; give it a clear exit message instead.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') log.error(`port ${(process.env.ELOWEN_PORT) ?? 4400} already in use, exiting`);
  else log.error('server error', e);
  process.exit(1);
});
