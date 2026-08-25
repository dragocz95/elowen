#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ELOWEN_CLI_VERSION } from './version.js';
import { defaultLifecycleDeps, runLifecycle, runApiCommand } from './commands.js';
import { callElowenApi } from '../shared/apiClient.js';
import { menu } from './menu.js';
import { interactiveLogin, launchChat } from './chat/launch.js';
import { resolveToken } from './chat/token.js';
import { urlHealthy, waitHealthy, type ReadinessOpts } from './launcher.js';
import { runCmd, SERVICES } from './systemd.js';
import { flagValue as flag } from './flags.js';

const BASE = (process.env.ELOWEN_URL) ?? 'http://localhost:4400';

const USAGE = "usage: elowen [command] [options]  —  run `elowen --help` for the full command list";

/** The full, grouped help shown for `elowen --help`. Kept as a function so the version is interpolated. */
function helpText(version: string): string {
  return `elowen ${version} - personal AI workspace

USAGE
  elowen                            open the interactive Elowen chat (in a terminal)
  elowen <command> [options]

SETUP                             (setup = this machine, local · install = a shared server, as root)
  setup                           set up Elowen on THIS machine: the onboarding wizard
                                  (account, project, AI provider, memory, LSP)
                                    --reset                   start over from scratch
                                    --non-interactive         flag-driven setup (no prompts; for agents/CI)
                                      --admin-user --admin-password --project[-slug]|--no-project
                                      --provider <key|custom> --api-key --base-url --model
                                      --memory <reuse|openrouter|skip> --memory-key --embedding-model --skip-test
                                      --lsp                     install the TypeScript language server
                                      secrets can come from env instead of argv (avoids ps/history leaks):
                                      ELOWEN_ADMIN_PASSWORD, ELOWEN_API_KEY, ELOWEN_OPENROUTER_KEY
  doctor                          readiness check: what works, and how to fix what doesn't
  install                         provision Elowen as a shared server: systemd units, a reverse proxy
                                  and the first admin (run as root). See \`elowen install --help\`.
  uninstall                       remove what install created: services, sudoers, vhost, service
                                  user and the install record — keeps data unless --purge

SERVICE
  menu                            interactive launcher: start/stop/status/update in one place
  up                              start the daemon (:4400) and web UI (:4500) in the background
  down [--force]                  stop the daemon and web UI (waits for running turns; --force kills now)
  status                          show which services are running and healthy
  update                          update to the latest npm release and restart in place

CHAT
  chat                            open the interactive Elowen chat (talk to Elowen's brain in the terminal)
                                    starts a NEW conversation; earlier ones stay available via /resume
                                    --model openai|anthropic  pick the configured provider
                                    -c, --continue                resume this directory's last conversation
                                    --session <id>                resume a specific conversation
  run "<prompt>"                  non-interactive Elowen: run one turn/slash/goal, stream it, exit
  -p, --print "<prompt>"          alias for \`run\` (claude-style)
                                    --model/--provider <id>   pick the model for this run
                                    -c | --resume <id> | --new    continue active (default) / specific / fresh
                                    --list                        list conversations (ids for --resume)
                                    --mode plan|build|workflow    plan hides mutating tools · workflow orchestrates a DAG
                                    --goal "<text>" [--max-turns N]  run an autonomous goal until it settles
                                    --json | --verbose | --timeout <s>
                                    a /slash prompt runs that command, e.g. -p "/status", -p "/goal pause"
  login                           sign in and cache a token for \`elowen chat\` (no password prompt next time)

OPTIONS
  -h, --help                      show this help
  -v, --version                   print the version

Docs & issues: https://github.com/dragocz95/elowen`;
}

/** Commands that talk to the daemon API — only these justify auto-starting it. Everything else
 *  (help, unknown verbs) must NOT spawn a daemon: a stray detached daemon squats the port and starves
 *  the systemd-managed one into a restart loop. */
const API_COMMANDS = new Set(['api', 'chat', 'login']);

/** True only for verbs that need the daemon API up — the gate for ensureDaemon's auto-spawn. */
export function needsDaemon(cmd: string | undefined): boolean {
  return cmd !== undefined && API_COMMANDS.has(cmd);
}

/** The env a dispatched command runs with. Chat and login resolve or create their own credential; the
 * generic API command receives the cached token when no explicit ELOWEN_TOKEN is present. */
export function cliEnvFor(
  cmd: string | undefined, env: NodeJS.ProcessEnv, resolve: (e: NodeJS.ProcessEnv) => string = resolveToken,
): NodeJS.ProcessEnv {
  if (cmd === 'chat' || cmd === 'login') return env;
  return { ...env, ELOWEN_TOKEN: resolve(env) };
}

/** Injectable seams for `ensureDaemon`, so its spawn decision is unit-testable without a real daemon
 *  (or a real systemctl). Everything defaults to the real implementations. */
export interface EnsureDaemonDeps {
  urlHealthy: (url: string) => Promise<boolean>;
  waitHealthy: (urls: string[], opts: ReadinessOpts) => Promise<boolean[]>;
  spawn: typeof spawn;
  /** Whether the elowen units exist as systemd unit files — the signal that a managed instance owns the
   *  ports, so a detached spawn would race it rather than replace it. */
  systemdKnown: () => Promise<boolean>;
}

/** Whether any elowen service has a unit file, i.e. the box is systemd-managed. `list-unit-files` is
 *  read-only and answers for any user, so no sudo is involved; any failure (no systemd at PID 1 —
 *  containers, macOS — or unreadable state) reads as "not managed", the safe direction: the managed check
 *  only ever SUPPRESSES the detached spawn when a managed instance can be confirmed. `run` is injectable
 *  for tests, matching launchdStatusText's pattern. */
export async function systemdKnown(run: typeof runCmd = runCmd): Promise<boolean> {
  // The patterns MUST carry the `.service` suffix: `list-unit-files elowen-daemon` matches nothing and
  // exits 0 with "0 unit files listed", so without it this returns false on the very boxes it exists to
  // detect — the managed check would never fire and the detached spawn it guards would always happen.
  const r = await run('systemctl', ['list-unit-files', ...SERVICES.map((s) => `${s}.service`)]);
  if (r.code !== 0) return false;
  const listed = new Set(r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  return SERVICES.some((s) => listed.has(`${s}.service`));
}

export async function ensureDaemon(deps: Partial<EnsureDaemonDeps> = {}) {
  if ((process.env.ELOWEN_AUTOSTART) === '0') return;
  const urlHealthyFn = deps.urlHealthy ?? urlHealthy;
  const waitHealthyFn = deps.waitHealthy ?? waitHealthy;
  const spawnFn = deps.spawn ?? spawn;
  const managed = deps.systemdKnown ?? systemdKnown;
  // `urlHealthy` requires an `ok` response — a bare non-throwing fetch previously read a 500 as healthy —
  // and bounds each probe so a half-open connection can't block an ordinary command.
  if (await urlHealthyFn(`${BASE}/health`)) return;
  // One failed probe is NOT evidence that nothing is running: a systemd-managed instance mid-start (or
  // mid-restart) fails it transiently, and spawning on that evidence starts a SECOND daemon racing the
  // managed one for the same port. Give the port a short polling window before deciding it is really down.
  const [settled] = await waitHealthyFn([`${BASE}/health`], { budgetMs: 2500, pollMs: 250 });
  if (settled) return;
  // A systemd-provisioned box must never get a stray detached daemon — the unit owns :4400 and the spawn
  // would fight it (and vice versa) on every boot. Surface the start command instead of spawning.
  if (await managed()) {
    const sudo = typeof process.getuid === 'function' && process.getuid() !== 0;
    throw new Error(`elowen daemon is not running and the services are systemd-managed — start it with: ${sudo ? 'sudo ' : ''}systemctl start ${SERVICES.join(' ')}`);
  }
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
  // ELOWEN_SERVICE is pinned here for the same reason the launcher and the unit template pin it: the
  // identity check trusts the legacy ELOWEN_DAEMON_URL marker only when ELOWEN_SERVICE is absent, so a
  // daemon spawned from a shell that exported the former would otherwise read as the WEB — and `down`
  // would signal it. Inheriting the environment is what makes that reachable, so it is pinned even
  // though this spawn is the one path that never had a marker.
  spawnFn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELOWEN_SERVICE: 'daemon' },
  }).unref();
  // 5s TOTAL, not 50 probes that may each stall for their own timeout.
  const [healthy] = await waitHealthyFn([`${BASE}/health`], { budgetMs: 5000 });
  if (!healthy) throw new Error('elowen daemon did not become healthy');
}

export async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [cmd] = argv;
  switch (cmd) {
    case 'chat': {
      const chatArgs = argv.slice(1);
      const session = flag(chatArgs, '--session');
      const resume = chatArgs.includes('--continue') || chatArgs.includes('-c');
      await launchChat(BASE, env, {
        model: flag(chatArgs, '--model'),
        session,
        fresh: chatArgs.includes('--new') || (!session && !resume),
      });
      break;
    }
    case 'login':
      await interactiveLogin(BASE, env);
      console.log('Signed in — token saved.');
      break;
    case 'api': {
      const code = await runApiCommand(argv.slice(1), env, { call: callElowenApi, out: (line) => console.log(line), err: (line) => console.error(line) });
      process.exit(code);
      break;
    }
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

export async function main() {
  const argv = process.argv.slice(2);
  const version = ELOWEN_CLI_VERSION;
  // Bare `elowen` in a terminal opens the chat TUI — the agent is the product, so talking to it is the
  // zero-friction default (like `claude`/`opencode`). The ops launcher moved to `elowen menu`; piped/
  // non-TTY still falls through to the usage text below, so scripts keep deterministic behavior.
  if (argv.length === 0 && process.stdin.isTTY) argv.push('chat');
  // `elowen menu` — the interactive launcher (start/stop/status/update). It manages the daemon itself,
  // so it runs BEFORE ensureDaemon like install/setup.
  if (argv[0] === 'menu') { await menu(process.env, version); return; }
  // Help / bare non-TTY invocation: print usage and stop. Must NOT fall through to ensureDaemon.
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { console.log(helpText(version)); return; }
  if (argv[0] === '--version' || argv[0] === '-v') { console.log(version); return; }
  // `elowen install` is the root provisioning wizard — it sets up systemd, the proxy and the admin
  // itself, so it must run BEFORE ensureDaemon (no auto-spawn) and before the lifecycle commands.
  if (argv[0] === 'install') { const { install } = await import('./install/index.js'); await install(argv.slice(1)); return; }
  // `elowen uninstall` tears down what install created — it stops the services itself, so like install it
  // must run BEFORE ensureDaemon (a stopped-then-reuninstalled daemon must not be auto-spawned) and before
  // the lifecycle commands.
  if (argv[0] === 'uninstall') { const { runUninstall } = await import('./uninstall.js'); process.exit(await runUninstall(argv.slice(1))); }
  // `elowen setup` runs the onboarding wizard on demand. Like install it manages the daemon itself, so it
  // runs BEFORE ensureDaemon/runLifecycle and is NOT an API command. In a non-TTY it prints a next step
  // and exits 0 (never blocks CI). Dynamic import keeps the cold-path wizard out of the hot dispatch.
  if (argv[0] === 'setup') { const { runSetup } = await import('./setup/command.js'); await runSetup(argv.slice(1), process.env, BASE, version); return; }
  // `elowen doctor` is a read-only diagnostic — it authenticates and queries the daemon itself (never
  // spawning it), so like `setup` it runs BEFORE ensureDaemon/runLifecycle and is NOT an API command.
  if (argv[0] === 'doctor') { const { runDoctor } = await import('./doctor.js'); await runDoctor(argv.slice(1), process.env, BASE, version); return; }
  // `elowen run "<prompt>"` / `elowen -p "<prompt>"` — non-interactive Elowen (a single turn, slash command or
  // autonomous goal, streamed to stdout, then exit). Needs the daemon like `chat`, so bring it up first;
  // then hand off to the headless runner, which resolves a token from env/cache (never prompting).
  if (argv[0] === 'run' || argv[0] === '-p' || argv[0] === '--print' || argv[0] === '--prompt') {
    // A streamed run is often piped (`elowen run … | head`); when the consumer closes the pipe, writing to
    // std{out,err} raises EPIPE — treat that as "consumer done" and exit cleanly instead of crashing on it.
    const onEpipe = (e: NodeJS.ErrnoException): void => { if (e.code === 'EPIPE') process.exit(0); };
    process.stdout.on('error', onEpipe);
    process.stderr.on('error', onEpipe);
    await ensureDaemon();
    const { runHeadless } = await import('./chat/headless.js');
    const code = await runHeadless(BASE, process.env, argv[0] === 'run' ? argv.slice(1) : argv);
    // Flush stdout before exiting — process.exit() does NOT drain a piped socket, so the last frames of a
    // large `--json` stream could be lost to a slow consumer otherwise.
    if (!process.stdout.write('')) await new Promise<void>((r) => process.stdout.once('drain', () => r()));
    process.exit(code);
  }
  // `elowen update --auto` is the hourly systemd timer's entrypoint: gated on the opt-in flag, it never
  // auto-spawns a daemon and stays silent-success when
  // it decides not to update — so handle it before both runLifecycle and ensureDaemon.
  if (argv[0] === 'update' && argv.includes('--auto')) {
    const { autoUpdate } = await import('./autoUpdate.js');
    const out = await autoUpdate(process.env, { current: version });
    console.log(out.ran
      ? (out.result.updated ? `Auto-updated ${out.result.from} → ${out.result.to}` : `Already up to date (${out.result.to})`)
      : 'Auto-update is off');
    return;
  }
  // Install-lifecycle commands manage the daemon/web themselves — handle them BEFORE ensureDaemon so
  // they don't trigger the API-CLI's auto-spawn.
  if (await runLifecycle(argv[0], process.env, defaultLifecycleDeps(version), argv.slice(1))) return;
  // Only API commands may auto-start the daemon; an unknown verb errors out without spawning anything.
  if (!needsDaemon(argv[0])) { console.error(USAGE); process.exit(1); }
  await ensureDaemon();
  const env = cliEnvFor(argv[0], process.env);
  await run(argv, env);
}

// Run only when invoked as the binary, not when imported (e.g. by tests). A global npm install exposes
// `elowen` as a SYMLINK in the bin dir, so process.argv[1] is the symlink path while import.meta.url is
// the real module path — a plain string compare never matches and main() would silently never run.
// realpathSync resolves the symlink so the comparison holds for both `node dist/cli/index.js` and the
// installed `elowen` command.
const invoked = process.argv[1];
if (invoked) {
  let entry = invoked;
  try { entry = realpathSync(invoked); } catch { /* argv[1] not a real path — fall back to the raw value */ }
  if (entry === fileURLToPath(import.meta.url)) {
    main().catch(e => { console.error(e.message); process.exit(1); });
  }
}
