import type { BrainEvent } from '../../brain/events.js';
import { BrainClient } from './brainClient.js';
import type { BrainStreamFrame, GoalView } from './brainClient.js';
import {
  appendReplayBrainEvent,
  brainEventReplayCursor,
  type BrainStreamSnapshot,
} from '../../brain/session/liveEventReplay.js';
import { parseCommand } from './commands.js';
import { resolveToken } from './token.js';

/** Parsed `elowen run` / `elowen -p` invocation. A pure result so the parser is unit-testable. */
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
  'usage: elowen run "<prompt>"   |   elowen -p "<prompt>"',
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

/** A reconnect snapshot is a complete replacement for an interactive view, but headless output has
 * already been written to a terminal and cannot be replaced. Keep a server-equivalent replay tail plus
 * stable durable row ids: that lets us recover missed output without turning a compaction, identical
 * answer, or mutable delegate state into a duplicate terminal line. The first snapshot is a baseline and
 * may contain an older conversation, so it is never printed. */
class HeadlessSnapshotReconciler {
  private historySeeded = false;
  /** Real server snapshots expose these SQLite UUIDs. They survive compaction for kept rows, while an
   * identical new answer receives a distinct id; a sidecar update retains the id and is not reprinted. */
  private durableIds = new Set<string>();
  /** Locally observed current-run events, normalized with the exact server replacement rules. */
  private tail: BrainEvent[] = [];
  /** `agent_start` generation from the latest transport snapshot. Goal continuations have no user event,
   * so this is the authoritative reconnect boundary between their runs. */
  private snapshotRun: number | undefined;
  private terminalSeen = false;
  /** Visible assistant text emitted live but not yet consumed by a durable assistant row. It is a queue,
   * rather than one row's text, because a PI run may contain text → tool → text before agent_end. */
  private pendingAssistantText = '';
  private needsDurableHistory = false;

  constructor(private readonly deliver: (event: BrainEvent) => void) {}

  live(event: BrainEvent): void {
    // The next goal continuation starts with `step`, not a user echo. Mirror server beginRun() after a
    // terminal boundary so an old idle/replay cursor never corrupts its new journal comparison.
    if (this.terminalSeen && (event.type === 'user' || event.type === 'step')) {
      this.tail = [];
      this.terminalSeen = false;
    }
    this.remember(event);
    this.emitLive(event);
  }

  snapshot(snapshot: BrainStreamSnapshot, suppressTerminal = false): void {
    if (snapshot.run !== undefined) {
      if (this.snapshotRun !== undefined && snapshot.run !== this.snapshotRun) {
        this.tail = [];
        this.terminalSeen = false;
      }
      this.snapshotRun = snapshot.run;
    }
    if (snapshot.truncated) this.needsDurableHistory = true;
    this.reconcileHistory(snapshot.history);
    this.reconcileTail(snapshot.events, suppressTerminal);
    // At a terminal boundary the server persisted the run before it published idle/error, so the
    // snapshot history itself is already the complete repair for an earlier truncated journal.
    if (snapshot.events.some((event) => event.type === 'idle' || event.type === 'error')) {
      this.needsDurableHistory = false;
    }
  }

  /** Reconcile an explicit durable history fetch after `idle`. This is required even when no new SSE
   * reconnect happens: a prior bounded snapshot may have omitted early live entries, and the settled
   * store is then the only complete transcript. */
  reconcileDurableHistory(history: BrainStreamSnapshot['history']): void {
    this.reconcileHistory(history);
    this.needsDurableHistory = false;
  }

  needsDurableReconcile(): boolean { return this.needsDurableHistory; }

  private emitLive(event: BrainEvent): void {
    if (event.type === 'text') this.pendingAssistantText += event.delta;
    if (event.type === 'idle' || event.type === 'error') this.terminalSeen = true;
    this.deliver(event);
  }

  private remember(event: BrainEvent): void {
    void appendReplayBrainEvent(this.tail, event);
  }

  private setTail(events: BrainEvent[]): void {
    this.tail = [];
    for (const event of events) this.remember(event);
  }

  private reconcileHistory(history: BrainStreamSnapshot['history']): void {
    const added: BrainStreamSnapshot['history'] = [];
    for (const message of history) {
      // Do not fall back to JSON/text occurrence counts here: compaction can remove an old identical
      // reply, and progress sidecars mutate a row's representation. A daemon predating durable ids still
      // has its live replay tail, but cannot safely offer the post-settle repair contract.
      if (!message.id) continue;
      if (this.historySeeded && !this.durableIds.has(message.id)) added.push(message);
      this.durableIds.add(message.id);
    }
    if (!this.historySeeded) { this.historySeeded = true; return; }

    for (const message of added) {
      if (message.role !== 'assistant') continue;
      const missing = consumeDurableText(message.text, this);
      // A recovered row is ALREADY durable: write it but do not put it back into pendingAssistantText,
      // or the next history refresh would compare that same output again.
      if (missing) this.deliver({ type: 'text', delta: missing });
    }
  }

  private reconcileTail(events: BrainEvent[], suppressTerminal: boolean): void {
    const emitSnapshotEvent = (event: BrainEvent): void => {
      // The first snapshot is captured before this invocation's `send()` runs. Its old `idle`/`error`
      // describes the conversation that existed before this command, not this command's result; retain
      // it in the reconciliation tail but do not let it finish the new invocation prematurely.
      if (suppressTerminal && (event.type === 'idle' || event.type === 'error')) {
        this.terminalSeen = true;
        return;
      }
      this.emitLive(event);
    };
    const hasCursors = events.some((event) => brainEventReplayCursor(event) !== undefined);
    if (hasCursors) {
      const localByCursor = new Map<number, BrainEvent>();
      for (const event of this.tail) {
        const cursor = brainEventReplayCursor(event);
        if (cursor !== undefined) localByCursor.set(cursor, event);
      }
      for (const event of events) {
        const cursor = brainEventReplayCursor(event);
        const known = cursor === undefined ? undefined : localByCursor.get(cursor);
        if (known) continue;
        // A newly coalesced text entry may carry a fresh latest cursor while the old connection already
        // printed its prefix. The normalized local tail supplies that prefix even when state replacement
        // changed an earlier entry's position.
        if ((event.type === 'text' || event.type === 'reasoning')) {
          const prior = [...this.tail].reverse().find((candidate) => candidate.type === event.type) as typeof event | undefined;
          const delta = prior && prior.delta && event.delta.startsWith(prior.delta)
            ? event.delta.slice(prior.delta.length) : prior && prior.delta?.startsWith(event.delta) ? '' : event.delta;
          if (delta) emitSnapshotEvent({ type: event.type, delta });
        } else emitSnapshotEvent(event);
      }
      this.setTail(events);
      return;
    }

    // Legacy daemon fallback (no SSE/snapshot cursors). The shared normalizer above still makes state
    // replacements deterministic; compare a suffix of the local tail to tolerate a bounded snapshot
    // whose earliest entries were already dropped.
    const local = this.tail;
    let known = 0;
    let incoming = 0;
    while (known < local.length && incoming < events.length) {
      const prior = local[known]!;
      const next = events[incoming]!;
      if (sameEvent(prior, next)) { known++; incoming++; continue; }
      // The replay buffer coalesces adjacent token deltas. A live stream may have already printed a
      // prefix, while a reconnect sees the larger coalesced event; write only its new suffix.
      if ((prior.type === 'text' && next.type === 'text') || (prior.type === 'reasoning' && next.type === 'reasoning')) {
        const priorDelta = prior.delta;
        const nextDelta = next.delta;
        if (nextDelta.startsWith(priorDelta)) {
          const suffix = nextDelta.slice(priorDelta.length);
          if (suffix) emitSnapshotEvent({ type: next.type, delta: suffix });
          known++; incoming++;
          continue;
        }
        // A socket can finish delivering bytes immediately before the reconnect snapshot was captured.
        // They are already on stdout, so an older snapshot prefix is safely ignored.
        if (priorDelta.startsWith(nextDelta)) { known++; incoming++; continue; }
      }
      break;
    }
    for (; incoming < events.length; incoming++) emitSnapshotEvent(events[incoming]!);
    this.setTail(events);
  }

  /** Consume the oldest already-printed assistant bytes against one newly durable assistant row. */
  takePendingAssistantText(full: string): string {
    const pending = this.pendingAssistantText;
    if (!pending) return full;
    if (pending.startsWith(full)) {
      this.pendingAssistantText = pending.slice(full.length);
      return '';
    }
    if (full.startsWith(pending)) {
      this.pendingAssistantText = '';
      return full.slice(pending.length);
    }
    let overlap = 0;
    for (let n = Math.min(full.length, pending.length); n > 0; n--) {
      if (pending.slice(-n) === full.slice(0, n)) { overlap = n; break; }
    }
    if (overlap > 0) {
      this.pendingAssistantText = '';
      return full.slice(overlap);
    }
    return full;
  }
}

function consumeDurableText(full: string, reconciler: HeadlessSnapshotReconciler): string {
  return reconciler.takePendingAssistantText(full);
}

function sameEvent(a: BrainEvent, b: BrainEvent): boolean {
  // Events are plain wire objects. Structural comparison keeps snapshot replay independent of object
  // identity (the server intentionally gives concurrent streams distinct serialized frames).
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Non-interactive Elowen: start (or resume) a conversation, run one turn / slash / goal, stream the result
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
    catch { io.stderr('No Elowen token — set ELOWEN_TOKEN or run `elowen login` first.\n'); return 1; }
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
  // consecutive `elowen run` calls from one project keep talking to the same brain — and every follow-up
  // call is BOUND to the resolved session id, so a concurrently open TUI/dock can't hijack it. `--new`
  // starts fresh; `--session <id>` targets a specific conversation. `-c`/`--continue` is the explicit
  // form of the default. The resolved session id is printed so the user knows what they'll continue.
  let sessionId: string;
  try {
    const startOpts = o.session ? { session: o.session } : o.fresh ? { fresh: true } : {};
    ({ sessionId } = await c.start(startOpts));
    if (o.model || o.provider) { const r = await c.setModel({ model: o.model, provider: o.provider }); if (o.verbose) io.stderr(dim(`[model] ${r.model}\n`)); }
  } catch (e) { io.stderr(`start failed: ${errMsg(e)}\n`); return 1; }
  io.stderr(dim(`[session ${sessionId}] — continue with \`elowen run -c "<next>"\` (or --new to start fresh)\n`));
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
  let snapshots!: HeadlessSnapshotReconciler;
  // Every terminal event happens after persistence. Serialise the tiny history repair so a goal that
  // immediately starts its next run cannot race a previous turn's identity bookkeeping, and so a
  // truncated reconnect receives the complete durable assistant row before this command exits.
  let idleReconciliation = Promise.resolve();
  let awaitingIdleReconciliation = false;
  const reconcileAtIdle = (): Promise<void> => {
    awaitingIdleReconciliation = true;
    idleReconciliation = idleReconciliation.then(async () => {
      try { snapshots.reconcileDurableHistory(await c.history()); }
      catch (error) {
        // Live output remains usable on a transient history failure. Call it out only when the bounded
        // replay actually required this repair, rather than turning a healthy finished turn into a hard
        // failure because a best-effort GET raced daemon shutdown.
        if (snapshots.needsDurableReconcile() && !o.json) io.stderr(`\n[unable to reconcile complete transcript: ${errMsg(error)}]\n`);
      }
    }).finally(() => { awaitingIdleReconciliation = false; });
    return idleReconciliation;
  };

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
        // by here all output has been printed. Re-read the durable rows before finishing: a reconnect may
        // have received a truncated replay journal, and goals need the stable ids before their next run.
        // Goals keep looping (many idles) — their final code still comes from pollGoal.
        void reconcileAtIdle().then(() => {
          if (!isGoalRun && !settled && activity) { if (!o.json) io.stdout('\n'); finish(0); }
        });
        break;
    }
  };
  snapshots = new HeadlessSnapshotReconciler(onEvent);
  let firstSnapshot = true;
  const onFrame = (frame: BrainStreamFrame): void => {
    if (frame.type === 'snapshot') {
      snapshots.snapshot(frame, firstSnapshot);
      firstSnapshot = false;
    } else snapshots.live(frame);
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
        await idleReconciliation;
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
      () => { if (!settled) setTimeout(() => {
        if (!settled && !awaitingIdleReconciliation) { if (!o.json) io.stdout('\n'); finish(0); }
      }, 300); },
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
      case 'rename': {
        if (!arg) { io.stderr('/rename needs a conversation title.\n'); finish(2); break; }
        const renamed = await c.renameSession(sessionId, arg);
        outResult(`renamed: ${renamed.title}`, { sessionId, title: renamed.title }); finish(0); break;
      }
      case 'model': {
        const parts = arg.split(/\s+/).filter(Boolean);
        // No arg would send `{}` and SILENTLY reset the model to the default — refuse instead.
        if (!parts.length) { io.stderr('/model needs a model id, e.g. -p "/model <provider> <model>".\n'); finish(2); break; }
        const r = await c.setModel(parts.length >= 2 ? { provider: parts[0], model: parts.slice(1).join(' ') } : { model: parts[0] });
        outResult(`model: ${r.model}`, { model: r.model }); finish(0); break;
      }
      case 'reasoning': {
        if (!arg) { io.stderr('/reasoning needs a model-supported level (for example low|medium|high|ultra|max).\n'); finish(2); break; }
        const r = await c.setThinkingLevel(arg); outResult(`thinking: ${r.thinkingLevel}`, { thinkingLevel: r.thinkingLevel }); finish(0); break;
      }
      case 'fast': {
        const value = arg.toLowerCase();
        if (value === 'status') {
          const s = await c.status();
          outResult(`fast: ${s.fastAvailable ? (s.fast ? 'on' : 'off') : 'unavailable'}`, {
            fast: s.fast ?? false, fastAvailable: s.fastAvailable ?? false,
          });
          finish(0);
          break;
        }
        if (value && value !== 'on' && value !== 'off') {
          io.stderr('/fast accepts on, off, status, or no argument (toggle).\n'); finish(2); break;
        }
        const r = await c.setFast(value === 'on' ? true : value === 'off' ? false : undefined);
        outResult(`fast: ${r.fast ? 'on' : 'off'}`, r); finish(0); break;
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

  const dispatch = async (): Promise<void> => {
    if (dispatched) return; dispatched = true; // onOpen fires again on a stream reconnect — dispatch once
    clearTimeout(connectTimer); // the stream is open; drop the connect deadline
    try {
      // A slash that isn't a built-in (`parsed` is null) is a plugin prompt macro (kind:'prompt') — it
      // rides RAW, so the daemon hands `/review auth` to PI and PI expands the template natively. Plain
      // text goes through as-is.
      if (isGoalRun) { await c.setGoal(goalText, false, o.maxTurns); void pollGoal(); }
      else if (parsed) await dispatchSlash(parsed);
      else fireTurn(slash ?? o.prompt!, o.mode);
    } catch (e) { io.stderr(`\n${errMsg(e)}\n`); finish(1); }
  };

  // The bound stream gets the same reconnect snapshot contract as the TUI. The reconciler above keeps
  // the append-only terminal truthful when a completed reply was missed during a socket drop.
  const streamP = c.stream(onFrame, ctrl.signal, 1000, () => void dispatch(), undefined, true)
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
