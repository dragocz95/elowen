import type { Runner } from './runner.js';

/** Resolve (and, when asked, create) the unprivileged user the ELOWEN services + agents run as. The
 *  services never run as root; agents run in tmux as this user, and their CLI auth + ~/.config/elowen
 *  live in its HOME. */
export interface ServiceUserChoice { mode: 'create' | 'existing'; username: string }

/** HOME directory of a user from getent, or null when the user doesn't exist. */
export async function userHome(r: Runner, username: string): Promise<string | null> {
  const res = await r.exec('getent', ['passwd', username]);
  if (res.code !== 0) return null;
  const home = res.stdout.trim().split(':')[5];
  return home || null;
}

/** The invoking user, for the macOS install where everything runs per-user (launchd gui domain, brew,
 *  npm prefix) — there is no dedicated service account to create. */
export async function currentUser(r: Runner, env: NodeJS.ProcessEnv = process.env): Promise<{ username: string; home: string }> {
  const res = await r.exec('id', ['-un']);
  const username = res.stdout.trim() || 'unknown';
  return { username, home: env.HOME ?? `/Users/${username}` };
}

/** Create the service user (idempotent) or validate the chosen existing one, returning its resolved
 *  username + HOME. A created user is a `--system` account with its own HOME and a real shell (so
 *  `sudo -u … -H bash -lc` gives the agent CLIs a normal environment). */
export async function ensureServiceUser(r: Runner, choice: ServiceUserChoice): Promise<{ username: string; home: string }> {
  const existingHome = await userHome(r, choice.username);

  if (choice.mode === 'existing') {
    if (!existingHome) throw new Error(`user '${choice.username}' does not exist`);
    return { username: choice.username, home: existingHome };
  }

  if (!existingHome) {
    const home = `/var/lib/${choice.username}`;
    const res = await r.exec('useradd', ['--system', '--create-home', '--home-dir', home, '--shell', '/bin/bash', choice.username]);
    if (res.code !== 0) throw new Error(`useradd failed: ${res.stderr.trim() || res.code}`);
    return { username: choice.username, home };
  }
  return { username: choice.username, home: existingHome };
}
