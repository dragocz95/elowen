import type { BrainEvent } from '../../brain/events.js';
import { BrainClient } from './brainClient.js';
import type { GoalView } from './brainClient.js';
import { parseCommand } from './app.js';
import { resolveToken } from './token.js';

/** Parsed `orca run` / `orca -p` invocation. A pure result so the parser is unit-testable. */
export interface HeadlessOpts {
  prompt?: string;                 // the turn text, or a `/slash …` command
  goal?: string;                   // --goal <text>: start a persistent goal instead of a single turn
  model?: string; provider?: string;
  session?: string; fresh: boolean; // --session <id> / --new; default resumes the active conversation
  mode: 'build' | 'plan';
  maxTurns?: number;               // --max-turns: the goal's turn budget
  json: boolean; verbose: boolean;
  list: boolean;                   // --list: print the conversations and exit
  timeoutMs: number;
  error?: string;                  // a parse error → usage exit
}

const USAGE = [
  'usage: orca run "<prompt>"   |   orca -p "<prompt>"',
  '  --model <id> --provider <id>   pick the model for this run',
  '  -c | --resume <id> | --new     continue the active conversation (DEFAULT), a specific one, or start fresh',
  '  --mode plan|build | --plan     plan mode hides mutating tools for the turn',
  '  --goal "<text>" [--max-turns N]  run an autonomous persistent goal until it settles',
  '  --json                         emit every event as JSONL (default: plain text)',
  '  --verbose                      print steps/tools/usage to stderr',
  '  --list                         list your conversations (id, title, model) and exit',
  '  --timeout <seconds>            give up after N seconds (default 600)',
  '  a `/slash` prompt runs that command, e.g. -p "/status", -p "/goal pause", -p "/plan <text>"',
].join('\n');

/** Whether the next token can serve as a flag's value — a token that itself looks like a flag means the
 *  value was forgotten (mirrors headless setup's flagValue), so we don't silently eat the next flag.
 *  Text-bearing flags (prompt/goal) legitimately never start with `-`. */
function takeValue(args: string[], i: number): string | undefined {
  const next = args[i + 1];
  return next !== undefined && !next.startsWith('-') ? next : undefined;
}

export function parseHeadlessArgs(args: string[]): HeadlessOpts {
  const o: HeadlessOpts = { fresh: false, mode: 'build', json: false, verbose: false, list: false, timeoutMs: 600_000 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    const val = (): string | undefined => { const v = takeValue(args, i); if (v !== undefined) i++; return v; };
    switch (a) {
      case '-p': case '--print': case '--prompt': o.prompt = val(); break;
      case '--goal': o.goal = val(); break;
      case '--model': o.model = val(); break;
      case '--provider': o.provider = val(); break;
      case '--session': case '--resume': o.session = val(); break; // resume a specific conversation by id
      case '-c': case '--continue': o.fresh = false; break; // resume the active conversation (the default, made explicit / overrides --new)
      case '--new': o.fresh = true; break;
      case '--mode': { const m = val(); if (m === 'plan' || m === 'build') o.mode = m; else o.error = `--mode must be plan or build (got "${m ?? ''}")`; break; }
      case '--plan': o.mode = 'plan'; break;
      case '--max-turns': { const n = Number(val()); if (Number.isInteger(n) && n >= 1) o.maxTurns = n; else o.error = '--max-turns needs a positive integer'; break; }
      case '--json': o.json = true; break;
      case '-v': case '--verbose': o.verbose = true; break;
      case '--list': case '--sessions': o.list = true; break;
      case '--timeout': { const n = Number(val()); if (Number.isFinite(n) && n > 0) o.timeoutMs = n * 1000; else o.error = '--timeout needs a positive number of seconds'; break; }
      default:
        if (a.startsWith('-')) o.error = `unknown flag "${a}"`;
        else if (o.prompt === undefined) o.prompt = a; // a bare positional is the prompt
        break;
    }
  }
  return o;
}

export interface HeadlessIo { stdout: (s: string) => void; stderr: (s: string) => void }
const dim = (s: string): string => `[2m${s}[0m`;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Non-interactive Orca: start (or resume) a conversation, run one turn / slash / goal, stream the result
 *  to stdout, and exit with a code that reflects the outcome. The daemon + token plumbing is the same the
 *  TUI uses, so this exercises the full stack (model select, prompts, slash commands, autonomous goals)
 *  straight from a terminal. Exit codes: 0 ok/done · 1 error · 2 usage · 3 goal paused/budget · 4 goal
 *  blocked · 5 needs input (a turn asked a question) · 124 timeout. */
export async function runHeadless(
  base: string, env: NodeJS.ProcessEnv, args: string[],
  deps: { client?: BrainClient; io?: HeadlessIo } = {},
): Promise<number> {
  const io = deps.io ?? { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  const o = parseHeadlessArgs(args);
  if (o.error) { io.stderr(`${o.error}\n\n${USAGE}\n`); return 2; }
  if (!o.list && !o.prompt && !o.goal) { io.stderr(`${USAGE}\n`); return 2; }

  let client = deps.client;
  if (!client) {
    let token: string;
    try { token = resolveToken(env); }
    catch { io.stderr('No Orca token — set ORCA_TOKEN or run `orca login` first.\n'); return 1; }
    client = new BrainClient({ base, token });
  }
  const c = client;

  // `--list`: just print the conversations (id · title · model · updated) and exit — the ids feed
  // `--session <id>`. Needs no started session.
  if (o.list) {
    try {
      const rows = await c.sessions();
      if (!rows.length) io.stdout('(no conversations yet)\n');
      for (const r of rows) io.stdout(`${r.active ? '* ' : '  '}${r.id}\t${r.title || '(untitled)'}\t${r.model}\t${r.updated_at}\n`);
      return 0;
    } catch (e) { io.stderr(`list failed: ${errMsg(e)}\n`); return 1; }
  }

  // Continuation model (matches the TUI): by default we resume the ACTIVE conversation, so consecutive
  // `orca run` calls keep talking to the same brain — and slash/goal actions target the right one. `--new`
  // starts fresh; `--session <id>` targets a specific conversation. `-c`/`--continue` is the explicit
  // form of the default. The resolved session id is printed so the user knows what they'll continue.
  let sessionId: string;
  try {
    const startOpts = o.session ? { session: o.session } : o.fresh ? { fresh: true } : {};
    ({ sessionId } = await c.start(startOpts));
    if (o.model || o.provider) { const r = await c.setModel({ model: o.model, provider: o.provider }); if (o.verbose) io.stderr(dim(`[model] ${r.model}\n`)); }
  } catch (e) { io.stderr(`start failed: ${errMsg(e)}\n`); return 1; }
  io.stderr(dim(`[session ${sessionId}] — continue with \`orca run -c "<next>"\` (or --new to start fresh)\n`));
  if (o.json) io.stdout(`${JSON.stringify({ type: 'session', id: sessionId })}\n`);

  const slash = o.prompt?.trim().startsWith('/') ? o.prompt.trim() : undefined;
  const parsed = slash ? parseCommand(slash) : null;
  // A goal run comes from --goal or a `/goal <text>` slash (but NOT the action words pause/resume/clear).
  const goalArg = parsed?.cmd === 'goal' ? (parsed.arg ?? '').trim() : '';
  const goalText = o.goal ?? (goalArg && !['pause', 'resume', 'clear', 'status', 'show'].includes(goalArg) ? goalArg : undefined);
  const isGoalRun = !!goalText;

  const ctrl = new AbortController();
  let exit = 0, settled = false, activity = false;
  let resolveDone: () => void = () => {};
  const doneP = new Promise<void>((r) => { resolveDone = r; });
  const finish = (code: number): void => { if (settled) return; settled = true; exit = code; resolveDone(); ctrl.abort(); };
  const emit = (e: BrainEvent): void => io.stdout(`${JSON.stringify(e)}\n`);

  const onEvent = (e: BrainEvent): void => {
    if (o.json) emit(e);
    switch (e.type) {
      case 'text': if (!o.json) io.stdout(e.delta); activity = true; break;
      case 'reasoning': if (o.verbose && !o.json) io.stderr(dim(e.delta)); activity = true; break;
      case 'tool': if (o.verbose && !o.json) io.stderr(dim(`\n[tool] ${e.name}${e.command ? ` $ ${e.command}` : e.detail ? ` ${e.detail}` : ''}\n`)); activity = true; break;
      case 'tool_output': case 'diff': case 'card': case 'image': activity = true; break;
      case 'step': if (o.verbose && !o.json) io.stderr(dim(`[step ${e.step}/${e.maxSteps}]\n`)); activity = true; break;
      case 'notice': if (o.verbose && !o.json) io.stderr(dim(`[${e.kind}] ${e.message}\n`)); break;
      case 'ask':
        if (!o.json) io.stderr(`\n[needs input] ${e.questions.map((q) => q.question).join(' | ')}\n`);
        if (!isGoalRun) finish(5); // a plain turn can't proceed without an answer
        break;
      case 'error': if (!o.json) io.stderr(`\n[error] ${e.message}\n`); finish(1); break;
      case 'idle':
        // A turn settles at idle (agent_end). It is ordered AFTER every text frame on the same stream, so
        // by here all output has been printed. Goals keep looping (many idles) — those settle via pollGoal.
        if (!isGoalRun && activity) { if (!o.json) io.stdout('\n'); finish(0); }
        break;
    }
  };

  const printGoal = (g: GoalView | null): void => {
    if (!g) { io.stdout('no active goal\n'); return; }
    if (o.json) emit({ type: 'idle' } as BrainEvent); // keep JSONL well-formed; the goal itself follows
    io.stdout(`goal ${g.status} · ${g.turns_used}/${g.turn_budget} turns${g.paused_reason ? ` · ${g.paused_reason}` : ''}${g.last_evidence ? ` · ${g.last_evidence}` : ''}\n`);
  };

  async function pollGoal(): Promise<void> {
    while (!settled) {
      const g = await c.goal().catch(() => null);
      if (g && g.status !== 'active' && g.status !== 'draft') {
        const code = g.status === 'done' ? 0 : g.last_verdict === 'blocked' ? 4 : 3;
        if (!o.json) io.stdout(`\n[goal ${g.status}${g.paused_reason ? `: ${g.paused_reason}` : ''}${g.last_evidence ? ` — ${g.last_evidence}` : ''}]\n`);
        else emit({ type: 'idle' } as BrainEvent);
        finish(code);
        return;
      }
      await sleep(1500);
    }
  }

  async function dispatchSlash(p: NonNullable<ReturnType<typeof parseCommand>>): Promise<void> {
    const arg = (p.arg ?? '').trim();
    switch (p.cmd) {
      case 'plan': case 'build':
        if (arg) await c.send(arg, p.cmd === 'plan' ? 'plan' : 'build');
        else { io.stderr(`/${p.cmd} needs a prompt in headless mode, e.g. -p "/${p.cmd} <text>".\n`); finish(2); }
        break;
      case 'goal': { // pause / resume / clear / status (a `/goal <text>` was already routed to a goal run)
        const g = (arg === 'pause' || arg === 'resume' || arg === 'clear') ? await c.goalAction(arg) : await c.goal();
        printGoal(g); finish(0); break;
      }
      case 'subgoal': {
        const rest = arg.split(/\s+/);
        if (rest[0] === 'remove') await c.subgoal('remove', Number(rest[1]));
        else if (rest[0] === 'clear') await c.subgoal('clear');
        else if (arg) await c.subgoal('add', arg);
        printGoal(await c.goal()); finish(0); break;
      }
      case 'compact': { const r = await c.compact(); io.stdout(`${r.message ?? 'compacted'}\n`); finish(0); break; }
      case 'status': { io.stdout(`${JSON.stringify(await c.status(), null, 2)}\n`); finish(0); break; }
      case 'skills': { io.stdout(`${JSON.stringify(await c.skills(), null, 2)}\n`); finish(0); break; }
      case 'model': {
        const parts = arg.split(/\s+/).filter(Boolean);
        const r = await c.setModel(parts.length >= 2 ? { provider: parts[0], model: parts.slice(1).join(' ') } : { model: parts[0] });
        io.stdout(`model: ${r.model}\n`); finish(0); break;
      }
      case 'think': { if (arg) { const r = await c.setThinkingLevel(arg); io.stdout(`thinking: ${r.thinkingLevel}\n`); } finish(0); break; }
      default: { // any other action command → the generic dispatch
        const r = await c.command(p.cmd); if (r?.message) io.stdout(`${r.message}\n`); finish(0); break;
      }
    }
  }

  let dispatched = false;
  const dispatch = async (): Promise<void> => {
    if (dispatched) return; dispatched = true; // onOpen fires again on a stream reconnect — dispatch once
    try {
      if (isGoalRun) { await c.setGoal(goalText, false, o.maxTurns); void pollGoal(); }
      else if (parsed) await dispatchSlash(parsed);
      else {
        await c.send(o.prompt!, o.mode);
        // Belt-and-suspenders: if no idle event arrives shortly after the (blocking) send resolves, settle
        // anyway so the run can't hang on a missing terminal event. idle normally wins this race.
        setTimeout(() => { if (!settled) { if (!o.json) io.stdout('\n'); finish(0); } }, 500);
      }
    } catch (e) { io.stderr(`\n${errMsg(e)}\n`); finish(1); }
  };

  const streamP = c.stream(onEvent, ctrl.signal, 1000, () => void dispatch())
    .catch((e) => { if (!settled) { io.stderr(`stream error: ${errMsg(e)}\n`); finish(1); } });

  const timer = setTimeout(() => { if (!o.json) io.stderr(`\n[timeout after ${Math.round(o.timeoutMs / 1000)}s]\n`); finish(124); }, o.timeoutMs);
  await doneP;
  clearTimeout(timer);
  await streamP;
  return exit;
}
