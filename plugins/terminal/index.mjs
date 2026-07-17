// Terminal plugin: shell commands with the working directory confined to the caller's accessible
// repos (cwd guarded via ctx.assertPathAllowed). Long-running work goes to the background: a process
// registry keeps spawned children + their rolling output, and the
// list/read/kill tools manage them. NOTE: cwd guarding does NOT contain a shell that reads absolute
// paths outside the repo (e.g. the prod config DB), so ALL terminal tools are OWNER-ONLY: only the
// verified operator may run them; role-scoped platform members (Discord) are refused (see denyNonOwner).
import { defineTool, truncateTail, formatSize, createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX = 60_000;              // output cap per foreground run / background buffer
const DEFAULT_TIMEOUT_MS = 120_000;      // foreground runs get killed after this
// Per-call foreground `timeout` (seconds). A caller may stretch a slow-but-finite run (npm install, a
// full build) past the default instead of pushing it to the background just to survive; 10 minutes is the
// ceiling — anything longer belongs in the background, where nothing kills it.
const MAX_TIMEOUT_S = 600;
const MIN_TIMEOUT_S = 1;
// Blocking `ProcessOutput` — wait for a background process to finish instead of polling it. Capped
// well under the foreground ceiling: a blocked read holds the agent's turn open, and the process keeps
// running after a timeout, so the caller can simply block again.
const DEFAULT_BLOCK_S = 30;
const MAX_BLOCK_S = 120;
const MAX_BG = 16;               // concurrent background processes
const PROGRESS_THROTTLE_MS = 100;        // min gap between live-output pushes of a foreground run
const PROGRESS_TAIL = 2_000;             // rolling TAIL of live output sent per push (never the whole buffer)
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);
/** Clamp a caller-supplied seconds value into [min, max], falling back to `def` when absent/garbage. */
const clampSeconds = (value, def, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), min), max);
};

// PI's local shell backend for FOREGROUND runs. Two things it gets right that a hand-rolled spawn does
// not: (1) `waitForChildProcess` resolves on the shell's exit WITHOUT hanging on a stdout/stderr pipe a
// detached grandchild (e.g. a dev-server the command forked) still holds open; (2) a timeout kills the
// whole process TREE via `killProcessTree`, not just the top shell. We pair it with a streaming UTF-8
// decoder below so a multibyte character split across two `data` chunks is never mangled. Background
// processes stay on our own spawn (BgProcess) — PI has no live, re-readable, kill-by-id registry.
const bashOps = createLocalBashOperations();

/** One background child: rolling output buffer + exit state, addressable by a short id. */
class BgProcess {
  constructor(id, command, cwd, outputCap, onClose) {
    this.id = id;
    this.command = command;
    this.cwd = cwd;
    this.output = '';
    this.readOffset = 0;
    this.exitCode = null;
    this.startedAt = new Date().toISOString();
    // `detached: true` puts the child shell in its OWN process group (pgid == its pid) instead of the
    // daemon's. Without it, `shell: true` runs `/bin/sh -c "<cmd>"` and kill() would only reap the shell —
    // any grandchild (e.g. the `sleep`/dev-server the shell forked) is orphaned to init and keeps running.
    // With its own group we can signal the whole tree via `process.kill(-pid)` in kill().
    this.child = spawn(command, { cwd, shell: true, env: process.env, detached: true });
    // Streaming UTF-8 decoders: a multibyte character delivered across two `data` events is held until
    // complete, so the rolling buffer never contains a U+FFFD from a chunk boundary (a plain per-chunk
    // `d.toString()` would corrupt it). stdout and stderr are TWO independent pipes that interleave at
    // arbitrary byte boundaries, so each gets its OWN decoder — sharing one would let a stderr chunk be
    // fed to the decoder mid-way through an unfinished stdout character and mangle it (and vice versa).
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    const onData = (decoder) => (d) => {
      this.output += decoder.write(d);
      if (this.output.length > outputCap) { // keep the tail; new-output reads follow the trim
        const drop = this.output.length - outputCap;
        this.output = this.output.slice(drop);
        this.readOffset = Math.max(0, this.readOffset - drop);
      }
    };
    this.child.stdout.on('data', onData(this.stdoutDecoder));
    this.child.stderr.on('data', onData(this.stderrDecoder));
    // Flush any bytes either decoder was holding for a trailing partial character before the state flips.
    this.child.on('close', (code) => { this.output += this.stdoutDecoder.end() + this.stderrDecoder.end(); this.exitCode = code ?? -1; onClose?.(); });
    this.child.on('error', (e) => { this.output += `\n[spawn error: ${e.message}]`; this.exitCode = -1; onClose?.(); });
  }
  get running() { return this.exitCode === null; }
  // Kill the whole process group (negative pid) so the shell AND anything it forked die together; fall
  // back to a plain child kill if the group signal fails (e.g. the child already exited).
  kill() {
    try { process.kill(-this.child.pid, 'SIGKILL'); }
    catch { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

async function runForeground(command, cwd, outputCap, timeoutMs, onProgress) {
  // Streaming UTF-8 decoder: PI hands us raw Buffer chunks; decode incrementally so a multibyte
  // character split across two chunks is reassembled instead of turning into U+FFFD. Keep only a bounded
  // rolling tail (2× the cap of headroom for a clean line-aware final trim) so a runaway command can't
  // grow `out` without limit; truncateTail below produces the final tail — bash errors live at the END,
  // so we keep the tail (not the head). NOTE: PI's exec funnels BOTH stdout and stderr into this single
  // `onData` (bash.js does `child.stdout.on('data', onData); child.stderr.on('data', onData)`), so — unlike
  // BgProcess where we own the pipes — we cannot split them into per-stream decoders here; a multibyte char
  // split exactly across a stdout/stderr boundary is an unavoidable PI-level edge (rare, merged stream).
  const decoder = new StringDecoder('utf8');
  let out = '';
  // Live output: push a bounded rolling TAIL to onProgress as the command runs, THROTTLED so a chatty
  // command (npm test / build) can't flood the stream. onProgress is absent for callers that don't stream.
  let lastEmit = 0;
  const emitProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    onProgress(out.length > PROGRESS_TAIL ? out.slice(out.length - PROGRESS_TAIL) : out);
  };
  const onData = (d) => {
    out += decoder.write(d);
    if (out.length > outputCap * 2) out = out.slice(out.length - outputCap * 2);
    emitProgress();
  };
  let exitCode = null;
  let killed = false;
  try {
    // PI's exec takes its timeout in SECONDS; on expiry it SIGKILLs the whole process tree and throws
    // `timeout:<seconds>`. It also throws for a missing cwd or shell-spawn failure. `env: process.env`
    // preserves the daemon's environment (PATH etc.) the same way the old spawn did.
    const res = await bashOps.exec(command, cwd, { onData, env: process.env, timeout: Math.ceil(timeoutMs / 1000) });
    exitCode = res.exitCode;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('timeout:')) { killed = true; exitCode = null; }
    else return `Error: ${msg}`;
  }
  out += decoder.end(); // flush any bytes held for a trailing partial character
  // Byte-only cap: `maxLines: Infinity` overrides PI's 2000-line default, which would otherwise
  // silently clip long-but-small output (e.g. a lint report) far under the configured `outputCap`.
  const t = truncateTail(out, { maxBytes: outputCap, maxLines: Infinity });
  const body = t.truncated
    ? `…[truncated: last ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}]\n${t.content}`
    : t.content;
  // Ensure the exit marker starts on its own line — the tail may not end in a newline, which would
  // otherwise glue `[exit N]` onto the last line of real output the model parses.
  const sep = body.endsWith('\n') || body.length === 0 ? '' : '\n';
  // Name the deadline that actually applied — the model has to know whether to re-run with a longer
  // `timeout` or move the command to the background, and "[killed: timeout]" alone doesn't say which.
  const note = killed ? `[killed: timed out after ${Math.round(timeoutMs / 1000)}s]\n` : '';
  return `$ ${command}\n(cwd: ${cwd})\n${note}${body}${sep}[exit ${exitCode}]`;
}

export function register(ctx) {
  const currentSessionId = () => ctx.currentSessionId?.() ?? null;
  // The daemon-level registry (ctx.processes) is the SINGLE source of truth for background children: it is
  // what the CLI + web panel list/read/kill, and what deleteSession/killSession prunes. The plugin used to
  // keep a parallel Map, which nothing else could reach — so a registry-side kill (session deleted, panel ✕)
  // left a ghost row here that still occupied a cap slot and could be read. The plugin now only owns the
  // BgProcess object captured in each handle's closures (spawn/output/kill); everything else goes through
  // the registry.
  const scopedHandle = (id) => {
    const handle = ctx.processes.get(id);
    return handle && handle.sessionId === currentSessionId() ? handle : undefined;
  };

  // The thin handle the registry gets: metadata + callbacks into the BgProcess this closure owns.
  // `readNew` is the agent's incremental read (advances the buffer cursor); the daemon's panel reads
  // `readAll`, which never moves it.
  const handleFor = (id, bg, userId, sessionId, completionMode) => ({
    id, command: bg.command, cwd: bg.cwd, startedAt: bg.startedAt, userId, sessionId,
    completionMode,
    running: () => bg.running, exitCode: () => bg.exitCode,
    readAll: () => bg.output,
    readNew: (all) => {
      const text = all ? bg.output : bg.output.slice(bg.readOffset);
      bg.readOffset = bg.output.length;
      return text;
    },
    kill: () => bg.kill(),
  });
  // Re-emit the pinned "Background processes" card listing what's still running (empty card → removed).
  // No-op outside an interactive turn (emitCard wires no emitter for worker/cron), which is fine — the
  // web panel reads the live list from GET /brain/processes.
  const emitProcCard = (sessionId = currentSessionId()) => {
    if (!sessionId) return;
    const running = ctx.processes.listForSession(sessionId).filter((p) => p.running);
    ctx.emitCard(running.length
      ? { id: 'bg-processes', title: `Background processes (${running.length})`, items: running.map((p) => ({ text: p.command, status: 'in_progress' })), pinned: true }
      : { id: 'bg-processes' });
  };

  // Also caps the rolling buffer kept for background processes (BgProcess.output trim above).
  const outputCap = Math.min(Math.max(Number(ctx.config.outputCap) || DEFAULT_MAX, 10_000), 500_000);
  const commandTimeoutMs = Math.min(Math.max(Number(ctx.config.commandTimeoutMs) || DEFAULT_TIMEOUT_MS, 30_000), 600_000);

  // Default cwd is host-resolved (ctx.defaultCwd): the session's bound project path when there is one,
  // re-established every run — an explicit `cwd` from one call never carries into the next.
  const guardCwd = (cwd) => ctx.assertPathAllowed(cwd ?? ctx.defaultCwd());

  // Owner-only gate. The shell runs with process.env and can read ANY absolute path — cwd guarding
  // doesn't contain that (e.g. `cat /var/www/.config/elowen/elowen.db`). So these tools are reserved for
  // the verified operator: a role-scoped platform member (Discord) is refused even with an admin role.
  // Gate on `owner`, never `admin` — an admin-mapped stranger is admin-but-not-owner.
  const denyNonOwner = () => (ctx.currentIdentity?.()?.owner === true
    ? null
    : ok('Error: terminal tools are only available to the operator.'));

  ctx.registerTool(defineTool({
    name: 'Bash', label: 'Run command',
    description: [
      'Execute a shell command and return its output.',
      'The working directory is confined to your accessible repositories. Use absolute paths — `cd` inside a compound command is unreliable and can shift context unexpectedly. Shell state (env vars, functions) does not persist between calls; the shell is initialized fresh each time.',
      'Prefer the dedicated file tools (Read, Edit, Write, Search, ListDir) over cat, head, tail, sed, awk or echo. Reach for the shell when the task genuinely needs it: builds, tests, git, service inspection, process management.',
      `Foreground runs are killed after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)} s; raise it with \`timeout\` (seconds, max ${MAX_TIMEOUT_S}) for a slow but finite command such as an install or a full build.`,
      'Pass background=true for open-ended work (dev servers, watchers) — it runs detached and returns a process id with no time limit. Manage those with ListProcesses / ProcessOutput / KillProcess, and use backgroundMode="service" for a long-lived process that should never be collected as a finite job.',
      'A denied or blocked command means a permission rule stopped it — adjust the approach, do not retry it verbatim. Keep secrets out of command lines and output.',
    ].join(' '),
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to run' }),
      cwd: Type.Optional(Type.String({ description: 'Working directory (must be within your repositories)' })),
      timeout: Type.Optional(Type.Number({
        description: `Foreground timeout in SECONDS (default ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}, max ${MAX_TIMEOUT_S}). On expiry the process tree is killed and the output so far is returned. Ignored when background=true.`,
      })),
      background: Type.Optional(Type.Boolean({ description: 'Run detached and return a process id' })),
      backgroundMode: Type.Optional(Type.Union([Type.Literal('job'), Type.Literal('service')], {
        description: 'job (default) keeps a delegated agent active until the finite command is collected; service is for long-lived servers/watchers.',
      })),
    }),
    execute: async (_id, p, _signal, onUpdate) => {
      const denied = denyNonOwner();
      if (denied) return denied;
      try {
        const cwd = guardCwd(p.cwd);
        if (!p.background) {
          // An explicit per-call `timeout` overrides the configured default, clamped to [1 s, 10 min]; the
          // background path ignores it entirely (a detached process has no deadline to extend).
          const timeoutMs = p.timeout === undefined
            ? commandTimeoutMs
            : clampSeconds(p.timeout, Math.round(commandTimeoutMs / 1000), MIN_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
          // Stream the rolling output tail live as it runs. `onUpdate` is PI's 4th execute argument (the
          // agent loop passes it, forwarded verbatim through the Elowen tool wrappers); each call emits a
          // `tool_execution_update` the daemon maps to a throttled `tool_progress` event. Absent for callers
          // that don't stream (background path never uses it — it has ProcessOutput instead).
          const onProgress = onUpdate ? (text) => onUpdate(ok(text)) : undefined;
          return ok(await runForeground(p.command, cwd, outputCap, timeoutMs, onProgress));
        }
        // prune finished processes before the cap check so dead entries don't block new work (the cap is
        // per session, so both the prune and the count stay session-scoped)
        const sessionId = currentSessionId();
        if (!sessionId) return ok('Error: background processes require an authenticated conversation.');
        for (const proc of ctx.processes.listForSession(sessionId)) { if (!proc.running) ctx.processes.remove(proc.id); }
        if (ctx.processes.listForSession(sessionId).length >= MAX_BG) return ok(`Error: too many background processes (${MAX_BG}); kill one first.`);
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        // The operator who started it (+ the session they started it in) → wake THAT conversation when it
        // exits (markExited on close). Field is `elowenUserId` (was mis-typed as the pre-rebrand `orcaUserId`,
        // which is undefined → the wake never fired).
        const userId = ctx.currentIdentity?.()?.elowenUserId ?? null;
        const bg = new BgProcess(id, p.command, cwd, outputCap, () => { emitProcCard(sessionId); ctx.processes.markExited(id); });
        ctx.processes.register(handleFor(id, bg, userId, sessionId, p.backgroundMode === 'service' ? 'service' : 'job'));
        emitProcCard();
        return ok(`Started background process ${id}: ${p.command}\n(cwd: ${cwd})\nUse ProcessOutput("${id}") to check on it.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ListProcesses', label: 'List processes',
    description: 'List background processes started with Bash(background=true).',
    parameters: Type.Object({}),
    execute: async () => {
      const denied = denyNonOwner();
      if (denied) return denied;
      const sessionId = currentSessionId();
      const own = sessionId ? ctx.processes.listForSession(sessionId) : [];
      if (own.length === 0) return ok('No background processes.');
      return ok(own.map((proc) =>
        `- ${proc.id} ${proc.running ? 'RUNNING' : `exited(${proc.exitCode})`} since ${proc.startedAt}\n  $ ${proc.command}`
      ).join('\n'));
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ProcessOutput', label: 'Read process output',
    description: [
      'Read the output (stdout + stderr) of a background process started with Bash(background=true).',
      'By default this returns only what was written SINCE your last read and does not wait — the process keeps running.',
      'Pass all=true for the whole buffer from process start.',
      `Pass block=true to WAIT for the process to finish instead of polling: the call returns as soon as it exits, or after \`timeout\` seconds (default ${DEFAULT_BLOCK_S}, max ${MAX_BLOCK_S}) with the output so far and a note that it is still running. Use it whenever you need a finite command's result — never call this in a polling loop.`,
      'The process id comes from the Bash call that started it; use ListProcesses if you did not start it yourself. This tool is only for shell processes — a background sub-agent result comes back through DelegateResult.',
    ].join(' '),
    parameters: Type.Object({
      id: Type.String({ description: 'Process id returned by Bash(background=true)' }),
      all: Type.Optional(Type.Boolean({ description: 'Return the whole buffer instead of just new output' })),
      block: Type.Optional(Type.Boolean({ description: 'Wait for the process to finish before returning (default false).' })),
      timeout: Type.Optional(Type.Number({ description: `Seconds to wait when block=true (default ${DEFAULT_BLOCK_S}, max ${MAX_BLOCK_S}). Ignored otherwise.` })),
    }),
    execute: async (_id, p) => {
      const denied = denyNonOwner();
      if (denied) return denied;
      const handle = scopedHandle(p.id);
      if (!handle) return ok(`Error: no background process ${p.id}.`);
      // Blocking read: park until the process exits (or the deadline passes) instead of making the model
      // poll. The wait is bounded and the process survives a timeout, so a caller that still needs the
      // result simply blocks again. Waiting on the ALREADY-SCOPED handle is what keeps this safe — an id
      // from another session was rejected above, so nobody can block on a conversation they can't read.
      let waitedOut = false;
      if (p.block === true && handle.running()) {
        const waitS = clampSeconds(p.timeout, DEFAULT_BLOCK_S, MIN_TIMEOUT_S, MAX_BLOCK_S);
        waitedOut = await ctx.processes.waitForExit(p.id, waitS * 1000) === 'timeout';
      }
      // Sample `running` BEFORE reading: a process that exits between the read and the check would
      // otherwise be collected here while output written after our read is still lost. Reading first from a
      // handle we then keep (because it looked alive) at worst costs one more read call.
      const running = handle.running();
      const text = handle.readNew(p.all === true);
      const state = running
        ? `[still running${waitedOut ? ` after waiting ${clampSeconds(p.timeout, DEFAULT_BLOCK_S, MIN_TIMEOUT_S, MAX_BLOCK_S)}s` : ''}]`
        : `[exited ${handle.exitCode()}]`;
      if (!running) { ctx.processes.remove(p.id); emitProcCard(); } // final read collects the corpse
      return ok(`${text || '(no new output)'}\n${state}`);
    },
  }));

  ctx.registerTool(defineTool({
    name: 'KillProcess', label: 'Kill process',
    description: 'Kill a background process by id.',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, p) => {
      const denied = denyNonOwner();
      if (denied) return denied;
      const handle = scopedHandle(p.id);
      if (!handle) return ok(`Error: no background process ${p.id}.`);
      ctx.processes.kill(p.id); // kills the child AND drops the entry
      emitProcCard();
      return ok(`Killed ${p.id} ($ ${handle.command}).`);
    },
  }));

  ctx.logger.info('registered Bash (+background), list/read/kill process tools');
}
