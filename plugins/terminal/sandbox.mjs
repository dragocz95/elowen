// Filesystem confinement for shell commands run by a NON-ADMIN account.
//
// The problem this closes: `ctx.assertPathAllowed` guards the cwd a command STARTS in, but a shell reads
// and writes any absolute path afterwards, so the project boundary the file tools enforce simply did not
// apply to Bash. A non-admin granted `terminal` could read the daemon's own database (provider API keys
// live there in plaintext) or any other project on the host.
//
// The approach is a mount namespace, not command inspection. Nothing here ever looks at what the command
// says: the caller's command string is handed to the inner shell through an environment variable, so
// there is no parsing, no escaping and no pattern to defeat with `$(...)`, base64 or a script file.
// Whatever the command does, it can only reach paths that were bound into the namespace.
//
// Privilege escalation is closed as a side effect that matters more than the mounts: bubblewrap always
// sets PR_SET_NO_NEW_PRIVS, so setuid binaries stop conferring privilege and `sudo` refuses to run at all.
// That holds regardless of what the host's sudoers file says.
import { realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BWRAP = '/usr/bin/bwrap';

// The variable carrying the user's command into the sandbox. The inner shell expands it ONCE, quoted, so
// the command arrives as a single argument exactly as written.
const CMD_VAR = 'ELOWEN_SANDBOX_CMD';

// Environment the sandboxed shell inherits. The daemon's own variables are deliberately absent: ELOWEN_DB,
// ELOWEN_LOG_DIR, ELOWEN_HOST/PORT and ELOWEN_PROJECT_PATH name daemon-internal locations, and a confined
// shell has no business learning them (it cannot reach them anyway, but pointing at them is still noise
// the model would try to act on). No provider credentials pass through here — they are not in the
// daemon's environment to begin with; they live in the config database, which the mounts exclude.
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'];

/** Whether this host can sandbox at all. Bubblewrap works unprivileged through its AppArmor profile on
 *  Ubuntu 24.04; it is NOT setuid and needs no root. A generic `unshare` launcher is not an alternative
 *  here: unprivileged user namespaces are restricted to profiled binaries
 *  (kernel.apparmor_restrict_unprivileged_userns=1), and bwrap is one of them. */
export function sandboxAvailable() {
  try {
    realpathSync(BWRAP);
    return true;
  } catch {
    return false;
  }
}

/** Per-account writable HOME, kept across calls so npm's cache, pip and .gitconfig survive between
 *  commands. It lives under the plugin's data dir and is bound only into that account's own sandbox.
 *  The daemon's real HOME (/var/www) is never bound, which also means no ambient SSH keys: pushing over
 *  ssh needs a key placed in this directory. */
function accountHome(dataDir, userId) {
  const dir = join(dataDir, 'sandbox-home', String(userId ?? 'anonymous'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the roots to bind. `allowedRoots()` may contain symlinks while a bind mount needs the real
 *  path, and a root that no longer exists on disk must be skipped rather than abort the whole run. */
function bindableRoots(roots) {
  const out = [];
  for (const root of roots) {
    try {
      const real = realpathSync(root);
      if (!out.includes(real)) out.push(real);
    } catch {
      // A project row pointing at a deleted directory: nothing to bind, and the cwd guard already
      // refuses to start a command there.
    }
  }
  return out;
}

/**
 * Build the sandboxed form of a shell command.
 *
 * Returns the command string to spawn (with `shell: true`, as both call sites already do) and the
 * environment to spawn it with. The OUTER shell expands `"$ELOWEN_SANDBOX_CMD"` from that environment
 * into one quoted argument for the inner shell; the user's command text is never inspected or rewritten.
 *
 * Throws when the account has no reachable root — a shell with nothing bound could not even chdir, and
 * refusing loudly is better than starting a command in an empty namespace.
 */
export function sandboxRun({ command, cwd, roots, dataDir, userId }) {
  const binds = bindableRoots(roots);
  if (binds.length === 0) {
    throw new Error('no accessible project directory: ask an administrator to assign you a project before using the shell');
  }
  const home = accountHome(dataDir, userId);

  const args = [
    // Unshare everything EXCEPT the network. Network access is deliberate: npm install, git fetch, calling
    // an API and running a dev server are most of the reason the shell is worth granting, and a shell the
    // agent abandons is worse than no shell. It is the widest hole this design knowingly leaves.
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    // Tie the sandbox's lifetime to the daemon process that spawned it, and make bwrap PID 1 of its own
    // namespace so killing it takes the whole tree down with it. This is strictly stronger than the
    // process-group kill the plugin does today, so ListProcesses/KillProcess keep working unchanged.
    '--die-with-parent',
    // Detach from the daemon's controlling terminal: without it a sandboxed process can push characters
    // back into the parent's tty with TIOCSTI and type into the operator's own session.
    '--new-session',
    // The toolchain, read-only and whole. Curating a list of permitted binaries would be a maintenance
    // burden with no security benefit: everything here is already world-readable on the host.
    '--ro-bind', '/usr', '/usr',
    // Needed for DNS, TLS roots, user lookup and timezone. Read-only.
    '--ro-bind', '/etc', '/etc',
    // Ubuntu's merged-/usr layout: these are symlinks on the host and must be recreated inside.
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/sbin', '/sbin',
    // Fresh kernel filesystems, and a private /tmp that dies with the command.
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];

  // The account's own projects, writable. This is the same set `assertPathAllowed` enforces for the file
  // tools, read at dispatch time from the turn's policy, so the shell and the file tools now agree.
  for (const root of binds) args.push('--bind', root, root);
  args.push('--bind', home, home);
  args.push('--setenv', 'HOME', home);
  args.push('--chdir', cwd);
  args.push('--', '/bin/bash', '-c');

  const env = { [CMD_VAR]: command, HOME: home };
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  // `"$ELOWEN_SANDBOX_CMD"` is appended RAW, deliberately outside shellWord: it is the one word that must
  // stay unquoted here so the outer shell expands it. Double quotes make that expansion a single argument
  // regardless of what the command contains, so no word splitting or re-interpretation can occur.
  return { command: `exec ${BWRAP} ${args.map(shellWord).join(' ')} "$${CMD_VAR}"`, env };
}

/** Quote ONE argument of the bwrap invocation we build ourselves — never the user's command, which
 *  travels in the environment precisely so it is never quoted or parsed. Paths come from project
 *  configuration and can contain spaces. */
function shellWord(word) {
  if (/^[A-Za-z0-9_/.:=-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
