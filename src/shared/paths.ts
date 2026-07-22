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

/** Where a session's cleared tool results are spilled before the context placeholder replaces them.
 *  One directory per session, so pathGuard can scope read access to the OWNING session and session
 *  deletion can remove the whole directory. The id is URI-encoded (and dot-segments prefixed): it
 *  becomes a filesystem path in a security check, so a future platform minting `/`, `%` or `..`
 *  into its channel ids must not smuggle the allowance outside `tool-results/`. Encoding is
 *  injective, so two distinct ids can never collide into one directory. */
export function toolResultSpillDir(env: NodeJS.ProcessEnv, sessionId: string): string {
  const encoded = encodeURIComponent(sessionId);
  const safe = encoded === '' || encoded === '.' || encoded === '..' ? `_${encoded}` : encoded;
  return join(dataDir(env), 'tool-results', safe);
}
