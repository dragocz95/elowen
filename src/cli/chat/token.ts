import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../paths.js';

/** Thrown by resolveToken when no token is available anywhere — the caller runs an interactive login. */
export class NeedsLogin extends Error {
  constructor() { super('no orca token — run `orca login`'); this.name = 'NeedsLogin'; }
}

/** Injectable IO so token resolution is unit-testable without touching the real filesystem/network. */
export interface TokenIo {
  read(path: string): string | null;   // null when the file is missing
  write(path: string, data: string): void; // must persist 0600
  remove(path: string): void;
}

/** Default IO: the cache file is written 0600 (it holds a full-scope bearer token). */
export const defaultIo: TokenIo = {
  read(path) { try { return readFileSync(path, 'utf-8'); } catch { return null; } },
  write(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600); // enforce even if the file pre-existed with looser perms
  },
  remove(path) { rmSync(path, { force: true }); },
};

/** Absolute path of the CLI's cached-token file (alongside the DB, never inside the npm package). */
export function tokenFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'cli.json');
}

/** Resolve a full-scope token without a password prompt when possible: env → cached file → NeedsLogin. */
export function resolveToken(env: NodeJS.ProcessEnv, io: TokenIo = defaultIo): string {
  const fromEnv = env.ORCA_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const raw = io.read(tokenFile(env));
  if (raw) {
    // Corrupt/partial cache must degrade to a re-login, not crash the CLI.
    try { const parsed = JSON.parse(raw) as { token?: string }; if (parsed.token) return parsed.token; }
    catch { /* fall through to NeedsLogin */ }
  }
  throw new NeedsLogin();
}

/** Interactive login: exchange credentials for a token and cache it 0600. Returns the token. */
export async function login(
  base: string, creds: { username: string; password: string },
  env: NodeJS.ProcessEnv, io: TokenIo = defaultIo, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  let token: string | undefined;
  try { token = ((await res.json()) as { token?: string }).token; }
  catch { throw new Error('login failed: non-JSON response'); }
  if (!token) throw new Error('login failed: no token in response');
  io.write(tokenFile(env), JSON.stringify({ token }));
  return token;
}

/** Drop the cached token (called on a 401 so the next run re-logs in). */
export function clearToken(env: NodeJS.ProcessEnv, io: TokenIo = defaultIo): void {
  io.remove(tokenFile(env));
}
