import { spawnSync } from 'node:child_process';
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
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const BWRAP = '/usr/bin/bwrap';

// The variable carrying the user's command into the sandbox. The inner shell expands it ONCE, quoted, so
// the command arrives as a single argument exactly as written.
const CMD_VAR = 'ELOWEN_SANDBOX_CMD';

// HOME for a caller that can be keyed to neither an account nor a session. Lives on the per-command
// tmpfs, so it is writable but shared with nobody and does not persist.
const EPHEMERAL_HOME = '/tmp/home';

// Environment the sandboxed shell inherits. The daemon's own variables are deliberately absent: ELOWEN_DB,
// ELOWEN_LOG_DIR, ELOWEN_HOST/PORT and ELOWEN_PROJECT_PATH name daemon-internal locations, and a confined
// shell has no business learning them (it cannot reach them anyway, but pointing at them is still noise
// the model would try to act on). No provider credentials pass through here — they are not in the
// daemon's environment to begin with; they live in the config database, which the mounts exclude.
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'];

// What a working toolchain actually needs out of /etc, named individually.
//
// Binding the whole of /etc would be simpler and was the first shape of this file, but it hands every
// sandboxed account every host config file the daemon user can read. Nothing there is secret on THIS
// host today, which is exactly why it is worth pinning now: the moment somebody drops a service, proxy
// or registry credential into /etc, whole-/etc would quietly recreate the hole this module exists to
// close. Each entry is bound with --ro-bind-try, so an entry missing on some host is skipped rather than
// aborting the command.
const ETC_ALLOWLIST = [
  'hosts', 'host.conf', 'nsswitch.conf', 'gai.conf',   // name resolution
  'passwd', 'group',                                   // uid/gid lookup, needed by git and ssh-less tools
  'ssl', 'pki', 'ca-certificates', 'ca-certificates.conf', // TLS trust roots
  'localtime', 'timezone',
  'alternatives',                                      // /usr/bin/python3 and friends resolve through here
  'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d',         // dynamic linker
  'gitconfig', 'gitattributes',                        // system-level git config
  'npmrc',                                             // system-level npm config (registry, proxy)
  'python3',
  'terminfo',
];

/** Whether this host can sandbox at all. Bubblewrap works unprivileged through its AppArmor profile on
 *  Ubuntu 24.04; it is NOT setuid and needs no root. A generic `unshare` launcher is not an alternative
 *  here: unprivileged user namespaces are restricted to profiled binaries
 *  (kernel.apparmor_restrict_unprivileged_userns=1), and bwrap is one of them.
 *
 *  The binary EXISTING is not the question — being allowed to build a namespace is. Installing the
 *  `bubblewrap` package ships no AppArmor profile of its own, so on a host where nobody wrote one the
 *  file check passed, this gate said yes, and every command then died on `bwrap: setting up uid map:
 *  Permission denied` — a fail-closed guard reporting success and failing later, which is the one thing
 *  a guard must not do. So ask the kernel: run the smallest possible sandbox and see. The answer is a
 *  property of the host, so it is asked once and remembered. */
let sandboxProbe = null;
export function sandboxAvailable() {
  if (sandboxProbe !== null) return sandboxProbe;
  try {
    realpathSync(BWRAP);
    // The smallest namespace a binary can actually RUN in. The merged-usr symlinks are not decoration:
    // without /lib the dynamic linker is unreachable and every exec fails with ENOENT, which would make
    // this probe report "cannot sandbox" on hosts that sandbox perfectly well.
    const probe = spawnSync(BWRAP, [
      '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64',
      '--dev', '/dev',
      '--', '/usr/bin/true',
    ], {
      stdio: 'ignore',
      timeout: 5000,
    });
    sandboxProbe = probe.status === 0;
  } catch {
    sandboxProbe = false;
  }
  return sandboxProbe;
}

/** Test seam: the probe result is cached because it describes the host, and a suite that changes what the
 *  host looks like has to be able to say so. */
export function resetSandboxProbe() {
  sandboxProbe = null;
}

/** Writable HOME for the caller, kept across calls so npm's cache, pip and .gitconfig survive between
 *  commands. The daemon's real HOME (/var/www) is never bound, which also means no ambient SSH keys:
 *  pushing over ssh needs a key placed in this directory.
 *
 *  Keyed by ACCOUNT where there is one. A delegated sub-agent deliberately carries no `elowenUserId`
 *  (identity.ts: a child is attributed to its delegation, not to a person), so it is keyed by its own
 *  session instead. Both must be distinct per caller: a single shared fallback directory would be a
 *  writable channel between unrelated accounts — .gitconfig, npm credentials and scripts flowing from one
 *  account's sub-agent to another's — which is precisely the leak this module exists to prevent.
 *
 *  With neither identity nor session (a cron wake-up, a task worker) there is nothing safe to key on.
 *  Returning null puts HOME on the private tmpfs instead: that caller gets a working, writable home for
 *  the duration of the command and shares it with nobody. Refusing outright would be the other defensible
 *  answer, but it would break legitimate unattended work to prevent a leak that a per-command directory
 *  already prevents. */
function callerHome(dataDir, userId, sessionId) {
  const key = userId != null
    ? `user-${userId}`
    : sessionId
      ? `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`
      : null;
  if (!key) return null;
  const dir = join(dataDir, 'sandbox-home', key);
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

const within = (child, parent) => child === parent || child.startsWith(`${parent}/`);

/** Bind the pieces of /etc a toolchain needs, and resolve the resolver config explicitly.
 *  On a systemd-resolved host /etc/resolv.conf is a SYMLINK into /run, which is not mounted here — the
 *  symlink would dangle and every DNS lookup would fail, taking npm install, git fetch and curl with it.
 *  Binding the link's target at the conventional path fixes name resolution without exposing /run. */
function etcBinds() {
  const args = [];
  try {
    args.push('--ro-bind-try', realpathSync('/etc/resolv.conf'), '/etc/resolv.conf');
  } catch {
    // No resolver configuration on this host; DNS will fail loudly inside, exactly as it would outside.
  }
  for (const entry of ETC_ALLOWLIST) args.push('--ro-bind-try', `/etc/${entry}`, `/etc/${entry}`);
  return args;
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
export function sandboxRun({ command, cwd, roots, dataDir, userId, sessionId }) {
  const binds = bindableRoots(roots);
  if (binds.length === 0) {
    throw new Error('no accessible project directory: ask an administrator to assign you a project before using the shell');
  }
  // The cwd already passed assertPathAllowed, which permits two paths that are NOT project roots: the
  // session's own tool-result spill directory and its plan file. Binding the guarded cwd when it falls
  // outside every root keeps the sandbox consistent with the guard instead of failing with a bare
  // "bwrap: Can't chdir" for a directory the host just declared legitimate.
  const cwdReal = realpathSync(cwd);
  if (!binds.some((root) => within(cwdReal, root))) binds.push(cwdReal);

  const home = callerHome(dataDir, userId, sessionId);

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
    // Ubuntu's merged-/usr layout: these are symlinks on the host and must be recreated inside.
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/sbin', '/sbin',
    // Fresh kernel filesystems, and a private /tmp that dies with the command.
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    ...etcBinds(),
  ];

  // The account's own projects, writable. This is the same set `assertPathAllowed` enforces for the file
  // tools, read at dispatch time from the turn's policy, so the shell and the file tools now agree.
  for (const root of binds) args.push('--bind', root, root);
  if (home) {
    args.push('--bind', home, home);
    args.push('--setenv', 'HOME', home);
  } else {
    // Ephemeral home inside the private tmpfs: writable, shared with nobody, gone with the command.
    args.push('--dir', EPHEMERAL_HOME);
    args.push('--setenv', 'HOME', EPHEMERAL_HOME);
  }
  args.push('--chdir', cwd);
  args.push('--', '/bin/bash', '-c');

  const env = { [CMD_VAR]: command, HOME: home ?? EPHEMERAL_HOME };
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
