import type { BrainEvent } from '../../brain/events.js';
import { BrainClient } from './brainClient.js';
import type { GoalView } from './brainClient.js';
import { parseCommand } from './commands.js';
import { expandPromptCommand } from '../../brain/slashCommands.js';
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
    // A required value that's missing (end of args, or the next token is another flag) is a mistake, not a
    // silent no-op — otherwise `--goal --json "x"` would quietly run a plain turn instead of a goal.
    const need = (name: string): string | undefined => { const v = val(); if (v === undefined) o.error = `${name} needs a value`; return v; };
    switch (a) {
      case '-p': case '--print': case '--prompt': o.prompt = need(a); break;
      case '--goal': o.goal = need(a); break;
      case '--model': o.model = need(a); break;
      case '--provider': o.provider = need(a); break;
      case '--session': case '--resume': o.session = need(a); break; // resume a specific conversation by id
      case '-c': case '--continue': o.fresh = false; break; // resume the active conversation (the default; last of -c/--new wins)
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

  // Continuation model (matches the TUI): by default the server resolves this DIRECTORY's conversation
  // (most recent unattached cwd match, else the most recent unattached cwd-less one, else fresh), so
  // consecutive `orca run` calls from one project keep talking to the same brain — and every follow-up
  // call is BOUND to the resolved session id, so a concurrently open TUI/dock can't hijack it. `--new`
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
        // A plain turn can't proceed without an answer — abort it server-side (releases the session lock /
        // cancels the parked elicitation) instead of leaving it hanging until the elicitation timeout.
        if (!isGoalRun) { void c.abort().catch(() => { /* best-effort */ }); finish(5); }
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
    if (o.json) { io.stdout(`${JSON.stringify(g)}\n`); return; }
    if (!g) { io.stdout('no active goal\n'); return; }
    let subs = '';
    try { const s = JSON.parse(g.subgoals) as { done?: boolean }[]; if (Array.isArray(s) && s.length) subs = ` · subgoals ${s.filter((x) => x?.done).length}/${s.length}`; }
    catch { /* malformed subgoals JSON → omit the count */ }
    io.stdout(`goal ${g.status} · ${g.turns_used}/${g.turn_budget} turns${subs}${g.paused_reason ? ` · ${g.paused_reason}` : ''}${g.last_evidence ? ` · ${g.last_evidence}` : ''}\n`);
  };

  async function pollGoal(): Promise<void> {
    let seen = false, errors = 0;
    while (!settled) {
      let g: GoalView | null = null;
      try { g = await c.goal(); errors = 0; }
      catch (e) { if (++errors >= 3) { io.stderr(`\ncan't read goal status: ${errMsg(e)}\n`); finish(1); return; } await sleep(1500); continue; }
      if (g) seen = true;
      // The goal vanished after we'd seen it — cleared, or the user switched conversations (goal status
      // reads the ACTIVE session). Stop rather than spin to the timeout.
      if (!g && seen) { if (!o.json) io.stdout('\n[goal gone — cleared or conversation switched]\n'); finish(1); return; }
      if (g && g.status !== 'active' && g.status !== 'draft') {
        const code = g.status === 'done' ? 0 : g.last_verdict === 'blocked' ? 4 : 3;
        if (o.json) io.stdout(`${JSON.stringify({ type: 'goal', goal: g })}\n`);
        else io.stdout(`\n[goal ${g.status}${g.paused_reason ? `: ${g.paused_reason}` : ''}${g.last_evidence ? ` — ${g.last_evidence}` : ''}]\n`);
        finish(code);
        return;
      }
      await sleep(1500);
    }
  }

  // Print an action's result: a structured JSON object in --json mode, a human line otherwise.
  const outResult = (human: string, obj: Record<string, unknown>): void =>
    io.stdout(o.json ? `${JSON.stringify({ type: 'result', ...obj })}\n` : `${human}\n`);

  // Fire a turn WITHOUT blocking on its POST. `POST /brain/send` awaits the whole turn server-side, so on a
  // long turn its response would trip undici's 300s headers timeout and reject — but the turn is fine and
  // the stream keeps delivering events. So completion is driven by the `idle` event (ordered after all
  // text); the POST resolving is only a fallback, and its rejection is a real error ONLY if nothing has
  // streamed (e.g. "brain not started"), never the 300s timeout on a working turn.
  const fireTurn = (text: string, mode: 'build' | 'plan'): void => {
    void c.send(text, mode).then(
      () => { if (!settled) setTimeout(() => { if (!settled) { if (!o.json) io.stdout('\n'); finish(0); } }, 300); },
      (e) => { if (!settled && !activity) { io.stderr(`\n${errMsg(e)}\n`); finish(1); } },
    );
  };

  async function dispatchSlash(p: NonNullable<ReturnType<typeof parseCommand>>): Promise<void> {
    const arg = (p.arg ?? '').trim();
    switch (p.cmd) {
      case 'plan': case 'build': // a mode-tagged turn; streams like a normal turn and settles on idle
        if (arg) fireTurn(arg, p.cmd === 'plan' ? 'plan' : 'build');
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
      case 'compact': { const r = await c.compact(); outResult(r.message ?? 'compacted', { compacted: r.compacted, message: r.message }); finish(0); break; }
      case 'status': { const s = await c.status(); io.stdout(o.json ? `${JSON.stringify({ type: 'result', status: s })}\n` : `${JSON.stringify(s, null, 2)}\n`); finish(0); break; }
      case 'skills': { const sk = await c.skills(); io.stdout(o.json ? `${JSON.stringify({ type: 'result', skills: sk })}\n` : `${JSON.stringify(sk, null, 2)}\n`); finish(0); break; }
      case 'sessions': { // headless equivalent of the TUI picker: list conversations
        const rows = await c.sessions();
        if (o.json) io.stdout(`${JSON.stringify({ type: 'result', sessions: rows })}\n`);
        else for (const r of rows) io.stdout(`${r.active ? '* ' : '  '}${r.id}\t${r.title || '(untitled)'}\t${r.model}\n`);
        finish(0); break;
      }
      case 'model': {
        const parts = arg.split(/\s+/).filter(Boolean);
        // No arg would send `{}` and SILENTLY reset the model to the default — refuse instead.
        if (!parts.length) { io.stderr('/model needs a model id, e.g. -p "/model <provider> <model>".\n'); finish(2); break; }
        const r = await c.setModel(parts.length >= 2 ? { provider: parts[0], model: parts.slice(1).join(' ') } : { model: parts[0] });
        outResult(`model: ${r.model}`, { model: r.model }); finish(0); break;
      }
      case 'reasoning': {
        if (!arg) { io.stderr('/reasoning needs a level (minimal|low|medium|high|xhigh).\n'); finish(2); break; }
        const r = await c.setThinkingLevel(arg); outResult(`thinking: ${r.thinkingLevel}`, { thinkingLevel: r.thinkingLevel }); finish(0); break;
      }
      case 'help': io.stdout(`${USAGE}\n`); finish(0); break;
      case 'resume': io.stderr('use --resume <id> (or --list to see ids) in headless mode.\n'); finish(2); break;
      default: { // any other action command → the generic dispatch
        try { const r = await c.command(p.cmd); outResult(r?.message ?? `/${p.cmd} ok`, { command: p.cmd, message: r?.message }); finish(0); }
        catch (e) { io.stderr(`/${p.cmd}: ${errMsg(e)}\n`); finish(2); }
        break;
      }
    }
  }

  // If the stream never opens (persistent 403/503, or it keeps reconnecting), onOpen never fires and the
  // run would otherwise hang until --timeout. Fail fast with a clear message instead.
  let dispatched = false;
  const connectTimer = setTimeout(() => { if (!dispatched && !settled) { io.stderr("couldn't open the event stream (is the daemon reachable and the brain configured?)\n"); finish(1); } }, 20_000);
  connectTimer.unref?.();

  // A slash that isn't a built-in may be a plugin prompt macro (kind:'prompt') — the same fallback the
  // TUI applies: expand its template with the typed args and send THAT. Anything else goes through
  // literally, so `orca run "/review auth"` runs the dev-commands review prompt, not the raw text.
  const resolveSlashText = async (text: string): Promise<string> => {
    const m = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(text);
    if (!m) return text;
    const defs = await c.commands().catch(() => []);
    const def = defs.find((d) => d.name === m[1] && d.kind === 'prompt' && d.prompt);
    return def ? expandPromptCommand(def.prompt ?? '', m[2] ?? '') : text;
  };

  const dispatch = async (): Promise<void> => {
    if (dispatched) return; dispatched = true; // onOpen fires again on a stream reconnect — dispatch once
    clearTimeout(connectTimer); // the stream is open; drop the connect deadline
    try {
      if (isGoalRun) { await c.setGoal(goalText, false, o.maxTurns); void pollGoal(); }
      else if (parsed) await dispatchSlash(parsed);
      else fireTurn(slash ? await resolveSlashText(slash) : o.prompt!, o.mode);
    } catch (e) { io.stderr(`\n${errMsg(e)}\n`); finish(1); }
  };

  const streamP = c.stream(onEvent, ctrl.signal, 1000, () => void dispatch())
    .catch((e) => { if (!settled) { io.stderr(`stream error: ${errMsg(e)}\n`); finish(1); } });

  const timer = setTimeout(() => {
    if (o.json) io.stdout(`${JSON.stringify({ type: 'timeout', seconds: Math.round(o.timeoutMs / 1000) })}\n`);
    else io.stderr(`\n[timeout after ${Math.round(o.timeoutMs / 1000)}s]\n`);
    finish(124);
  }, o.timeoutMs);
  await doneP;
  clearTimeout(timer);
  clearTimeout(connectTimer);
  await streamP;
  return exit;
}
