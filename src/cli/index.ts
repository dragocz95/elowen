#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ELOWEN_CLI_VERSION } from './version.js';
import { ElowenClient } from './client.js';
import { defaultLifecycleDeps, runLifecycle, runApiCommand } from './commands.js';
import { callElowenApi } from '../shared/apiClient.js';
import { menu } from './menu.js';
import { interactiveLogin, launchChat } from './chat/launch.js';

const BASE = (process.env.ELOWEN_URL) ?? 'http://localhost:4400';

const USAGE = "usage: elowen [command] [options]  —  run `elowen --help` for the full command list";

/** The full, grouped help shown for `elowen --help`. Kept as a function so the version is interpolated. */
function helpText(version: string): string {
  return `elowen ${version} - control plane for autonomous coding agents

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

SERVICE
  menu                            interactive launcher: start/stop/status/update in one place
  up                              start the daemon (:4400) and web UI (:4500) in the background
  down                            stop the daemon and web UI
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

TASKS
  ls                              list all tasks (JSON)
  ready                           list tasks ready to run (JSON)
  sessions                        list live agent sessions (JSON)
  send <session> "<text>"         type a message into a live agent's tmux and submit it
                                    --no-enter                send the text without pressing Enter
  close <id> [options]            close a task
                                    --summary "<text>"        closing note
                                    --outcome ok|fail         record the outcome

AGENT-FACING                      (invoked by running agents — rarely needed by hand)
  help                            print this task's Elowen control guide (needs ELOWEN_TASK)
  ask "<text>"                    ask the autopilot a free-text question and wait for the reply
                                    (needs ELOWEN_TASK; the answer is printed to stdout)
                                    --history                 print this task's chat history instead
  note add <missionId> "<text>"   leave a handoff note for later phases of this mission
  note ls  <missionId>            read this mission's handoff notes (oldest-first)
  api <METHOD> <path> [body]      generic authenticated REST call (needs ELOWEN_URL/ELOWEN_TOKEN)
  plan submit --phases '<json>'   submit an autopilot plan        (needs ELOWEN_PLAN_JOB)
  overseer poll                   wait for the next decision       (needs ELOWEN_MISSION)
  overseer decide --id <id> …     resolve a decision: --approve | --escalate | --choice <optionId> | --message "<reply>" | --restart
                                    [--confidence <0..1>] [--rationale "<text>"]

OPTIONS
  -h, --help                      show this help
  -v, --version                   print the version

Docs & issues: https://github.com/dragocz95/elowen`;
}

/** Commands that talk to the daemon API — only these justify auto-starting it. Everything else
 *  (help, unknown verbs) must NOT spawn a daemon: a stray detached daemon squats the port and starves
 *  the systemd-managed one into a restart loop. */
const API_COMMANDS = new Set(['ls', 'ready', 'sessions', 'send', 'close', 'note', 'plan', 'overseer', 'api', 'ask', 'chat', 'login']);

/** True only for verbs that need the daemon API up — the gate for ensureDaemon's auto-spawn. */
export function needsDaemon(cmd: string | undefined): boolean {
  return cmd !== undefined && API_COMMANDS.has(cmd);
}

async function ensureDaemon() {
  if ((process.env.ELOWEN_AUTOSTART) === '0') return;
  try { await fetch(`${BASE}/health`); return; } catch { /* down — start daemon */ }
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
  spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); return; } catch { /* not healthy yet — retry */ await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('elowen daemon did not become healthy');
}

/** Read `--flag value` from an argv slice. Returns undefined when the flag is absent OR present without
 *  a value — a following token that is itself a flag (`--…`) is never swallowed as this flag's value
 *  (`--summary --outcome ok` must not set summary to "--outcome"). Pair with `has()` to tell "absent"
 *  apart from "present but valueless" when a value is required. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? undefined : next;
}
function has(args: string[], name: string): boolean { return args.includes(name); }

export async function run(argv: string[], c: ElowenClient, env: NodeJS.ProcessEnv): Promise<void> {
  const [cmd, arg, ...rest] = argv;
  switch (cmd) {
    case 'ls': console.log(JSON.stringify(await c.tasks(), null, 2)); break;
    case 'ready': console.log(JSON.stringify(await c.ready(), null, 2)); break;
    case 'sessions': console.log(JSON.stringify(await c.sessions(), null, 2)); break;
    case 'chat': {
      // Interactive Elowen chat: a thin pi-tui client over the server-side brain. The shared launcher
      // resolves a token (env → cache → interactive login) and opens the TUI — same path as the menu.
      const chatArgs = argv.slice(1);
      const session = flag(chatArgs, '--session');
      // Launching the CLI opens a BLANK conversation. Silently resuming whatever was last said in this
      // directory made every launch a guess about intent, and the old thread is never lost — `-c` resumes
      // it explicitly, and /resume + the /sessions picker reach any of them. An explicit --session (or
      // --new) still means exactly what it says.
      const resume = chatArgs.includes('--continue') || chatArgs.includes('-c');
      await launchChat(BASE, env, {
        model: flag(chatArgs, '--model'),
        session,
        fresh: chatArgs.includes('--new') || (!session && !resume),
      });
      break;
    }
    case 'login': {
      await interactiveLogin(BASE, env);
      console.log('Signed in — token saved.');
      break;
    }
    case 'send': {
      // Type a message straight into a running agent's tmux — the manual unblock for when an agent
      // asks a free-text question (which the deriver can't detect) and otherwise hangs forever.
      const session = arg;
      const noEnter = has(rest, '--no-enter');
      const text = rest.filter((a) => a !== '--no-enter')[0];
      if (!session || text === undefined || text === '') { console.error('usage: elowen send <session> "<text>" [--no-enter]'); process.exit(1); }
      // Default appends a newline so the agent actually receives the message (Enter submits);
      // --no-enter types it without submitting (stage text, or send a lone control char).
      await c.sendInput(session, noEnter ? text : `${text}\n`);
      console.log(`sent to ${session}`); break;
    }
    case 'api': {
      const code = await runApiCommand(argv.slice(1), env, { call: callElowenApi, out: (s) => console.log(s), err: (s) => console.error(s) });
      process.exit(code);
      break;
    }
    case 'close': {
      if (!arg) { console.error('usage: elowen close <taskId> [--summary "<text>"] [--outcome ok|fail]'); process.exit(1); }
      const outcome = flag(rest, '--outcome');
      // A flag given with no value (`--outcome` at the end, or followed by another flag) is a mistake,
      // not "no outcome" — error instead of silently closing with none, which would let the agent think
      // it recorded ok/fail when it didn't. Same for an empty --summary.
      if (has(rest, '--outcome') && outcome === undefined) { console.error('elowen close: --outcome requires a value (ok or fail)'); process.exit(2); }
      if (has(rest, '--summary') && flag(rest, '--summary') === undefined) { console.error('elowen close: --summary requires a value'); process.exit(2); }
      // Reject a typo'd outcome instead of silently storing null — the agent would otherwise think it
      // closed "ok"/"fail" while the task records no outcome at all.
      if (outcome !== undefined && outcome !== 'ok' && outcome !== 'fail') { console.error('elowen close: --outcome must be ok or fail'); process.exit(2); }
      await c.close(arg, { summary: flag(rest, '--summary'), outcome });
      console.log(`closed ${arg}`); break;
    }
    case 'ask': {
      // A worker asks the autopilot a free-text question and blocks until it gets an answer. The task
      // is taken from ELOWEN_TASK (set at spawn), so the agent needs only the question text.
      const taskId = (env.ELOWEN_TASK);
      if (!taskId) { console.error('elowen ask: ELOWEN_TASK is not set'); process.exit(1); }
      // `elowen ask --history` prints this task's chat history so the agent (or a human in the terminal)
      // can review the whole conversation, e.g. after resuming.
      if (arg === '--history') {
        const rows = await c.askHistory(taskId) as { detail: string }[];
        for (const r of rows) { try { const m = JSON.parse(r.detail) as { role: string; text: string }; console.log(`${m.role}: ${m.text}`); } catch { /* skip malformed row */ } }
        break;
      }
      if (!arg) { console.error('usage: elowen ask "<question>"  |  elowen ask --history'); process.exit(1); }
      const { askId } = await c.askStart(taskId, arg) as { askId: string };
      // Long-poll until the autopilot/human answers (or the sentinel fires). The server returns `{}`
      // every ~25s as a heartbeat (keeps the HTTP request alive); just re-poll. Print the reply so the
      // agent reads it from stdout, then continue its work. Tolerate a transient blip (proxy/network)
      // with a short backoff so a multi-minute wait isn't killed by one failed request; a 404 means the
      // exchange is gone (e.g. the daemon restarted) — proceed on our own rather than abort the task.
      for (;;) {
        let r: { text?: string };
        try {
          r = await c.askPoll(taskId, askId) as { text?: string };
        } catch (e) {
          if (String(e).includes('404')) { console.log('No answer is available (the request was lost). Proceed using your own best judgement: make the safest reasonable, reversible assumption and continue.'); break; }
          await new Promise((res) => setTimeout(res, 2000)); // transient — back off and re-poll
          continue;
        }
        if (typeof r.text === 'string') { console.log(r.text); break; }
      }
      break;
    }
    case 'help': {
      // `elowen help` with ELOWEN_TASK set is the agent-facing path: print this task's context-aware control
      // guide (how to work / ask / close), rendered by the daemon. The human `elowen help` (no ELOWEN_TASK)
      // never reaches here — main() prints the CLI usage and returns before dispatch.
      const taskId = (env.ELOWEN_TASK);
      if (!taskId) { console.error(USAGE); process.exit(1); }
      const { text } = await c.guide(taskId) as { text?: string };
      if (typeof text === 'string') console.log(text);
      break;
    }
    case 'note': {
      // Handoff notes between agents working the same mission. `<missionId>` is the epic id (or `m-<epicId>`);
      // the daemon normalizes the prefix. add → leave a note; ls → read the mission's notes (oldest-first).
      if (arg === 'add') {
        const target = rest[0]; const text = rest[1];
        if (!target || !text) { console.error('usage: elowen note add <missionId> "<text>"'); process.exit(1); }
        await c.noteAdd(target, text);
        console.log(`noted on ${target}`); break;
      }
      if (arg === 'ls') {
        if (!rest[0]) { console.error('usage: elowen note ls <missionId>'); process.exit(1); }
        console.log(JSON.stringify(await c.notes(rest[0]), null, 2)); break;
      }
      console.error('usage: elowen note <add <missionId> "<text>"|ls <missionId>>'); process.exit(1); break;
    }
    case 'plan': {
      if (arg !== 'submit') { console.error("usage: elowen plan submit --phases '<json>'"); process.exit(1); }
      const jobId = (env.ELOWEN_PLAN_JOB);
      if (!jobId) { console.error('elowen plan submit: ELOWEN_PLAN_JOB is not set'); process.exit(1); }
      const raw = flag(rest, '--phases') ?? '[]';
      let phases: unknown;
      try { phases = JSON.parse(raw); } catch { console.error('elowen plan submit: --phases is not valid JSON'); process.exit(1); }
      await c.planSubmit(jobId, phases);
      console.log(`submitted plan to ${jobId}`); break;
    }
    case 'overseer': {
      const missionId = (env.ELOWEN_MISSION);
      if (!missionId) { console.error('elowen overseer: ELOWEN_MISSION is not set'); process.exit(1); }
      if (arg === 'poll') {
        // Absorb heartbeats HERE, in the CLI process, so the (LLM-driven) overseer agent is woken
        // only for a real decision. The server long-poll returns `{}` every ~25s to keep the HTTP
        // request from hanging; surfacing those heartbeats to the model would force a fresh round-trip
        // (and token spend) every 25s for an otherwise-idle overseer. Loop until a decision (`id`) or
        // an error arrives; when the mission ends the daemon kills this session, ending the loop.
        for (;;) {
          const r = await c.overseerPoll(missionId) as Record<string, unknown> | null;
          if (r && (r.id || r.error)) { console.log(JSON.stringify(r, null, 2)); break; }
          // heartbeat (`{}`) — the server already blocked ~25s, so just poll again.
        }
        break;
      }
      if (arg === 'decide') {
        const id = flag(rest, '--id');
        if (!id) { console.error('usage: elowen overseer decide --id <id> (--approve|--escalate|--choice <optionId>|--message "<reply>"|--restart) [--confidence <0..1>] [--rationale "<text>"]'); process.exit(1); }
        // A 'question' decision picks an option (--choice <id>); a 'message' decision answers with free
        // text (--message); a permission/review decision approves or escalates (--approve|--escalate).
        // Either way confidence rides along for the autonomy gate; --escalate is the absence of all.
        const choice = flag(rest, '--choice');
        const message = flag(rest, '--message');
        const approve = has(rest, '--approve');
        // A 'check' decision (idle worker) may instead --restart it; rides along like the other verbs.
        const restart = has(rest, '--restart');
        const confidence = (approve || choice !== undefined || message !== undefined) ? Number(flag(rest, '--confidence') ?? '0.7') : 0;
        await c.overseerDecide(missionId, { id, approve, confidence: Number.isFinite(confidence) ? confidence : 0, rationale: flag(rest, '--rationale') ?? '', ...(choice !== undefined ? { choice } : {}), ...(message !== undefined ? { message } : {}), ...(restart ? { restart: true } : {}) });
        console.log(`decided ${id}`); break;
      }
      console.error('usage: elowen overseer <poll|decide ...>'); process.exit(1); break;
    }
    default: console.error(USAGE); process.exit(1);
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
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    // A running agent invokes `elowen help` with ELOWEN_TASK set to get its task control guide (not the CLI
    // usage). That path DOES need the daemon, so start it and dispatch through `run`. The `-h`/`--help`
    // flags and a human's bare `elowen help` (no ELOWEN_TASK) still just print usage.
    if (argv[0] === 'help' && (process.env.ELOWEN_TASK)) {
      await ensureDaemon();
      await run(['help'], new ElowenClient(BASE, (process.env.ELOWEN_TOKEN)), process.env);
      return;
    }
    console.log(helpText(version)); return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') { console.log(version); return; }
  // `elowen install` is the root provisioning wizard — it sets up systemd, the proxy and the admin
  // itself, so it must run BEFORE ensureDaemon (no auto-spawn) and before the lifecycle commands.
  if (argv[0] === 'install') { const { install } = await import('./install/index.js'); await install(argv.slice(1)); return; }
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
  // `elowen update --auto` is the hourly systemd timer's entrypoint: gated on the opt-in flag + live
  // missions (read straight from the DB), it never auto-spawns a daemon and stays silent-success when
  // it decides not to update — so handle it before both runLifecycle and ensureDaemon.
  if (argv[0] === 'update' && argv.includes('--auto')) {
    const { autoUpdate } = await import('./autoUpdate.js');
    const out = await autoUpdate(process.env, { current: version });
    console.log(out.ran
      ? (out.result.updated
          ? (out.result.restartDeferred
              ? `Installed ${out.result.to} — restart deferred (a mission went live); it takes over on the next restart`
              : `Auto-updated ${out.result.from} → ${out.result.to}`)
          : `Already up to date (${out.result.to})`)
      : out.reason === 'busy' ? 'Auto-update deferred — a mission is running' : 'Auto-update is off');
    return;
  }
  // Install-lifecycle commands manage the daemon/web themselves — handle them BEFORE ensureDaemon so
  // they don't trigger the API-CLI's auto-spawn.
  if (await runLifecycle(argv[0], process.env, defaultLifecycleDeps(version))) return;
  // Only API commands may auto-start the daemon; an unknown verb errors out without spawning anything.
  if (!needsDaemon(argv[0])) { console.error(USAGE); process.exit(1); }
  await ensureDaemon();
  const c = new ElowenClient(BASE, (process.env.ELOWEN_TOKEN));
  await run(argv, c, process.env);
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
