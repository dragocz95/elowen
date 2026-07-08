import { join } from 'node:path';

/** Single source of truth for where a globally-installed elowen keeps its state. Everything persistent
 *  lives OUTSIDE the npm package (which `npm update` overwrites): the SQLite DB, logs and the run
 *  file all sit under `~/.config/elowen` so an update never touches user data. Each resolver takes the
 *  process env so it stays pure and testable; the daemon's own default (src/daemon/index.ts) matches. */
export function dataDir(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? '', '.config', 'elowen');
}

export function dbPath(env: NodeJS.ProcessEnv): string {
  return env.ELOWEN_DB ?? join(dataDir(env), 'elowen.db');
}

export function logDir(env: NodeJS.ProcessEnv): string {
  return env.ELOWEN_LOG_DIR ?? join(dataDir(env), 'logs');
}

export function runFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'run.json');
}
