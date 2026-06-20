import { serve } from '@hono/node-server';
import { buildApp } from './bootstrap.js';

// A long-running daemon must survive a stray rejection/exception from one of its many fire-and-forget
// loops (deriver/scheduler/janitor/reconcile/relay). Node's default would exit the process and drop
// every live mission's orchestrator; log and keep running instead.
process.on('unhandledRejection', (e) => console.error('[orca] unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('[orca] uncaughtException', e));

const { app, startLoops } = buildApp({
  dbPath: process.env.ORCA_DB ?? `${process.env.HOME}/.config/orca/orca.db`,
  project: { id: 1, slug: process.env.ORCA_PROJECT ?? 'orca', path: process.env.ORCA_PROJECT_PATH ?? process.cwd() },
  relay: process.env.ORCA_RELAY_URL ? { baseUrl: process.env.ORCA_RELAY_URL, apiKey: process.env.ORCA_RELAY_KEY ?? '', model: process.env.ORCA_RELAY_MODEL ?? 'gpt-4o-mini' } : null,
  bootstrap: process.env.ORCA_BOOTSTRAP_USER && process.env.ORCA_BOOTSTRAP_PASS ? { username: process.env.ORCA_BOOTSTRAP_USER, password: process.env.ORCA_BOOTSTRAP_PASS } : null,
  allowOpen: process.env.ORCA_ALLOW_OPEN === '1',
});
startLoops();
const server = serve({ fetch: app.fetch, port: Number(process.env.ORCA_PORT ?? 4400) }, info => console.log(`orca serve on :${info.port}`));
// Without an error handler an EADDRINUSE (zombie daemon still holding the port) crashes with a bare
// stack trace; give it a clear exit message instead.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`[orca] port ${process.env.ORCA_PORT ?? 4400} already in use, exiting`);
  else console.error('[orca] server error', e);
  process.exit(1);
});
