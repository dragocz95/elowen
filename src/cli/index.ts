#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OrcaClient } from './client.js';
import { defaultLifecycleDeps, runLifecycle, runApiCommand } from './commands.js';
import { callOrcaApi } from '../shared/apiClient.js';
import { menu } from './menu.js';

const BASE = process.env.ORCA_URL ?? 'http://localhost:4400';

const USAGE = "usage: orca [command] [options]  —  run `orca --help` for the full command list";

/** The full, grouped help shown for `orca --help`. Kept as a function so the version is interpolated. */
function helpText(version: string): string {
  return `🐋 orca ${version} — control plane for autonomous coding agents

USAGE
  orca                            open the interactive launcher menu (in a terminal)
  orca <command> [options]

SETUP
  install                         provision orca as a service: systemd units, a reverse proxy
                                  and the first admin (run as root). See \`orca install --help\`.

SERVICE
  up                              start the daemon (:4400) and web UI (:4500) in the background
  down                            stop the daemon and web UI
  status                          show which services are running and healthy
  update                          update to the latest npm release and restart in place

TASKS
  ls                              list all tasks (JSON)
  ready                           list tasks ready to run (JSON)
  sessions                        list live agent sessions (JSON)
  close <id> [options]            close a task
                                    --summary "<text>"        closing note
                                    --outcome ok|fail         record the outcome

AGENT-FACING                      (invoked by running agents — rarely needed by hand)
  note add <missionId> "<text>"   leave a handoff note for later phases of this mission
  note ls  <missionId>            read this mission's handoff notes (oldest-first)
  api <METHOD> <path> [body]      generic authenticated REST call (needs ORCA_URL/ORCA_TOKEN)
  plan submit --phases '<json>'   submit an autopilot plan        (needs ORCA_PLAN_JOB)
  overseer poll                   wait for the next decision       (needs ORCA_MISSION)
  overseer decide --id <id> …     resolve a decision: --approve | --escalate | --choice <optionId>
                                    [--confidence <0..1>] [--rationale "<text>"]

OPTIONS
  -h, --help                      show this help
  -v, --version                   print the version

Docs & issues: https://github.com/dragocz1995/orcasynth`;
}

/** Commands that talk to the daemon API — only these justify auto-starting it. Everything else
 *  (help, unknown verbs) must NOT spawn a daemon: a stray detached daemon squats the port and starves
 *  the systemd-managed one into a restart loop. */
const API_COMMANDS = new Set(['ls', 'ready', 'sessions', 'close', 'note', 'plan', 'overseer', 'api']);

/** True only for verbs that need the daemon API up — the gate for ensureDaemon's auto-spawn. */
export function needsDaemon(cmd: string | undefined): boolean {
  return cmd !== undefined && API_COMMANDS.has(cmd);
}

/** This package's version, read from its package.json (two dirs up from dist/cli/index.js). */
function pkgVersion(): string {
  try { return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
}

async function ensureDaemon() {
  if (process.env.ORCA_AUTOSTART === '0') return;
  try { await fetch(`${BASE}/health`); return; } catch { /* down — start daemon */ }
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
  spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); return; } catch { /* not healthy yet — retry */ await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('orca daemon did not become healthy');
}

/** Read `--flag value` from an argv slice; returns undefined when the flag is absent. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean { return args.includes(name); }

export async function run(argv: string[], c: OrcaClient, env: NodeJS.ProcessEnv): Promise<void> {
  const [cmd, arg, ...rest] = argv;
  switch (cmd) {
    case 'ls': console.log(JSON.stringify(await c.tasks(), null, 2)); break;
    case 'ready': console.log(JSON.stringify(await c.ready(), null, 2)); break;
    case 'sessions': console.log(JSON.stringify(await c.sessions(), null, 2)); break;
    case 'api': {
      const code = await runApiCommand(argv.slice(1), env, { call: callOrcaApi, out: (s) => console.log(s), err: (s) => console.error(s) });
      process.exit(code);
      break;
    }
    case 'close': {
      if (!arg) { console.error('usage: orca close <taskId> [--summary "<text>"] [--outcome ok|fail]'); process.exit(1); }
      const outcome = flag(rest, '--outcome');
      // Reject a typo'd outcome instead of silently storing null — the agent would otherwise think it
      // closed "ok"/"fail" while the task records no outcome at all.
      if (outcome !== undefined && outcome !== 'ok' && outcome !== 'fail') { console.error('orca close: --outcome must be ok or fail'); process.exit(2); }
      await c.close(arg, { summary: flag(rest, '--summary'), outcome });
      console.log(`closed ${arg}`); break;
    }
    case 'note': {
      // Handoff notes between agents working the same mission. `<missionId>` is the epic id (or `m-<epicId>`);
      // the daemon normalizes the prefix. add → leave a note; ls → read the mission's notes (oldest-first).
      if (arg === 'add') {
        const target = rest[0]; const text = rest[1];
        if (!target || !text) { console.error('usage: orca note add <missionId> "<text>"'); process.exit(1); }
        await c.noteAdd(target, text);
        console.log(`noted on ${target}`); break;
      }
      if (arg === 'ls') {
        if (!rest[0]) { console.error('usage: orca note ls <missionId>'); process.exit(1); }
        console.log(JSON.stringify(await c.notes(rest[0]), null, 2)); break;
      }
      console.error('usage: orca note <add <missionId> "<text>"|ls <missionId>>'); process.exit(1); break;
    }
    case 'plan': {
      if (arg !== 'submit') { console.error("usage: orca plan submit --phases '<json>'"); process.exit(1); }
      const jobId = env.ORCA_PLAN_JOB;
      if (!jobId) { console.error('orca plan submit: ORCA_PLAN_JOB is not set'); process.exit(1); }
      const raw = flag(rest, '--phases') ?? '[]';
      let phases: unknown;
      try { phases = JSON.parse(raw); } catch { console.error('orca plan submit: --phases is not valid JSON'); process.exit(1); }
      await c.planSubmit(jobId, phases);
      console.log(`submitted plan to ${jobId}`); break;
    }
    case 'overseer': {
      const missionId = env.ORCA_MISSION;
      if (!missionId) { console.error('orca overseer: ORCA_MISSION is not set'); process.exit(1); }
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
        if (!id) { console.error('usage: orca overseer decide --id <id> (--approve|--escalate|--choice <optionId>) [--confidence <0..1>] [--rationale "<text>"]'); process.exit(1); }
        // A 'question' decision picks an option (--choice <id>); a permission/review decision approves
        // or escalates (--approve|--escalate). Either way confidence rides along for the autonomy gate.
        const choice = flag(rest, '--choice');
        const approve = has(rest, '--approve');
        const confidence = (approve || choice !== undefined) ? Number(flag(rest, '--confidence') ?? '0.7') : 0;
        await c.overseerDecide(missionId, { id, approve, confidence: Number.isFinite(confidence) ? confidence : 0, rationale: flag(rest, '--rationale') ?? '', ...(choice !== undefined ? { choice } : {}) });
        console.log(`decided ${id}`); break;
      }
      console.error('usage: orca overseer <poll|decide ...>'); process.exit(1); break;
    }
    default: console.error(USAGE); process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const version = pkgVersion();
  // Bare `orca` in a terminal opens the interactive launcher menu. Piped/non-TTY falls through to the
  // usage error from `run`, so scripts still get deterministic behavior.
  if (argv.length === 0 && process.stdin.isTTY) { await menu(process.env, version); return; }
  // Help / bare non-TTY invocation: print usage and stop. Must NOT fall through to ensureDaemon.
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { console.log(helpText(version)); return; }
  if (argv[0] === '--version' || argv[0] === '-v') { console.log(version); return; }
  // `orca install` is the root provisioning wizard — it sets up systemd, the proxy and the admin
  // itself, so it must run BEFORE ensureDaemon (no auto-spawn) and before the lifecycle commands.
  if (argv[0] === 'install') { const { install } = await import('./install/index.js'); await install(argv.slice(1)); return; }
  // `orca update --auto` is the hourly systemd timer's entrypoint: gated on the opt-in flag + live
  // missions (read straight from the DB), it never auto-spawns a daemon and stays silent-success when
  // it decides not to update — so handle it before both runLifecycle and ensureDaemon.
  if (argv[0] === 'update' && argv.includes('--auto')) {
    const { autoUpdate } = await import('./autoUpdate.js');
    const out = await autoUpdate(process.env, { current: version });
    console.log(out.ran
      ? (out.result.updated ? `Auto-updated ${out.result.from} → ${out.result.to}` : `Already up to date (${out.result.to})`)
      : out.reason === 'busy' ? 'Auto-update deferred — a mission is running' : 'Auto-update is off');
    return;
  }
  // Install-lifecycle commands manage the daemon/web themselves — handle them BEFORE ensureDaemon so
  // they don't trigger the API-CLI's auto-spawn.
  if (await runLifecycle(argv[0], process.env, defaultLifecycleDeps(version))) return;
  // Only API commands may auto-start the daemon; an unknown verb errors out without spawning anything.
  if (!needsDaemon(argv[0])) { console.error(USAGE); process.exit(1); }
  await ensureDaemon();
  const c = new OrcaClient(BASE, process.env.ORCA_TOKEN);
  await run(argv, c, process.env);
}

// Run only when invoked as the binary, not when imported (e.g. by tests). A global npm install exposes
// `orca` as a SYMLINK in the bin dir, so process.argv[1] is the symlink path while import.meta.url is
// the real module path — a plain string compare never matches and main() would silently never run.
// realpathSync resolves the symlink so the comparison holds for both `node dist/cli/index.js` and the
// installed `orca` command.
const invoked = process.argv[1];
if (invoked) {
  let entry = invoked;
  try { entry = realpathSync(invoked); } catch { /* argv[1] not a real path — fall back to the raw value */ }
  if (entry === fileURLToPath(import.meta.url)) {
    main().catch(e => { console.error(e.message); process.exit(1); });
  }
}
