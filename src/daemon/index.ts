import { serve } from '@hono/node-server';
import { buildApp } from './bootstrap.js';

const { app, startLoops } = buildApp({
  dbPath: process.env.ORCA_DB ?? `${process.env.HOME}/.config/orca/orca.db`,
  project: { id: 1, slug: process.env.ORCA_PROJECT ?? 'orca', path: process.env.ORCA_PROJECT_PATH ?? process.cwd() },
  relay: process.env.ORCA_RELAY_URL ? { baseUrl: process.env.ORCA_RELAY_URL, apiKey: process.env.ORCA_RELAY_KEY ?? '', model: process.env.ORCA_RELAY_MODEL ?? 'gpt-4o-mini' } : null,
  bootstrap: process.env.ORCA_BOOTSTRAP_USER && process.env.ORCA_BOOTSTRAP_PASS ? { username: process.env.ORCA_BOOTSTRAP_USER, password: process.env.ORCA_BOOTSTRAP_PASS } : null,
  allowOpen: process.env.ORCA_ALLOW_OPEN === '1',
});
startLoops();
serve({ fetch: app.fetch, port: Number(process.env.ORCA_PORT ?? 4400) }, info => console.log(`orca serve on :${info.port}`));
