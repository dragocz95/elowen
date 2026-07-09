// Terminal plugin: shell commands with the working directory confined to the caller's accessible
// repos (cwd guarded via ctx.assertPathAllowed). Long-running work goes to the background: a process
// registry keeps spawned children + their rolling output, and the
// list/read/kill tools manage them. NOTE: cwd guarding does NOT contain a shell that reads absolute
// paths outside the repo (e.g. the prod config DB), so ALL terminal tools are OWNER-ONLY: only the
// verified operator may run them; role-scoped platform members (Discord) are refused (see denyNonOwner).
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawn } from 'node:child_process';

const DEFAULT_MAX = 60_000;              // output cap per foreground run / background buffer
const DEFAULT_TIMEOUT_MS = 120_000;      // foreground runs get killed after this
const MAX_BG = 16;               // concurrent background processes
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

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
    const onData = (d) => {
      this.output += d.toString();
      if (this.output.length > outputCap) { // keep the tail; new-output reads follow the trim
        const drop = this.output.length - outputCap;
        this.output = this.output.slice(drop);
        this.readOffset = Math.max(0, this.readOffset - drop);
      }
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.on('close', (code) => { this.exitCode = code ?? -1; onClose?.(); });
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

function runForeground(command, cwd, outputCap, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    const onData = (d) => { if (out.length < outputCap) out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = out.length > outputCap ? `${out.slice(0, outputCap)}\n…[truncated]` : out;
      done(`$ ${command}\n(cwd: ${cwd})\n${killed ? '[killed: timeout]\n' : ''}${body}[exit ${code}]`);
    });
    child.on('error', (e) => { clearTimeout(timer); done(`Error: ${e.message}`); });
  });
}

export function register(ctx) {
  const processes = new Map(); // id → BgProcess (local: powers the incremental read_process_output tool)

  // Mirror each background child into the daemon-level registry so the CLI + web can list/read/kill them
  // from a panel next to the todos (ctx.processes is the shared ProcessRegistry). The plugin still owns
  // the BgProcess (spawn/output/kill); the registry gets a thin handle.
  const handleFor = (id, bg, userId, sessionId) => ({
    id, command: bg.command, cwd: bg.cwd, startedAt: bg.startedAt, userId, sessionId,
    running: () => bg.running, exitCode: () => bg.exitCode,
    readAll: () => bg.output, kill: () => bg.kill(),
  });
  // Re-emit the pinned "Background processes" card listing what's still running (empty card → removed).
  // No-op outside an interactive turn (emitCard wires no emitter for worker/cron), which is fine — the
  // web panel reads the live list from GET /brain/processes.
  const emitProcCard = () => {
    const running = ctx.processes.list().filter((p) => p.running);
    ctx.emitCard(running.length
      ? { id: 'bg-processes', title: `Background processes (${running.length})`, items: running.map((p) => ({ text: p.command, status: 'in_progress' })), pinned: true }
      : { id: 'bg-processes' });
  };
  const dropProc = (id) => { processes.delete(id); ctx.processes.remove(id); };

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
    name: 'run_command', label: 'Run command',
    description: 'Run a shell command. Foreground by default (120 s limit); pass background=true for '
      + 'long-running work (dev servers, builds) and manage it with list_processes / read_process_output / kill_process. '
      + 'The working directory is confined to your accessible repositories.',
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to run' }),
      cwd: Type.Optional(Type.String({ description: 'Working directory (must be within your repositories)' })),
      background: Type.Optional(Type.Boolean({ description: 'Run detached and return a process id' })),
    }),
    execute: async (_id, p) => {
      const denied = denyNonOwner();
      if (denied) return denied;
      try {
        const cwd = guardCwd(p.cwd);
        if (!p.background) return ok(await runForeground(p.command, cwd, outputCap, commandTimeoutMs));
        // prune finished processes before the cap check so dead entries don't block new work
        for (const [id, bg] of processes) { if (!bg.running) dropProc(id); }
        if (processes.size >= MAX_BG) return ok(`Error: too many background processes (${MAX_BG}); kill one first.`);
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        // The operator who started it (+ the session they started it in) → wake THAT conversation when it
        // exits (markExited on close). Field is `elowenUserId` (was mis-typed as the pre-rebrand `orcaUserId`,
        // which is undefined → the wake never fired).
        const userId = ctx.currentIdentity?.()?.elowenUserId ?? null;
        const sessionId = ctx.currentSessionId?.() ?? null;
        const bg = new BgProcess(id, p.command, cwd, outputCap, () => { emitProcCard(); ctx.processes.markExited(id); });
        processes.set(id, bg);
        ctx.processes.register(handleFor(id, bg, userId, sessionId));
        emitProcCard();
        return ok(`Started background process ${id}: ${p.command}\n(cwd: ${cwd})\nUse read_process_output("${id}") to check on it.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'list_processes', label: 'List processes',
    description: 'List background processes started with run_command(background=true).',
    parameters: Type.Object({}),
    execute: async () => {
      const denied = denyNonOwner();
      if (denied) return denied;
      if (processes.size === 0) return ok('No background processes.');
      return ok([...processes.values()].map((bg) =>
        `- ${bg.id} ${bg.running ? 'RUNNING' : `exited(${bg.exitCode})`} since ${bg.startedAt}\n  $ ${bg.command}`
      ).join('\n'));
    },
  }));

  ctx.registerTool(defineTool({
    name: 'read_process_output', label: 'Read process output',
    description: 'Read NEW output of a background process since the last read (pass all=true for the full buffer).',
    parameters: Type.Object({
      id: Type.String(),
      all: Type.Optional(Type.Boolean({ description: 'Return the whole buffer instead of just new output' })),
    }),
    execute: async (_id, p) => {
      const denied = denyNonOwner();
      if (denied) return denied;
      const bg = processes.get(p.id);
      if (!bg) return ok(`Error: no background process ${p.id}.`);
      const text = p.all ? bg.output : bg.output.slice(bg.readOffset);
      bg.readOffset = bg.output.length;
      const state = bg.running ? '[still running]' : `[exited ${bg.exitCode}]`;
      if (!bg.running) { dropProc(p.id); emitProcCard(); } // final read collects the corpse
      return ok(`${text || '(no new output)'}\n${state}`);
    },
  }));

  ctx.registerTool(defineTool({
    name: 'kill_process', label: 'Kill process',
    description: 'Kill a background process by id.',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, p) => {
      const denied = denyNonOwner();
      if (denied) return denied;
      const bg = processes.get(p.id);
      if (!bg) return ok(`Error: no background process ${p.id}.`);
      bg.kill();
      dropProc(p.id);
      emitProcCard();
      return ok(`Killed ${p.id} ($ ${bg.command}).`);
    },
  }));

  ctx.logger.info('registered run_command (+background), list/read/kill process tools');
}
