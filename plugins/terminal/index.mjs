// Terminal plugin: Bash plus foreground/background process lifecycle. Filesystem authority, account HOME,
// workspace selection and confinement belong to the live Sandbox control. Terminal resolves that control
// for every launch so plugin reloads apply immediately and no stale security generation is retained.
//
// The plugin is `userGrantable` and carries no grant gate of its own: the host's per-account tool policy
// decides who may reach Bash and the process tools.
import { defineTool, formatSize } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, join, posix } from 'node:path';

function guestCwd(path, base = '/workspace') {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('invalid managed project cwd');
  return posix.resolve(base, path);
}

function validatePreparedInput(input) {
  if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) throw new Error('invalid prepared stdin');
  if (input !== undefined && Buffer.byteLength(input) > 1024 * 1024) throw new Error('prepared stdin exceeds the 1 MiB limit');
}

function guestCancellation(prepared) {
  if (prepared.cancel) return () => prepared.cancel();
  if (prepared.lease.cancel) return () => prepared.lease.cancel();
  if (prepared.mode === 'managed') throw new Error('managed execution requires verified guest cancellation');
  return null;
}

function spawnPrepared(launch, options) {
  return launch.type === 'argv'
    ? spawn(launch.file, launch.args, { ...options, env: launch.env, shell: false })
    : spawn(launch.command, { ...options, env: launch.env, shell: true });
}

const DEFAULT_MAX = 60_000;              // output cap per foreground run / background buffer
/** The reference's foreground deadline and ceiling, with the reference's env seams
 *  (`src/utils/timeouts.ts`): a positive integer in the variable wins, and the ceiling is never allowed
 *  below the default. Both take milliseconds, like the `timeout` argument itself. */
export function getDefaultBashTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.BASH_DEFAULT_TIMEOUT_MS ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 120_000 : parsed;
}
export function getMaxBashTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.BASH_MAX_TIMEOUT_MS ?? '', 10);
  const floor = getDefaultBashTimeoutMs(env);
  return Number.isNaN(parsed) || parsed <= 0 ? Math.max(600_000, floor) : Math.max(parsed, floor);
}
const DEFAULT_TIMEOUT_MS = getDefaultBashTimeoutMs();
const MAX_TIMEOUT_MS = getMaxBashTimeoutMs();
const MIN_TIMEOUT_MS = 1;
const MIN_TIMEOUT_S = 1;
// Blocking `ProcessOutput` — wait for a background process to finish instead of polling it. Capped
// well under the foreground ceiling: a blocked read holds the agent's turn open, and the process keeps
// running after a timeout, so the caller can simply block again.
//
// NOTE on background lifetime: a background process outlives the TURN, but not the daemon. A sandboxed
// one is torn down with the daemon by `--die-with-parent`, and an unsandboxed one is killed with the
// service cgroup on restart anyway — the in-memory registry that addresses it does not survive either.
const DEFAULT_BLOCK_S = 30;
const MAX_BLOCK_S = 600;
// A foreground run has ONE deadline: the `timeout` of the call that started it. The caller decides how
// long the turn waits, so a separate, shorter blocking budget could only cut that wait short against the
// caller's stated intent. What the deadline DOES changes instead: instead of killing the run and throwing
// its output away, it moves the run to the background, where it keeps running and can be read with
// ProcessOutput. The exclusions below decide WHERE that trade makes sense.
//
// …and WHERE that trade makes sense. Handing back a process id instead of the result only helps someone
// who can ask for the rest: a person in their own chat, who sees the process card and can read the run
// later. A delegated turn — a sub-agent or a workflow node — reports one final answer to its parent and is
// never asked a follow-up, so turning its `vitest` or build call into a process id throws the output away.
// A shared room is excluded for the same reason its process card is (see emitProcCard): the run belongs to
// one writer among several, so it keeps the plain deadline it had before this budget existed.
const AUTO_BACKGROUND_CONVERSATIONS = new Set(['own', 'direct']);
// Below this a `sleep` is pacing (rate limiting, a deliberate beat), at or above it it is a poll. Same
// threshold as the reference, which blocks the same shape.
const MIN_BLOCKED_SLEEP_S = 2;
const DEFAULT_MAX_BG = 16;       // default concurrent background processes per session (cfg: maxBackgroundProcesses)
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

const cwdReportingCommand = (command) =>
  `trap '__elowen_status=$?; printf "%s\\0" "$PWD" >&3; trap - EXIT; exit "$__elowen_status"' EXIT\n${command}`;
const durationLabel = (ms) => ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;

function resolveBackground(input) {
  // `background` is replay-only compatibility for transcripts created before the canonical rename. It is
  // deliberately absent from the schema so a model sees exactly one argument for this concept.
  if (input.run_in_background !== undefined && input.background !== undefined
    && input.run_in_background !== input.background) {
    throw new Error('run_in_background conflicts with the replay-only background value');
  }
  return input.run_in_background ?? input.background ?? false;
}

function resolveTimeoutMs(input) {
  if (input.timeout === undefined) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(input.timeout);
  if (!Number.isFinite(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return Math.round(timeout);
}

/** Convert the cwd reported from inside a workspace namespace back to its host path, then run the ordinary
 * path authority check again. A guest path outside /workspace is never interpreted as a host path. */
export function mapReportedCwd(reported, prepared, assertAllowed, workspacePathView = false) {
  if (prepared.mode === 'managed') {
    if (!posix.isAbsolute(reported)) throw new Error('reported guest cwd is not absolute');
    return guestCwd(reported);
  }
  let candidate = reported;
  if (prepared.workspace) {
    if (reported === '/workspace') candidate = workspacePathView ? '.' : prepared.workspace.path;
    else if (reported.startsWith('/workspace/')) {
      const relative = reported.slice('/workspace/'.length);
      candidate = workspacePathView ? relative : join(prepared.workspace.path, relative);
    } else throw new Error('reported cwd is outside the assigned workspace');
  }
  if (!workspacePathView && !isAbsolute(candidate)) throw new Error('reported cwd is not absolute');
  return assertAllowed(candidate);
}

/** Tokenize top-level shell commands just far enough for the restart safety check below. Control
 *  operators split commands only OUTSIDE quotes, so an SSH payload remains an argument of `ssh` rather
 *  than masquerading as a local command. This is deliberately not an execution parser: the real shell
 *  still owns expansion and syntax; we only need executable positions and literal systemctl arguments. */
const shellCommandWords = (command) => {
  const commands = [];
  let words = [];
  let word = '';
  let started = false;
  let quote = null;
  let escaped = false;
  const pushWord = () => {
    if (!started) return;
    words.push(word);
    word = '';
    started = false;
  };
  const pushCommand = () => {
    pushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const input = String(command);
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) { word += char; started = true; escaped = false; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === '\\') escaped = true;
      else { word += char; started = true; }
      continue;
    }
    if (char === '\\') { escaped = true; started = true; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/u.test(char)) { pushWord(); continue; }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      pushCommand();
      if ((char === '|' || char === '&') && input[index + 1] === char) index += 1;
      continue;
    }
    word += char;
    started = true;
  }
  if (escaped) word += '\\';
  pushCommand();
  return commands;
};

/** Extract local command and process substitutions. Single-quoted and escaped syntax is inert; command
 * substitutions inside double quotes still execute, while process-substitution-looking text there is literal. */
const commandSubstitutions = (command) => {
  const substitutions = [];
  const input = String(command);
  let quote = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"' && char === '"') { quote = null; continue; }
    if (quote === null && char === "'") { quote = "'"; continue; }
    if (quote === null && char === '"') { quote = '"'; continue; }
    if (char === '`') {
      let end = index + 1;
      let innerEscaped = false;
      for (; end < input.length; end += 1) {
        if (innerEscaped) { innerEscaped = false; continue; }
        if (input[end] === '\\') { innerEscaped = true; continue; }
        if (input[end] === '`') break;
      }
      if (end < input.length) {
        substitutions.push(input.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    const substitution = (char === '$' || (quote === null && (char === '<' || char === '>')))
      && input[index + 1] === '(';
    if (!substitution) continue;
    const start = index + 2;
    let depth = 1;
    let nestedQuote = null;
    let nestedEscaped = false;
    let end = start;
    for (; end < input.length; end += 1) {
      const nested = input[end];
      if (nestedEscaped) { nestedEscaped = false; continue; }
      if (nested === '\\' && nestedQuote !== "'") { nestedEscaped = true; continue; }
      if (nestedQuote) {
        if (nested === nestedQuote) nestedQuote = null;
        continue;
      }
      if (nested === "'" || nested === '"') { nestedQuote = nested; continue; }
      if (nested === '(') depth += 1;
      else if (nested === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      substitutions.push(input.slice(start, end));
      index = end;
    }
  }
  return substitutions;
};

const allShellCommandWords = (command) => {
  const commands = shellCommandWords(command);
  for (const substitution of commandSubstitutions(command)) commands.push(...allShellCommandWords(substitution));
  for (const words of [...commands]) {
    const index = commandExecutableIndex(words);
    const executable = executableName(words[index]);
    if (!['bash', 'sh', 'dash', 'ksh', 'zsh'].includes(executable)) continue;
    const args = words.slice(index + 1);
    const commandFlag = args.findIndex((arg) => arg === '-c' || arg === '--command' || /^-[^-]*c[^-]*$/u.test(arg));
    const payload = commandFlag >= 0 ? args[commandFlag + 1] : undefined;
    if (payload) commands.push(...allShellCommandWords(payload));
  }
  return commands;
};

const executableName = (word) => word?.replace(/^[({]+|[)}]+$/gu, '').split('/').pop();
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SUDO_OPTIONS_WITH_VALUE = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-r', '--role', '-t', '--type']);
const SYSTEMCTL_RESTART_ACTIONS = new Set(['restart', 'try-restart', 'reload-or-restart', 'reload-or-try-restart']);

const commandExecutableIndex = (words) => {
  let index = 0;
  for (;;) {
    const executable = executableName(words[index]);
    if (executable === 'env') {
      index += 1;
      while (words[index]?.startsWith('-') || ENV_ASSIGNMENT.test(words[index] ?? '')) {
        if (words[index] === '-u' || words[index] === '--unset') index += 1;
        index += 1;
      }
      continue;
    }
    if (executable === 'command' || executable === 'exec' || executable === 'nohup') {
      index += 1;
      while (words[index]?.startsWith('-')) index += 1;
      continue;
    }
    if (executable === 'sudo') {
      index += 1;
      while (words[index]?.startsWith('-')) {
        const option = words[index];
        index += 1;
        if (SUDO_OPTIONS_WITH_VALUE.has(option) && !option.includes('=')) index += 1;
      }
      continue;
    }
    return index;
  }
};

/** A blocking local restart of elowen-daemon can never complete from Bash: systemd SIGTERMs the daemon
 *  that owns this tool call, while the daemon's graceful drain waits for this very tool call to settle.
 *  On boot the interrupted deployment resumes and can issue the same restart again, creating a 10-minute
 *  loop. Transparent wrappers are unwrapped, but SSH payloads and systemctl remote-host calls stay allowed. */
const isBlockingSelfRestart = (command) => allShellCommandWords(command).some((words) => {
  const index = commandExecutableIndex(words);
  if (executableName(words[index]) !== 'systemctl') return false;
  const args = words.slice(index + 1);
  const restart = args.findIndex((arg) => SYSTEMCTL_RESTART_ACTIONS.has(arg));
  if (restart < 0 || args.includes('--no-block')) return false;
  const remote = args.some((arg) =>
    arg === '-H' || arg === '--host' || arg.startsWith('--host=') || /^-H.+/u.test(arg));
  if (remote) return false;
  return args.slice(restart + 1).some((unit) => unit === 'elowen-daemon' || unit === 'elowen-daemon.service');
});

/** GNU sleep's suffixes, in seconds. `sleep 5m` blocks a turn for five minutes, so the check has to
 *  understand the argument rather than assume every wait is spelled in bare seconds. */
const SLEEP_UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 };

/** The duration in seconds of a `sleep` that is a POLL rather than a pause, or null. Narrower than the
 *  reference's shape (BashTool.tsx:322-337), which refuses any line STARTING with a sleep: here the whole
 *  command has to be bare `sleep` plus one argument, so `sleep 19; tail /tmp/build.log` — the way an agent
 *  reads back a run it started — is left alone. It then judges the DURATION: anything from
 *  MIN_BLOCKED_SLEEP_S upward is a poll, whatever unit it is written in. The reference tests the spelling
 *  instead, which passes `sleep 5m` and `sleep 2.0` while refusing `sleep 2`; a rule that only catches the
 *  honest spelling teaches evasion.
 *
 *  A duration this cannot resolve (`sleep $WAIT`, `sleep "$@"`) is left alone: guessing at an unexpanded
 *  variable would refuse commands on a hunch. So is a `sleep` in a line that goes on to do something
 *  (`build && sleep 5 && check`): that is a pause inside somebody's script, and the turn still ends with a
 *  RESULT. Only a line whose entire content is the sleep spends the turn on nothing else.
 *
 *  Only foreground runs are checked — see the call site. A backgrounded sleep blocks nothing, and it is a
 *  legitimate way to hold a process slot; the cost this refuses is a turn spent waiting. */
const blockedSleepSeconds = (command) => {
  const commands = shellCommandWords(command);
  const first = commands.length === 1 ? commands[0] : undefined;
  if (!first || first.length !== 2 || executableName(first[0]) !== 'sleep') return null;
  const match = /^(\d+(?:\.\d+)?)([smhd])?$/u.exec(first[1]);
  if (!match) return null;
  const seconds = Number(match[1]) * (match[2] ? SLEEP_UNIT_SECONDS[match[2]] : 1);
  return seconds >= MIN_BLOCKED_SLEEP_S ? seconds : null;
};

/** Short process id shared by the foreground-detach and background spawn paths. */
const newProcessId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const processGroupAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
};
const DIRECT_PROCESS_TOKEN_ENV = 'ELOWEN_TERMINAL_PROCESS_TOKEN';
const directTokenPids = (token) => {
  if (!token || process.platform !== 'linux') return [];
  const needle = Buffer.from(`${DIRECT_PROCESS_TOKEN_ENV}=${token}\0`);
  const pids = [];
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        if (readFileSync(`/proc/${name}/environ`).includes(needle)) pids.push(pid);
      } catch { /* process exited or belongs to another uid */ }
    }
  } catch { /* /proc unavailable */ }
  return pids.sort((a, b) => b - a);
};
const killDirectTokenProcesses = (token) => {
  for (const pid of directTokenPids(token)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
};
const waitForDirectTokenExit = async (token) => {
  while (directTokenPids(token).length > 0) await new Promise((resolve) => setTimeout(resolve, 25));
};
const killProcessGroup = (child, directToken = null) => {
  if (!child) return;
  // A direct-host descendant can call setsid(2) and escape the shell's process group. Every direct child
  // receives a per-run environment token, so Linux can still identify and kill those escaped descendants.
  killDirectTokenProcesses(directToken);
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  killDirectTokenProcesses(directToken);
};
const launchWithDirectToken = (prepared) => {
  const directToken = prepared.mode === 'direct' && process.platform === 'linux'
    ? randomBytes(24).toString('hex')
    : null;
  const upstreamSanitize = prepared.sanitizeOutput ?? ((text) => String(text));
  if (!directToken) return { launch: prepared.launch, directToken, sanitizeOutput: upstreamSanitize };
  return {
    directToken,
    launch: { ...prepared.launch, env: { ...prepared.launch.env, [DIRECT_PROCESS_TOKEN_ENV]: directToken } },
    // The token is process metadata, not user-visible state. A command such as `env` must not publish it.
    sanitizeOutput: (text) => upstreamSanitize(text).split(directToken).join('[REDACTED]'),
  };
};
const waitForProcessGroupExit = async (pid) => {
  while (processGroupAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 25));
};

const startLeaseHeartbeat = (lease, onFailure) => {
  const timer = setInterval(() => { Promise.resolve().then(() => lease.heartbeat()).catch(onFailure); }, 5_000);
  timer.unref?.();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    await lease.release();
  };
};

/** One background child: rolling output buffer + exit state, addressable by a short id. */
class BgProcess {
  constructor(id, command, cwd, outputCap, onClose, prepared) {
    this.id = id;
    this.cwd = prepared.displayCwd ?? cwd;
    this.spawnCwd = prepared.cwd ?? cwd;
    this.workspaceScoped = !!prepared.workspace || prepared.mode === 'managed';
    this.projectRef = prepared.projectRef;
    this.runtimeGeneration = prepared.lease.runtimeGeneration;
    this.cancelGuest = guestCancellation(prepared);
    this.stdin = prepared.stdin;
    this.cancellation = null;
    this.output = '';
    this.outputBytes = 0;
    this.dropped = 0;
    this.outputCap = outputCap;
    this.readOffset = 0;
    this.exitCode = null;
    this.finished = false;
    this.startedAt = new Date().toISOString();
    this.workspaceId = prepared.workspace?.workspaceId ?? null;
    this.homeGeneration = prepared.lease.homeGeneration;
    if (prepared.mode === 'direct' && process.platform !== 'linux') {
      throw new Error('direct-host background execution is unavailable on this platform because escaped descendants cannot be terminated safely');
    }
    const { launch, directToken, sanitizeOutput } = launchWithDirectToken(prepared);
    this.directToken = directToken;
    this.sanitizeOutput = sanitizeOutput;
    this.command = this.sanitizeOutput(command);
    // `detached: true` puts the child shell in its own process group. A direct Linux launch also carries a
    // per-run token so kill() can reap descendants that deliberately create a different process group.
    this.child = spawnPrepared(launch, { cwd: this.spawnCwd, detached: true });
    if (this.stdin !== undefined) {
      this.child.stdin.on('error', (error) => {
        // A command may deliberately stop reading before the supplied script ends.
        if (error.code !== 'EPIPE') this.appendOutput(`\n[stdin error: ${this.sanitizeOutput(error.message)}]`);
      });
      this.child.stdin.end(this.stdin);
    }
    this.releaseLease = startLeaseHeartbeat(prepared.lease, (error) => {
      this.appendOutput(`\n[execution lease failed: ${this.sanitizeOutput(error.message)}]`);
      this.kill().catch((cause) => this.appendOutput(`\n[guest cancellation failed: ${this.sanitizeOutput(cause.message)}]`));
    });
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    const onData = (decoder) => (d) => { this.appendOutput(decoder.write(d)); };
    this.child.stdout.on('data', onData(this.stdoutDecoder));
    this.child.stderr.on('data', onData(this.stderrDecoder));
    let settled = false;
    const finish = async (code, error) => {
      if (settled) return;
      settled = true;
      if (error) {
        try { await this.kill(); }
        catch (cause) { this.appendOutput(`\n[guest cancellation failed: ${this.sanitizeOutput(cause.message)}]`); }
      }
      await waitForProcessGroupExit(this.child.pid);
      await waitForDirectTokenExit(this.directToken);
      this.appendOutput(this.stdoutDecoder.end() + this.stderrDecoder.end());
      if (error) this.appendOutput(`\n[spawn error: ${error.message}]`);
      this.exitCode = code ?? -1;
      try { if (this.cancellation) await this.cancellation; }
      catch (cause) { this.appendOutput(`\n[guest cancellation failed: ${this.sanitizeOutput(cause.message)}]`); this.exitCode = -1; }
      try { await this.releaseLease(); }
      catch (cause) { this.appendOutput(`\n[execution cleanup failed: ${this.sanitizeOutput(cause.message)}]`); this.exitCode = -1; }
      this.finished = true;
      onClose?.();
    };
    this.child.on('close', (code) => { void finish(code); });
    this.child.on('error', (error) => { void finish(-1, error); });
  }
  appendOutput(text) {
    if (!text) return;
    this.output += text;
    this.outputBytes += Buffer.byteLength(text, 'utf8');
    if (this.outputBytes <= this.outputCap) return;
    // Front-drop, unlike a foreground run: a background process is READ INCREMENTALLY as it goes, so its
    // beginning has usually already been delivered and the newest output is what has not. Track bytes as
    // chunks arrive rather than using UTF-16 string length as a precondition for measuring the real budget.
    const cut = truncateTailBytes(this.output, this.outputCap);
    const keptBytes = Buffer.byteLength(cut, 'utf8');
    this.dropped += this.outputBytes - keptBytes;
    this.readOffset = Math.max(0, this.readOffset - (this.output.length - cut.length));
    this.output = cut;
    this.outputBytes = keptBytes;
  }
  get running() { return !this.finished; }
  kill() {
    if (!this.cancelGuest) { killProcessGroup(this.child, this.directToken); return Promise.resolve(); }
    this.cancellation ??= Promise.resolve().then(() => this.cancelGuest())
      .finally(() => killProcessGroup(this.child, this.directToken));
    return this.cancellation;
  }
}

/** One foreground Bash run that Ctrl+B can detach into a background job. The durable Sandbox lease stays
 * attached to the actual process promise, not to the Bash tool call, so detaching never releases it early. */
class ForegroundRun {
  constructor(id, command, cwd, outputCap, timeoutMs, prepared) {
    this.id = id;
    this.cwd = prepared.displayCwd ?? cwd;
    this.spawnCwd = prepared.cwd ?? cwd;
    this.workspaceScoped = !!prepared.workspace || prepared.mode === 'managed';
    this.projectRef = prepared.projectRef;
    this.runtimeGeneration = prepared.lease.runtimeGeneration;
    this.cancelGuest = guestCancellation(prepared);
    this.stdin = prepared.stdin;
    this.cancellation = null;
    this.startedAt = new Date().toISOString();
    this.output = '';
    this.readOffset = 0;
    /** Bytes the rolling buffer below discarded from the middle, so the final result can state the true
     *  size of the run instead of the size of what happened to survive. */
    this.dropped = 0;
    /** Index in `output` where the discarded middle was cut out, so a read can tell whether the slice it
     *  is about to return actually spans the seam. `null` until something is dropped. */
    this.seamAt = null;
    this.exitCode = null;
    this.finished = false;
    this.outputCap = outputCap;
    this.timeoutMs = timeoutMs;
    this.detached = false;
    this.timedOut = false;
    this.killed = false;
    this.spawnError = null;
    this.child = null;
    this.workspaceId = prepared.workspace?.workspaceId ?? null;
    this.homeGeneration = prepared.lease.homeGeneration;
    const { launch, directToken, sanitizeOutput } = launchWithDirectToken(prepared);
    this.launch = launch;
    this.directToken = directToken;
    this.sanitizeOutput = sanitizeOutput;
    this.command = this.sanitizeOutput(command);
    this.canDetach = prepared.mode !== 'direct' || process.platform === 'linux';
    this.releaseLease = startLeaseHeartbeat(prepared.lease, (error) => {
      this.spawnError = `execution lease failed: ${this.sanitizeOutput(error.message)}`;
      this.kill().catch((cause) => { this.spawnError += `; guest cancellation failed: ${this.sanitizeOutput(cause.message)}`; });
    });
    // One decoder PER STREAM. A single shared decoder holds the bytes of an incomplete UTF-8 character
    // until the next write completes it — and the next write may come from the other stream, so a
    // character split across stdout chunks gets finished with stderr's bytes and both come out mojibake.
    this._stdoutDecoder = new StringDecoder('utf8');
    this._stderrDecoder = new StringDecoder('utf8');
    this._cwdDecoder = new StringDecoder('utf8');
    this._reportedCwd = '';
    this._timer = null;
    /** Asked ONCE, when the run's own deadline expires: return true to move the run to the background
     *  instead of killing it. The tool call installs it only where auto-background applies; without it
     *  the deadline stays a plain kill. */
    this.onDeadline = null;
    this._resolveDetached = null;
    this.detachedPromise = new Promise((resolve) => { this._resolveDetached = resolve; });
  }
  get running() { return !this.finished; }
  get reportedCwd() {
    const end = this._reportedCwd.indexOf('\0');
    return end < 0 ? null : this._reportedCwd.slice(0, end);
  }
  detach() {
    if (this.detached) return;
    this.detached = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._resolveDetached();
  }
  kill() {
    if (this.killed) return this.cancellation ?? Promise.resolve();
    this.killed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this.cancelGuest) { killProcessGroup(this.child, this.directToken); return Promise.resolve(); }
    this.cancellation = Promise.resolve().then(() => this.cancelGuest())
      .finally(() => killProcessGroup(this.child, this.directToken));
    return this.cancellation;
  }
  async run(onProgress) {
    let lastEmit = 0;
    const emitProgress = () => {
      if (!onProgress || this.detached) return;
      const now = Date.now();
      if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      const visible = this.sanitizeOutput(this.output);
      onProgress(visible.length > PROGRESS_TAIL ? visible.slice(visible.length - PROGRESS_TAIL) : visible);
    };
    const onData = (decoder) => (d) => {
      this.output += decoder.write(d);
      const limit = this.outputCap * 2;
      // BYTES, not UTF-16 code units. `outputCap` is presented to the operator in kB and the final cut is
      // made in bytes, so measuring the buffer in characters let a non-Latin run hold three times the
      // budget it was given. The cheap length check guards the byte count, which only runs once the
      // buffer could possibly be over.
      if (this.output.length > limit && Buffer.byteLength(this.output, 'utf8') > limit) {
        // Discard from the MIDDLE, never the front. The head carries the command's own echo, whatever
        // configuration a tool prints on startup and any error raised before the bulk began — a
        // front-dropping buffer threw exactly that away, which would leave the head half of the final
        // head+tail cut showing the middle of the run and calling it the beginning.
        //
        // The same cut the settled result makes, so UTF-8 boundary handling lives in one place instead of
        // a second hand-rolled copy here — but WITHOUT line alignment. A buffer's job is to retain as many
        // bytes as its budget allows, and aligning to lines throws away everything between them: 300 kB
        // that is one enormous line between two short ones collapses to just those two short lines, and
        // the final cut is then left with nothing to work from. Presentation wants whole lines; a buffer
        // wants bytes.
        const cut = truncateMiddle(this.output, { maxBytes: limit, alignToLines: false });
        if (cut.truncated) {
          this.dropped += cut.totalBytes - cut.keptBytes;
          const seamAt = cut.head.length;
          const removed = this.output.length - (cut.head.length + cut.tail.length);
          // Everything behind the hole moved left, so a detached run's incremental cursor has to move
          // with it. Clamping to the new length instead would park the cursor at the end and make
          // ProcessOutput report "nothing new" for output that had in fact just arrived.
          if (this.readOffset > seamAt) this.readOffset = Math.max(seamAt, this.readOffset - removed);
          this.output = cut.head + cut.tail;
          this.seamAt = seamAt;
        }
      }
      emitProgress();
    };
    this._timer = setTimeout(() => {
      // The deadline is reached. Where auto-background applies the run is PRESERVED as a background
      // process instead of being killed with its output thrown away; `detach()` resolves the tool's race.
      if (this.onDeadline?.()) return;
      this.timedOut = true;
      this.kill().catch((error) => { this.spawnError = `guest cancellation failed: ${this.sanitizeOutput(error.message)}`; });
    }, this.timeoutMs);
    try {
      await new Promise((resolveRun, rejectRun) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (error) rejectRun(error); else resolveRun();
        };
        try {
          this.child = spawnPrepared(this.launch, {
            cwd: this.spawnCwd, detached: true,
            stdio: [this.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe'],
          });
          if (this.stdin !== undefined) {
            this.child.stdin.on('error', (error) => {
              if (error.code !== 'EPIPE') this.spawnError = `stdin error: ${this.sanitizeOutput(error.message)}`;
            });
            this.child.stdin.end(this.stdin);
          }
        } catch (error) {
          finish(error);
          return;
        }
        this.child.stdout.on('data', onData(this._stdoutDecoder));
        this.child.stderr.on('data', onData(this._stderrDecoder));
        this.child.stdio[3]?.on('data', (chunk) => {
          if (this._reportedCwd.length < 16_384) this._reportedCwd += this._cwdDecoder.write(chunk);
        });
        this.child.once('error', finish);
        this.child.once('close', (code) => {
          this.exitCode = this.killed || this.timedOut ? null : code ?? -1;
          void waitForProcessGroupExit(this.child.pid)
            .then(() => waitForDirectTokenExit(this.directToken))
            .then(() => finish(), finish);
        });
      });
    } catch (error) {
      this.spawnError = this.sanitizeOutput(error instanceof Error ? error.message : String(error));
      try { await this.kill(); }
      catch (cause) { this.spawnError += `; guest cancellation failed: ${this.sanitizeOutput(cause.message)}`; }
    } finally {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this.output += this._stdoutDecoder.end() + this._stderrDecoder.end();
      this._reportedCwd += this._cwdDecoder.end();
      try { if (this.cancellation) await this.cancellation; }
      catch (error) { this.spawnError = `guest cancellation failed: ${this.sanitizeOutput(error.message)}`; }
      try { await this.releaseLease(); }
      catch (error) { this.spawnError = `execution cleanup failed: ${this.sanitizeOutput(error.message)}`; }
      if (this.spawnError) {
        this.output += `\n[${this.spawnError}]`;
        this.exitCode = -1;
      }
      this.finished = true;
    }
  }
}

/** Keep at most `maxBytes` of UTF-8 from the END, without splitting a character. Used by the background
 *  rolling buffer, whose beginning has usually already been read incrementally. */
function truncateTailBytes(content, maxBytes) {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return content;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

/** Room set aside for the truncation banner, which is written after the budget is decided and whose exact
 *  length depends on the sizes it reports. Generous on purpose: overshooting the cap costs the result its
 *  tail (see formatRunResult), while a hundred spare bytes cost nothing. */
const TRUNCATION_BANNER_RESERVE = 200;
/** Reserve this much of the cap for process output before command/cwd framing gets its own middle cut.
 *  A pathological invocation must cost itself its own echo, not the model's view of what the command did. */
const MIN_RESULT_BODY_BYTES = 2_000;

/** Cut a long output in the MIDDLE, keeping both ends.
 *
 *  PI's `truncateTail` keeps only the end, which is right for a build log whose error is its last line and
 *  wrong for most other output: it discards the command's own echo, the configuration a tool prints on
 *  startup and any error raised before the bulk began. Both ends carry the evidence; the middle is where
 *  the repetition lives. `Read` deliberately stays head-only — its `offset` argument is how a caller
 *  continues, so there is nothing to lose at the end.
 *
 *  Kept local to this plugin rather than shared: Bash is the only consumer, and no bundled plugin imports
 *  the shared package today, so introducing a publish cycle would cost more than the reuse is worth.
 *
 *  Cuts on a line boundary when the budget contains one, and falls back to a raw byte offset when a single
 *  line is larger than the budget (a minified bundle, one huge JSON line) — half of a giant line still
 *  tells the model what it is looking at, where refusing to cut would blow the budget it was given. A raw
 *  offset is then snapped onto a UTF-8 character boundary: decoding half a character produces U+FFFD, and
 *  a replacement character in the middle of a path or an identifier is worse than one byte less output.
 *
 *  `maxBytes` bounds the OUTPUT, not the whole block: the banner describing the cut is metadata about the
 *  truncation, exactly as it was while this was tail-only. */
function truncateMiddle(content, { maxBytes, alignToLines = true }) {
  const buf = Buffer.from(content, 'utf8');
  if (!(maxBytes >= 2) || buf.length <= maxBytes) {
    return { head: content, tail: '', truncated: false, totalBytes: buf.length, keptBytes: buf.length };
  }
  const NEWLINE = 0x0a;
  // A UTF-8 continuation byte is 10xxxxxx; a cut may only land on a byte that is not one.
  const isContinuation = (index) => index > 0 && index < buf.length && (buf[index] & 0xc0) === 0x80;
  const backToBoundary = (index) => { let i = index; while (isContinuation(i)) i -= 1; return i; };
  const forwardToBoundary = (index) => { let i = index; while (isContinuation(i)) i += 1; return i; };

  const headBudget = Math.floor(maxBytes / 2);
  const tailBudget = maxBytes - headBudget;
  const lastNewline = alignToLines ? buf.lastIndexOf(NEWLINE, headBudget - 1) : -1;
  const headEnd = lastNewline >= 0 ? lastNewline + 1 : backToBoundary(headBudget);

  const tailFrom = buf.length - tailBudget;
  const firstNewline = alignToLines ? buf.indexOf(NEWLINE, tailFrom) : -1;
  // A newline that IS the last byte would leave an EMPTY tail — which is exactly what one enormous line
  // terminated by a newline produces, and it silently turns head+tail back into head-only. Accept a
  // line-aligned tail only when something follows the newline; otherwise take the raw offset, which is
  // the fallback an oversized line is supposed to get.
  const tailStart = firstNewline >= 0 && firstNewline + 1 < buf.length
    ? Math.max(headEnd, firstNewline + 1)
    : Math.max(headEnd, forwardToBoundary(tailFrom));
  return {
    head: buf.subarray(0, headEnd).toString('utf8'),
    tail: buf.subarray(tailStart).toString('utf8'),
    truncated: true,
    totalBytes: buf.length,
    keptBytes: headEnd + (buf.length - tailStart),
  };
}

/** Bound a block with a visible middle-cut notice. The payload and notice together fit `maxBytes`. */
function truncateBlock(content, maxBytes, describe) {
  const totalBytes = Buffer.byteLength(content, 'utf8');
  if (totalBytes <= maxBytes) return content;
  const banner = `\n…[${describe(totalBytes)}]\n`;
  const payloadBudget = maxBytes - Buffer.byteLength(banner, 'utf8');
  const t = truncateMiddle(content, { maxBytes: payloadBudget, alignToLines: false });
  return `${t.head}${banner}${t.tail}`;
}

/** Format a settled run's rolling buffer into the `$ cmd … [exit N]` block the model reads.
 *
 *  `dropped` is what ForegroundRun's own buffer already discarded mid-run. It is USUALLY still above the
 *  cap when it gets here — the buffer's limit is twice `outputCap` — so the banner normally sits between
 *  a head and a tail. It is not guaranteed to, because workspace-path sanitisation runs in between and
 *  shrinks the text, so the no-middle case is handled rather than assumed.
 *
 *  The reported total mixes sanitised surviving bytes with unsanitised discarded ones, so it is a size
 *  estimate rather than an exact byte count of what the process wrote. Naming a slightly imprecise total
 *  is still far better than the previous behaviour, which reported the size of whatever survived and
 *  called it the size of the run.
 *
 *  `persistFullOutput` is called exactly when this format is about to withhold something — the caller
 *  writes the run's whole output to the host's tool-result spill store and hands back `{path, bytes}` (or
 *  null when it could not), which the banner names so the excerpt stops being the only copy. Awaiting it
 *  here rather than at the call site keeps ONE decision about whether anything is lost: `willTruncate`
 *  below is the same comparison the cut makes, so no file is ever written for a result that turns out to
 *  fit. */
async function formatRunResult(command, cwd, out, exitCode, note, outputCap, dropped = 0, persistFullOutput = null) {
  const exit = typeof exitCode === 'number' ? `[exit ${exitCode}]` : '';
  const rawHeader = `$ ${command}\n(cwd: ${cwd})\n${note}`;
  // Reserve a useful output body before bounding pathological command/cwd text. Without this first cut, a
  // multibyte command whose echo alone exceeded the cap either blew the complete result budget or consumed
  // the whole head half of a final safety cut, hiding the beginning of the process output.
  const headerBudget = outputCap
    - MIN_RESULT_BODY_BYTES
    - TRUNCATION_BANNER_RESERVE
    - Buffer.byteLength(exit, 'utf8')
    - 1;
  const header = truncateBlock(rawHeader, headerBudget,
    (bytes) => `command/cwd framing truncated from ${formatSize(bytes)}`);

  // The cap bounds the WHOLE result, not just the stream inside it.
  //
  // This is not tidiness. A tool result larger than the operator's inline-result threshold is spilled to
  // disk and replaced in the transcript by a HEAD-ONLY preview — which would throw away precisely the tail
  // this truncation exists to keep. Both defaults are 60 kB, so budgeting only the output meant every
  // truncated command overshot by the length of its own echo and banner and got its tail deleted by the
  // spill: the feature defeated itself under the settings almost everyone runs.
  const spendable = outputCap
    - Buffer.byteLength(header, 'utf8')
    - Buffer.byteLength(exit, 'utf8')
    - 1;
  // Whether this result will withhold anything, decided BEFORE the cut so the stored path can be part of
  // the banner the cut is budgeted against. It is exactly the cut's own condition: the buffer already lost
  // bytes mid-run, or the output does not fit the budget a bannerless result would get. A file is
  // therefore written for every truncated result and for no untruncated one.
  const willTruncate = dropped > 0 || Buffer.byteLength(out, 'utf8') > spendable - TRUNCATION_BANNER_RESERVE;
  const spill = willTruncate && persistFullOutput ? await persistFullOutput() : null;
  // `retained`, not `full`, once the rolling buffer has already dropped bytes mid-run: the file then holds
  // everything that survived plus the notice naming the loss, and calling that the full output would be
  // the exact dishonesty this banner exists to avoid.
  const saved = spill?.error ? `; output export failed: ${spill.error}` : spill
    ? `; ${dropped > 0 ? 'retained' : 'full'} output (${formatSize(spill.bytes)}) saved to ${spill.path} — read it with the Read tool, offset/limit for a slice`
    : '';
  const budget = spendable - TRUNCATION_BANNER_RESERVE - Buffer.byteLength(saved, 'utf8');
  const t = truncateMiddle(out, { maxBytes: budget });
  const lost = t.totalBytes - t.keptBytes + dropped;
  let body = t.head;
  if (lost > 0) {
    const headBytes = Buffer.byteLength(t.head, 'utf8');
    const kept = t.truncated
      ? `; kept ${formatSize(headBytes)} head + ${formatSize(t.keptBytes - headBytes)} tail`
      : '';
    const banner = `…[truncated: dropped ${formatSize(lost)} of ${formatSize(t.totalBytes + dropped)}${kept}${saved}]`;
    // The head may not end in a newline (a byte-offset cut through a long line), and the banner has to
    // start on its own line or the model reads it as part of the output.
    const lead = t.head.endsWith('\n') || t.head.length === 0 ? '' : '\n';
    // Without a cut of its own there is no middle to sit in: the loss happened somewhere inside output
    // that now fits, and the only honest placement left is after all of it.
    body = t.truncated ? `${t.head}${lead}${banner}\n${t.tail}` : `${t.head}${lead}${banner}\n`;
  }
  // Ensure the exit marker starts on its own line — the tail may not end in a newline, which would
  // otherwise glue `[exit N]` onto the last line of real output the model parses.
  const sep = body.endsWith('\n') || body.length === 0 ? '' : '\n';
  const result = `${header}${body}${sep}${exit}`;
  // The reserves above keep ordinary results inside the cap while retaining maximum useful output. This
  // final invariant also covers future framing changes and arbitrarily long multibyte metadata.
  return truncateBlock(result, outputCap,
    (bytes) => `complete result truncated from ${formatSize(bytes)} to fit ${formatSize(outputCap)}`);
}

/** Name what a run's rolling buffer discarded, so a retained tail or a glued head+tail is never presented
 * as complete output. Explicit background runs drop from the beginning; Ctrl+B runs drop from the middle. */
function withDropNotice(bg, text) {
  const dropped = bg.dropped ?? 0;
  if (dropped <= 0) return text;
  const location = bg.seamAt == null ? 'beginning' : 'middle';
  return `${text}\n…[${formatSize(dropped)} was dropped from the ${location} of this output while the process ran]`;
}

export function register(ctx) {
  const currentSessionId = () => ctx.currentSessionId?.() ?? null;
  const currentAccountUserId = () => ctx.currentAccountUserId();
  const sessionCwds = new Map();
  const cwdStateKey = () => {
    const sessionId = currentSessionId();
    // A remembered shell cd belongs to this effective root, not every later binding of the conversation.
    // Capture this key before launch so a finishing old turn cannot overwrite the new root's cwd.
    const access = ctx.currentAccess();
    const workspaceId = access.workspaceRef?.workspaceId ?? '';
    const project = access.projectRef;
    return sessionId ? `${currentAccountUserId() ?? 'accountless'}\0${sessionId}\0${project?.kind ?? ''}:${project?.projectId ?? ''}\0${workspaceId}\0${ctx.defaultCwd()}` : null;
  };
  const rememberCwd = (key, cwd) => {
    if (!key) return;
    sessionCwds.delete(key);
    sessionCwds.set(key, cwd);
    if (sessionCwds.size > 256) sessionCwds.delete(sessionCwds.keys().next().value);
  };
  // The daemon-level registry (ctx.processes) is the SINGLE source of truth for background children: it is
  // what the CLI + web panel list/read/kill, and what deleteSession/killSession prunes. The plugin used to
  // keep a parallel Map, which nothing else could reach — so a registry-side kill (session deleted, panel ✕)
  // left a ghost row here that still occupied a cap slot and could be read. The plugin now only owns the
  // BgProcess object captured in each handle's closures (spawn/output/kill); everything else goes through
  // the registry.
  const authorizeProcess = async (handle) => {
    if (handle.projectRef?.kind !== 'managed') return;
    const sandbox = ctx.control('sandbox');
    if (!sandbox) throw new Error('managed process access requires the Sandbox plugin');
    const environment = await sandbox.environmentFor({ project: handle.projectRef, accountUserId: currentAccountUserId() });
    if (handle.runtimeGeneration !== undefined && environment.generation !== handle.runtimeGeneration) {
      throw new Error('managed process belongs to a stale environment generation');
    }
  };
  const scopedHandle = async (id) => {
    const handle = ctx.processes.get(id);
    const accountUserId = currentAccountUserId();
    if (!handle || handle.sessionId !== currentSessionId()
      || (handle.accountUserId ?? handle.userId ?? null) !== accountUserId) return undefined;
    await authorizeProcess(handle);
    return handle;
  };

  // The thin handle the registry gets: metadata + callbacks into the BgProcess this closure owns.
  // `readNew` is the agent's incremental read (advances the buffer cursor); the daemon's panel reads
  // `readAll`, which never moves it.
  const handleFor = (id, bg, accountUserId, sessionId, completionMode, workspaceId = null, homeGeneration = null) => ({
    id, command: bg.command, cwd: bg.cwd, startedAt: bg.startedAt,
    accountUserId, sessionId, workspaceId, homeGeneration, completionMode,
    projectRef: bg.projectRef, runtimeGeneration: bg.runtimeGeneration,
    running: () => bg.running, exitCode: () => bg.exitCode,
    readAll: () => withDropNotice(bg, bg.sanitizeOutput(bg.output)),
    readNew: (all) => {
      // A host prefix may be split across process chunks or the incremental cursor. Workspace-scoped output
      // is therefore sanitized as one complete buffer before it is exposed; repeating prior output is safer
      // than returning a cross-boundary fragment that reconstructs a host path.
      const whole = bg.workspaceScoped || all;
      const from = whole ? 0 : bg.readOffset;
      const text = bg.sanitizeOutput(whole ? bg.output : bg.output.slice(from));
      bg.readOffset = bg.output.length;
      // The notice belongs to a slice that contains the loss boundary. A detached run has a middle seam;
      // an explicit background run front-drops, so its first unread slice or any whole retained-buffer read
      // must say that the beginning is gone. Later incremental tail slices do not repeat the notice.
      const includesLoss = bg.seamAt != null
        ? from <= bg.seamAt
        : (bg.dropped ?? 0) > 0 && (whole || from === 0);
      return includesLoss ? withDropNotice(bg, text) : text;
    },
    kill: () => {
      const pending = bg.kill();
      pending.catch((error) => ctx.logger.error(`terminal: process ${id} cancellation failed: ${bg.sanitizeOutput(error.message)}`));
      return pending;
    },
  });
  // Re-emit the pinned "Background processes" card listing what's still running (empty card → removed).
  // No-op outside an interactive turn (emitCard wires no emitter for worker/cron), which is fine — the
  // web panel reads the live list from GET /brain/processes.
  const emitProcCard = (sessionId = currentSessionId(), accountUserId = currentAccountUserId()) => {
    if (!sessionId) return;
    // A shared room is readable by several people, while process command lines belong to one verified
    // writer. Its tools remain available, but the conversation-wide card is omitted rather than leaking
    // one account's commands to everyone else in the room.
    if (ctx.currentIdentity?.()?.conversation === 'shared') return;
    // An in-flight foreground command is not a background process — exclude it so another process exiting
    // mid-run can't redraw this card with the caller's own live command listed in it.
    const running = ctx.processes.listForSessionAccount(sessionId, accountUserId)
      .filter((p) => p.running && p.completionMode !== 'foreground');
    const cardId = `bg-processes-${accountUserId ?? 'accountless'}`;
    ctx.emitCard(running.length
      ? { id: cardId, title: `Background processes (${running.length})`, items: running.map((p) => ({ text: p.command, status: 'in_progress' })), pinned: true }
      : { id: cardId });
  };

  // In-flight FOREGROUND runs, keyed by process id, that Ctrl+B can detach. An entry lives only while its
  // Bash tool call is genuinely running: it is added at spawn and removed the moment the run settles or
  // detaches. `detachForeground` (registered below) resolves each matching run's race.
  const foregroundRuns = new Map();
  // In-flight BLOCKING `ProcessOutput` reads. A blocked read holds the turn open exactly like a foreground
  // command does, so Ctrl+B has to be able to release it: `detachForeground` resolves each matching wait
  // early and the tool returns the output so far, leaving the process itself untouched.
  const blockedReads = new Map();
  let blockedReadSeq = 0;
  // Pending explicit launches and Ctrl+B conversions reserve capacity synchronously before any await or
  // detach. JavaScript's run-to-completion semantics make this check-and-increment atomic on the daemon
  // event loop, while the release closure keeps every failure path idempotent.
  const backgroundReservations = new Map();
  const reservationKey = (sessionId, accountUserId) => `${accountUserId ?? 'accountless'}\0${sessionId}`;
  const reserveBackgroundSlot = (sessionId, accountUserId) => {
    for (const proc of ctx.processes.listForSessionAccount(sessionId, accountUserId)) {
      if (!proc.running) ctx.processes.remove(proc.id);
    }
    const key = reservationKey(sessionId, accountUserId);
    const reserved = backgroundReservations.get(key) ?? 0;
    const registered = ctx.processes.listForSessionAccount(sessionId, accountUserId)
      .filter((proc) => proc.completionMode !== 'foreground').length;
    if (registered + reserved >= maxBackgroundProcesses) return null;
    backgroundReservations.set(key, reserved + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (backgroundReservations.get(key) ?? 1) - 1;
      if (remaining > 0) backgroundReservations.set(key, remaining);
      else backgroundReservations.delete(key);
    };
  };

  // THE one way a foreground run becomes a background job, shared by Ctrl+B (the `terminal` control) and
  // by the blocking budget below. Both need the identical sequence — reserve a slot, remember how to
  // release it, resolve the run's detach race — and a second copy of it is how one path would end up
  // leaking a reservation or detaching a run that had already been killed.
  //
  // `reason` is recorded on the entry so the settled tool result can say WHY the command moved; it does
  // not change what happens. Returns false when the run cannot be detached (already detached, no longer
  // running, a direct-host launch on a platform where escaped descendants cannot be reaped, or the
  // session's background slots are full) — in which case the run simply stays in the foreground.
  const detachRun = (entry, reason) => {
    // `killed` is checked separately from `running`, and it is load-bearing. A killed run keeps
    // `exitCode === null` on purpose (that is what makes it read as `[killed]` rather than `[exit N]`), so
    // `running` stays TRUE for the whole SIGKILL-to-settle window — long enough for a budget timer firing
    // in the same moment to reserve a slot and report a command the user had just stopped as "moved to
    // background". killForeground already refuses an entry whose kill is in flight; so does this now.
    if (entry.run.detached || entry.run.killed || !entry.run.running || !entry.run.canDetach) return false;
    const releaseSlot = reserveBackgroundSlot(entry.sessionId, entry.accountUserId);
    if (!releaseSlot) return false;
    entry.releaseBackgroundSlot = releaseSlot;
    entry.detachReason = reason;
    entry.run.detach();
    return true;
  };

  // Also caps the rolling buffer kept for background processes (BgProcess.output trim above).
  const outputCap = Math.min(Math.max(Number(ctx.config.outputCap) || DEFAULT_MAX, 10_000), 500_000);
  // The bounds here MUST mirror the manifest's, because the server stores plugin config unvalidated —
  // a wider clamp would honour a value the settings UI rejects, a narrower one would silently ignore an
  // accepted setting.
  const maxBackgroundProcesses = Math.min(Math.max(Number(ctx.config.maxBackgroundProcesses) || DEFAULT_MAX_BG, 1), 64);

  // Explicit cwd wins. Otherwise a successful foreground call's final cwd persists for this account/session;
  // a new session starts from the bound workspace or project default. Every reuse passes authority again.
  const guardCwd = (cwd) => {
    const key = cwdStateKey();
    const requested = cwd ?? (key ? sessionCwds.get(key) : undefined)
      ?? (ctx.currentAccess().workspaceRef ? '.' : ctx.defaultCwd());
    return ctx.currentAccess().projectRef?.kind === 'managed'
      ? guestCwd(requested, ctx.defaultCwd()) : ctx.assertPathAllowed(requested);
  };

  /** Resolve the live Sandbox owner for every command. A disabled/missing owner never becomes an implicit
   * host-shell grant: only a true instance operator gets the explicit compatibility fallback. */
  const prepareLaunch = async (command, cwd) => {
    const access = ctx.currentAccess();
    const sandbox = ctx.control('sandbox');
    if (access.projectRef?.kind === 'managed' && !sandbox) {
      throw new Error('managed project execution is unavailable because it requires the Sandbox plugin');
    }
    if (sandbox) {
      const prepared = await sandbox.prepareExecution({
        command: { type: 'shell', command }, cwd, leaseKind: 'terminal',
        ...(access.projectRef ? { projectRef: access.projectRef } : {}),
        ...(access.workspaceRef ? { workspace: access.workspaceRef } : {}),
      });
      if (access.projectRef?.kind === 'managed' && (prepared.mode !== 'managed'
        || prepared.projectRef?.kind !== 'managed' || prepared.projectRef.projectId !== access.projectRef.projectId)) {
        await prepared.lease.release();
        throw new Error('managed project provider returned a different execution target');
      }
      try {
        validatePreparedInput(prepared.stdin);
        guestCancellation(prepared);
      } catch (error) {
        await prepared.lease.release();
        throw error;
      }
      return prepared;
    }
    if (access.workspaceRef) {
      throw new Error('the shell is unavailable because exact workspace confinement requires the Sandbox plugin');
    }
    if (access.owner !== true) {
      throw new Error('the shell is unavailable because the Sandbox plugin is disabled or failed to load; non-operator commands cannot run directly on the host');
    }
    const home = process.env.HOME || '/';
    const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'));
    env.HOME = home;
    return {
      mode: 'direct', cwd, displayCwd: cwd, home, roots: ctx.allowedRoots(), launch: { type: 'shell', command, env }, workspace: null,
      lease: { id: `terminal-direct-${Date.now()}`, accountUserId: currentAccountUserId(), workspaceId: null, homeGeneration: null, heartbeat() {}, release() {} },
      sanitizeOutput: (text) => String(text),
    };
  };

  ctx.registerTool(defineTool({
    name: 'Bash', label: 'Run command',
    description: [
      'Execute a shell command in a real shell and return its combined stdout and stderr with the exit code.',
      'Treat it as the most dangerous tool available: nothing here asks for confirmation, so never reach for rm, git reset/checkout/clean, force push, a package publish, a deploy or a service restart as a shortcut around a blocker. Reaching it at all means an administrator granted this account the terminal plugin, so treat that trust accordingly.',
      'The working directory is confined to accessible repositories and persists between successful foreground calls in this session. Prefer absolute paths. Shell variables and functions do not persist.',
      'Prefer the dedicated file tools (Read, Edit, Write, Search, ListDir) over cat, head, tail, sed, awk, echo, grep or rg. A shell read does NOT satisfy Edit/Write\'s read-before-write check, so reading a file with cat just forces a second Read before you can edit it — Read it directly. Reach for the shell when the task genuinely needs it: builds, tests, git, service inspection, process management.',
      'Quote paths that contain spaces. Write and Edit create a file\'s missing parent directories themselves, so mkdir -p is only needed for a directory that stays empty.',
      'Running multiple commands: if the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel. If the commands depend on each other and must run sequentially, use a single Bash call with \'&&\' to chain them together. Use \';\' only when you need to run commands sequentially but don\'t care if earlier commands fail. DO NOT use newlines to separate commands (newlines are ok in quoted strings).',
      `\`timeout\` is milliseconds, defaults to ${DEFAULT_TIMEOUT_MS} (${durationLabel(DEFAULT_TIMEOUT_MS)}), and may not exceed ${MAX_TIMEOUT_MS} (${durationLabel(MAX_TIMEOUT_MS)}).`,
      `A foreground command waits for its own \`timeout\` and no less — pass a longer \`timeout\` when you expect the command to take longer, and run_in_background=true for work you do not want to wait for at all. At that deadline the run is normally MOVED to the background instead of being killed: the result then reports a process id, and ProcessOutput(id) waits for the rest, so its output is never thrown away. It is not moved when the user approved it at a permission prompt, when this conversation's background slots are full, or when the turn is not an interactive chat of its own (a sub-agent or workflow node, whose caller needs the output rather than a process id) — then the deadline kills the command and the result says so.`,
      'The user can also move a waiting command to the background at any time with Ctrl+B, which settles the call with a process id while the command keeps running.',
      `Do not send a bare \`sleep N\` (N >= ${MIN_BLOCKED_SLEEP_S}) as the whole command to wait for something — that is refused. Start the work with run_in_background=true and wait for it with ProcessOutput(id).`,
      'Pass run_in_background=true for detached work. Manage detached work with ListProcesses, ProcessOutput, and KillProcess. backgroundMode="service" marks a long-lived server or watcher.',
      'description is the live display context for the command. dangerouslyDisableSandbox=false is a no-op; true is always refused before any process is spawned.',
      `Inline output is capped at ~${Math.round(outputCap / 1000)} kB: past that the result carries the BEGINNING and the END, and the retained output is saved to a file the result names when one could be written — read it with the Read tool (offset/limit) rather than re-running the command. For a run far larger than the cap, redirect it to a file of your own and grep that instead.`,
      'A denied or blocked command means a permission rule stopped it — adjust the approach, do not retry it verbatim. Keep secrets out of command lines and output.',
    ].join(' '),
    parameters: Type.Object({
      command: Type.String({ description: 'The command to execute' }),
      timeout: Type.Optional(Type.Number({
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, i.e. ${durationLabel(DEFAULT_TIMEOUT_MS)}; max ${MAX_TIMEOUT_MS}, i.e. ${durationLabel(MAX_TIMEOUT_MS)}). This is how long the call waits in the foreground; in an interactive chat the run is then normally moved to the background rather than killed, and continues with no time limit.`,
      })),
      description: Type.Optional(Type.String({ description: 'Clear, concise active-voice description of what the command does. Use 5-10 words for simple commands; add enough context for piped commands or obscure flags. Describe the action directly without labels such as "complex" or "risky".' })),
      run_in_background: Type.Optional(Type.Boolean({ description: 'Run the command in the background. You get a process id back and are notified when it completes — never poll. ProcessOutput(id) waits for it when you need the result now.' })),
      dangerouslyDisableSandbox: Type.Optional(Type.Boolean({ description: 'Sandbox bypass request; true is always refused by Elowen' })),
      cwd: Type.Optional(Type.String({ description: 'Elowen extension: working directory within accessible repositories' })),
      backgroundMode: Type.Optional(Type.Union([Type.Literal('job'), Type.Literal('service')], {
        description: 'Elowen extension: job waits for collection; service is a long-lived server or watcher',
      })),
    }, { additionalProperties: false }),
    execute: async (toolCallId, p, _signal, onUpdate) => {
      try {
        if (p.dangerouslyDisableSandbox === true) {
          return ok('Error: sandbox bypass was refused before spawning the command. dangerouslyDisableSandbox=true is not supported.');
        }
        const background = resolveBackground(p);
        const timeoutMs = resolveTimeoutMs(p);
        // Read before anything awaits: it describes THIS call, and the answer must not depend on where in
        // the execution the question happens to be asked.
        const approvedByAsk = ctx.callApprovedByAsk();
        const interactiveConversation = AUTO_BACKGROUND_CONVERSATIONS.has(ctx.currentIdentity?.()?.conversation);
        if (isBlockingSelfRestart(p.command)) {
          return ok('Error: refused a blocking restart of elowen-daemon from inside its own service. Run `elowen restart all` as a standalone Bash call; verify health only after the recovered turn resumes. Do not retry the blocking command.');
        }
        // A bare `sleep N` in the FOREGROUND is a poll: it spends the turn waiting for something the
        // process tools can wait for properly. Background runs are untouched — see blockedSleepSeconds.
        const sleepSeconds = background ? null : blockedSleepSeconds(p.command);
        if (sleepSeconds !== null) {
          return ok(`Error: refused a bare sleep of ${durationLabel(sleepSeconds * 1000)} — a foreground sleep that does nothing else spends the turn waiting. `
            + 'To wait for work you started: run it with run_in_background=true and read it with ProcessOutput(id), which returns the moment it exits. '
            + 'To wait for something to become READY (a server accepting connections, a file appearing), put the retry inside the command — '
            + '`until curl -sf http://127.0.0.1:3000 >/dev/null; do sleep 1; done` is fine, and so is `sleep 19; tail /tmp/build.log`, because the command goes on to produce a result. '
            + `A deliberate pause shorter than ${MIN_BLOCKED_SLEEP_S}s is also still allowed.`);
        }
        const cwd = guardCwd(p.cwd);
        const sessionCwdKey = cwdStateKey();
        if (!background) {
          // Stream the rolling output tail live as it runs. `onUpdate` is PI's 4th execute argument (the
          // agent loop passes it, forwarded verbatim through the Elowen tool wrappers); each call emits a
          // `tool_execution_update` the daemon maps to a throttled `tool_progress` event. Absent for callers
          // that don't stream (background path never uses it — it has ProcessOutput instead).
          const onProgress = onUpdate ? (text) => onUpdate(ok(text)) : undefined;
          const id = newProcessId();
          const prepared = await prepareLaunch(cwdReportingCommand(p.command), cwd);
          const run = new ForegroundRun(id, p.command, cwd, outputCap, timeoutMs, prepared);
          // Register the run as `foreground` so Ctrl+B (which reads the live process list) can detach it,
          // and so a detach flips the SAME handle to `job` — an ordinary background process from then on,
          // with no further special-casing. A sessionless (worker/cron) run stays plain and non-detachable:
          // it has no conversation to background into.
          const fgSession = currentSessionId();
          const foregroundAccountUserId = currentAccountUserId();
          let handle = null;
          let foregroundEntry = null;
          if (fgSession) {
            handle = handleFor(id, run, foregroundAccountUserId, fgSession, 'foreground', run.workspaceId, run.homeGeneration);
            ctx.processes.register(handle);
            // The principal is the contribution account actually running the turn — a delegated child has
            // no account identity of its own but still belongs to its delegator.
            foregroundEntry = {
              run, sessionId: fgSession,
              accountUserId: foregroundAccountUserId,
              principal: foregroundAccountUserId !== null ? `elowen:${foregroundAccountUserId}` : null,
              releaseBackgroundSlot: null,
              // Why the run left the foreground, once it has: 'manual' (Ctrl+B) or 'deadline'. Only the
              // wording of the settled result reads it.
              detachReason: null,
            };
            foregroundRuns.set(id, foregroundEntry);
          }
          const execPromise = run.run(onProgress);
          const abortRun = () => { run.kill().catch((error) => ctx.logger.error(`terminal: abort failed: ${run.sanitizeOutput(error.message)}`)); };
          _signal?.addEventListener('abort', abortRun, { once: true });
          if (_signal?.aborted) abortRun();
          // A DETACHED run that later exits wakes the conversation to read its output — the exact lifecycle
          // Bash(run_in_background:true) gets via BgProcess.onClose. A foreground completion uses
          // remove() below instead, which never notifies.
          void execPromise.then(() => {
            if (!run.detached) return;
            emitProcCard(fgSession, foregroundAccountUserId);
            ctx.processes.markExited(id);
          });
          // THE DEADLINE. The run waits in the foreground for exactly as long as this call asked for.
          // When that deadline expires the caller wanted the command to FINISH, not to lose it — so the
          // run moves to the background, keeping its output and its process, instead of dying.
          //
          // Three runs are deliberately excluded. One the human just approved at an `ask` prompt: they
          // agreed to watch this command run, and turning it into a detached process behind them is a
          // different thing from what they said yes to (the timeout note below says so when it bites).
          // A sessionless worker/cron run, which has no conversation to background into — the same
          // condition that already makes Ctrl+B unavailable there. And any turn that is not an
          // interactive chat of its own: see AUTO_BACKGROUND_CONVERSATIONS.
          //
          // The hook only detaches: that resolves the race below and the detached branch redraws the
          // process card, exactly as it already does for Ctrl+B. The run's own timer owns the deadline, so
          // there is no second one to arm, clear or leak.
          //
          // The callback is the one place in this file that reaches the process registry from OUTSIDE the
          // tool call's try/catch, and an uncaught throw in a timer takes the daemon down. Failing to
          // detach leaves the deadline the plain kill it was before.
          if (foregroundEntry && !approvedByAsk && interactiveConversation) {
            run.onDeadline = () => {
              try { return detachRun(foregroundEntry, 'deadline'); }
              catch (error) {
                ctx.logger.warn(`terminal: auto-background failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
                return false;
              }
            };
          }
          try {
            await Promise.race([execPromise, run.detachedPromise]);
          } finally {
            _signal?.removeEventListener('abort', abortRun);
          }
          if (run.detached) {
            foregroundRuns.delete(id);
            try {
              if (handle) { handle.completionMode = 'job'; ctx.processes.register(handle); }
            } finally {
              foregroundEntry?.releaseBackgroundSlot?.();
            }
            emitProcCard(fgSession, foregroundAccountUserId);
            // Same first line either way, so the id is found in one place. A deadline detach adds why it
            // moved and how to get the rest — a blocking read is what the caller actually wanted here,
            // since they asked for that deadline in order to see the command through.
            const why = foregroundEntry?.detachReason === 'deadline'
              ? `\nIt reached its ${durationLabel(timeoutMs)} timeout, so it was moved here instead of being killed with its output thrown away.`
              : '';
            return ok(`Moved to background as process ${id}: ${run.command}\n(cwd: ${run.cwd})\nStill running with no time limit. You will be notified when it completes — do not poll. If you need its result now, ProcessOutput("${id}") waits for it.${why}`);
          }
          // Foreground completion: drop the registry entry WITHOUT a nudge, exactly as a non-backgrounded
          // command produced no lingering process before this change.
          foregroundRuns.delete(id);
          if (handle) ctx.processes.remove(id);
          if (run.spawnError) return ok(`Error: ${run.spawnError}`);
          let cwdWarning = '';
          if (run.exitCode === 0 && !run.killed && !run.timedOut && run.reportedCwd) {
            try {
              const persistedCwd = mapReportedCwd(
                run.reportedCwd,
                prepared,
                (candidate) => ctx.assertPathAllowed(candidate),
                ctx.currentAccess().workspaceRef !== undefined,
              );
              rememberCwd(sessionCwdKey, ctx.currentAccess().workspaceRef ? ctx.displayPath(persistedCwd) : persistedCwd);
            } catch (error) {
              cwdWarning = `[working directory was not persisted: ${ctx.sanitizePathOutput(error instanceof Error ? error.message : String(error))}]\n`;
            }
          }
          // Name the deadline that actually applied so the model knows whether to re-run with a longer
          // `timeout` or move to the background; a bare kill (registry/session delete) reads as `[killed]`.
          // An approved command is never auto-backgrounded, so when one times out the note says why it
          // was killed rather than moved — otherwise the model sees the same command
          // survive in one turn and die in the next with nothing to explain the difference.
          const heldForApproval = approvedByAsk
            ? '; a command you approved is never moved to the background on its own'
            : '';
          const note = cwdWarning + (run.timedOut
            ? `[killed: timed out after ${durationLabel(timeoutMs)}${heldForApproval}]\n`
            : run.exitCode === null ? '[killed]\n' : '');
          // The `[exit N]` marker inside the text is framing for the MODEL; the display path reads the
          // exit code structurally from details (tone + status chip), so report it there as well. A
          // killed run has no exit code (null) and its note already says why.
          // A truncated result stops being the only copy: the whole retained output goes to the host's
          // tool-result spill store and the banner names the file. Best effort — a store that has no
          // conversation to write into (worker/cron) returns null, and a failed write must cost the note,
          // never the command's result, so the run still reports what it did.
          const visible = run.sanitizeOutput(run.output);
          const persistFullOutput = async () => {
            try {
              const text = withDropNotice(run, visible);
              if (prepared.projectRef?.kind === 'managed') {
                const sandbox = ctx.control('sandbox');
                if (!sandbox) throw new Error('managed output export requires the Sandbox plugin');
                const path = `/tmp/elowen-output-${randomBytes(16).toString('hex')}.txt`;
                const result = await sandbox.projectFiles({
                  project: prepared.projectRef, accountUserId: foregroundAccountUserId,
                  operation: { kind: 'write', path, base64: Buffer.from(text, 'utf8').toString('base64'), expectedVersion: null },
                });
                if (result.kind !== 'write') throw new Error('managed output export returned an invalid result');
                return { path, bytes: Buffer.byteLength(text, 'utf8') };
              }
              return await ctx.persistToolOutput({ toolCallId, text });
            } catch (error) {
              ctx.logger.warn(`failed to persist the full output of ${id}`, error);
              return prepared.projectRef?.kind === 'managed'
                ? { error: truncateTailBytes(run.sanitizeOutput(error instanceof Error ? error.message : String(error)), 200) } : null;
            }
          };
          const res = ok(await formatRunResult(run.command, run.cwd, visible, run.exitCode, note, outputCap, run.dropped, persistFullOutput));
          if (typeof run.exitCode === 'number') res.details.exitCode = run.exitCode;
          return res;
        }
        const sessionId = currentSessionId();
        const accountUserId = currentAccountUserId();
        if (!sessionId) return ok('Error: background processes require an authenticated conversation.');
        const releaseSlot = reserveBackgroundSlot(sessionId, accountUserId);
        if (!releaseSlot) return ok(`Error: too many background processes (${maxBackgroundProcesses}); wait for one to exit, collect it, or kill it first.`);
        try {
          const id = newProcessId();
          // The operator who started it (+ the session they started it in) → wake THAT conversation when it
          // exits (markExited on close). Field is `elowenUserId` (was mis-typed as the pre-rebrand `orcaUserId`,
          // which is undefined → the wake never fired).
          const prepared = await prepareLaunch(p.command, cwd);
          let bg;
          try { bg = new BgProcess(id, p.command, cwd, outputCap, () => { emitProcCard(sessionId, accountUserId); ctx.processes.markExited(id); }, prepared); }
          catch (error) {
            try { await prepared.lease.release(); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Background launch cleanup failed'); }
            throw error;
          }
          ctx.processes.register(handleFor(id, bg, accountUserId, sessionId, p.backgroundMode === 'service' ? 'service' : 'job', bg.workspaceId, bg.homeGeneration));
          emitProcCard();
          return ok(`Started background process ${id}: ${bg.command}\n(cwd: ${bg.cwd})\nYou will be notified when it completes — do not poll. If you need its result now, ProcessOutput("${id}") waits for it.`);
        } finally {
          releaseSlot();
        }
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ListProcesses', label: 'List processes',
    description: [
      'List the background shell processes of THIS conversation — the ones started with Bash(run_in_background=true) or moved to the background with Ctrl+B — with each process id, whether it is still RUNNING or has exited (and with which code), when it started and the command line.',
      'Use it to recover a process id you no longer have, to check what is still running before starting another dev server or watcher, and before KillProcess so you kill the right one. It takes no arguments and cannot be pointed at another conversation or at arbitrary system processes: a command still running in the FOREGROUND is deliberately not listed, and neither is anything you did not start here.',
      'It reports state only — read a process\'s output with ProcessOutput and stop one with KillProcess. A background sub-agent is a different thing entirely (see DelegateList).',
    ].join(' '),
    parameters: Type.Object({}),
    execute: async () => {
      const sessionId = currentSessionId();
      // Exclude any of the caller's own in-flight foreground commands: this tool's contract is background
      // processes, and a parallel tool call could otherwise surface the command running alongside it.
      const own = sessionId
        ? ctx.processes.listForSessionAccount(sessionId, currentAccountUserId()).filter((proc) => proc.completionMode !== 'foreground')
        : [];
      if (own.length === 0) return ok('No background processes.');
      for (const process of own) await authorizeProcess(process);
      return ok(own.map((proc) =>
        `- ${proc.id} ${proc.running ? 'RUNNING' : `exited(${proc.exitCode})`} since ${proc.startedAt}\n  $ ${proc.command}`
      ).join('\n'));
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ProcessOutput', label: 'Read process output',
    description: [
      'Read the output (stdout + stderr) of a background process started with Bash(run_in_background=true).',
      `By default this WAITS for the process to finish: the call returns as soon as it exits, or after \`timeout\` seconds (default ${DEFAULT_BLOCK_S}, max ${MAX_BLOCK_S}) with the output so far and a note that it is still running — then simply call it again. Never poll in a loop with block=false.`,
      'Each call returns only what was written SINCE your last read; pass all=true for the whole retained buffer. For an explicit background process this is a byte-capped tail, and a loss notice says when earlier output was dropped.',
      'Pass block=false to peek at the output of a long-lived process (a server, a watcher) without waiting.',
      'The user can release a waiting read at any time with Ctrl+B: the call then returns the output so far marked `[still running — wait released by the user]`, the process keeps running, and you can read it again later.',
      'The process id comes from the Bash call that started it; use ListProcesses if you no longer have it. Only processes of THIS conversation are readable, and the buffer keeps the last part of the output — an extremely chatty process loses its earliest lines.',
      'Reading a process that has already exited returns its remaining output and then collects it, so that id stops working afterwards. This tool is only for shell processes — a background sub-agent result comes back through DelegateResult.',
    ].join(' '),
    parameters: Type.Object({
      id: Type.String({ description: 'Process id returned by Bash(run_in_background=true)' }),
      all: Type.Optional(Type.Boolean({ description: 'Return the whole buffer instead of just new output' })),
      block: Type.Optional(Type.Boolean({ description: 'Wait for the process to finish before returning (default true). false = return what is there right now.' })),
      timeout: Type.Optional(Type.Number({ description: `Seconds to wait for the exit (default ${DEFAULT_BLOCK_S}, max ${MAX_BLOCK_S}). Ignored with block=false.` })),
    }),
    execute: async (_id, p) => {
      const handle = await scopedHandle(p.id);
      if (!handle) return ok(`Error: no background process ${p.id}.`);
      // Waiting is the default: a model that gets "(no new output) [still running]" back instantly
      // calls again at once and burns a turn step per poll (seen in production after auto-background).
      // Parking here until the process exits (or the deadline passes) is what the caller wants for any
      // finite command; a long-lived process is peeked at with block=false. The wait is bounded and the
      // process survives a timeout, so a caller that still needs the result simply waits again. Waiting
      // on the ALREADY-SCOPED handle is what keeps this safe — an id from another session was rejected
      // above, so nobody can block on a conversation they can't read.
      let waitedOut = false;
      let released = false;
      if (p.block !== false && handle.running()) {
        const waitS = clampSeconds(p.timeout, DEFAULT_BLOCK_S, MIN_TIMEOUT_S, MAX_BLOCK_S);
        const key = `read-${blockedReadSeq += 1}`;
        const readerAccountUserId = currentAccountUserId();
        const releasedByUser = new Promise((resolve) => {
          blockedReads.set(key, {
            sessionId: handle.sessionId ?? null,
            principal: readerAccountUserId !== null ? `elowen:${readerAccountUserId}` : null,
            release: () => { released = true; resolve('released'); },
          });
        });
        // Flag the process while the read waits and re-register it. The registry change is the SAME seam
        // the process card and the clients already read, so both learn that something is waiting in the
        // foreground and offer their background control — without a second mechanism beside it.
        handle.blockedRead = true;
        ctx.processes.register(handle);
        try {
          waitedOut = await Promise.race([ctx.processes.waitForExit(p.id, waitS * 1000), releasedByUser]) === 'timeout';
        } finally {
          blockedReads.delete(key);
          handle.blockedRead = false;
          // Only if the handle is still registered: a process killed or collected while we waited has left
          // the registry, and re-registering it here would resurrect a corpse.
          if (ctx.processes.get(p.id)) ctx.processes.register(handle);
        }
      }
      // Sample `running` BEFORE reading: a process that exits between the read and the check would
      // otherwise be collected here while output written after our read is still lost. Reading first from a
      // handle we then keep (because it looked alive) at worst costs one more read call.
      await authorizeProcess(handle); // Membership may have changed while ProcessOutput was waiting.
      const running = handle.running();
      const text = handle.readNew(p.all === true);
      // A released wait says so instead of naming a deadline it never reached: the process keeps running
      // and the model can simply read it again later.
      const state = running
        ? released
          ? '[still running — wait released by the user]'
          : `[still running${waitedOut ? ` after waiting ${clampSeconds(p.timeout, DEFAULT_BLOCK_S, MIN_TIMEOUT_S, MAX_BLOCK_S)}s` : ''}]`
        : `[exited ${handle.exitCode()}]`;
      if (!running) { ctx.processes.remove(p.id); emitProcCard(); } // final read collects the corpse
      return ok(`${text || '(no new output)'}\n${state}`);
    },
  }));

  ctx.registerTool(defineTool({
    name: 'KillProcess', label: 'Kill process',
    description: [
      'Stop a background shell process of this conversation by id — a dev server, watcher or build you no longer need, or one that is stuck.',
      'The process id comes from the Bash(run_in_background=true) call that started it, or from ListProcesses when you no longer have it; only processes started in THIS conversation can be killed, and an unknown id is reported back as an error rather than killing anything.',
      'This is IRREVERSIBLE and abrupt: the shell and its tracked descendants are SIGKILLed immediately with no chance to shut down cleanly or flush. Direct Linux runs also track descendants that create a new session; direct-host backgrounding is refused on platforms where that cannot be guaranteed. A killed build or migration can leave partial state behind. Read what it has produced with ProcessOutput first if the output still matters, because the entry is dropped afterwards and its buffer is gone.',
      'Do not use it to work around a command that is merely slow (wait, or read it with ProcessOutput), and never to kill processes you did not start.',
    ].join(' '),
    parameters: Type.Object({
      id: Type.String({ description: 'Process id from Bash(run_in_background=true) or ListProcesses. The tracked process tree is SIGKILLed immediately and its output buffer is discarded.' }),
    }),
    execute: async (_id, p) => {
      const handle = await scopedHandle(p.id);
      if (!handle) return ok(`Error: no background process ${p.id}.`);
      await handle.kill();
      ctx.processes.remove(p.id); // remove only after verified cancellation succeeds
      emitProcCard();
      return ok(`Killed ${p.id} ($ ${handle.command}).`);
    },
  }));

  // Ctrl+B backgrounds a running foreground command: resolve its race (ForegroundRun.detach) so the tool
  // returns "moved to background" and the run becomes an ordinary job. Matches on the same principal +
  // session the plugin captured at spawn, mirroring the subagent plugin's control. Detaching is idempotent
  // and only touches still-foreground runs, so a double-fire can never double-count.
  ctx.registerControl('terminal', {
    detachForeground: ({ sessionId, principal }) => {
      let detached = 0;
      for (const entry of foregroundRuns.values()) {
        if (entry.sessionId !== sessionId || entry.principal !== principal) continue;
        if (detachRun(entry, 'manual')) detached += 1;
      }
      // A blocked `ProcessOutput` is the other way this plugin holds the turn. Releasing the wait settles
      // the tool with the output so far; the process is left alone, so this is only ever additive.
      for (const [key, read] of blockedReads) {
        if (read.sessionId !== sessionId || read.principal !== principal) continue;
        blockedReads.delete(key);
        read.release();
        detached += 1;
      }
      return { detached };
    },
    // The stop escalation (a further Esc / repeat Ctrl+C after the graceful interrupt): SIGKILL the
    // process group of every run still blocking this conversation's turn. The settled run reads as
    // [killed] (exitCode stays null) and the awaited Bash tool resolves — which is what lets the
    // already-aborted turn finally unwind.
    // Detached and background runs are exempt (they no longer block a turn), and an entry whose kill is
    // already in flight is skipped so a double-fire never double-counts.
    killForeground: ({ sessionId, principal }) => {
      let killed = 0;
      for (const entry of foregroundRuns.values()) {
        if (entry.run.detached || entry.run.killed) continue;
        if (entry.sessionId !== sessionId || entry.principal !== principal) continue;
        entry.run.kill().catch((error) => ctx.logger.error(`terminal: foreground cancellation failed: ${entry.run.sanitizeOutput(error.message)}`));
        killed += 1;
      }
      return { killed };
    },
  });

  ctx.logger.info('registered Bash (+background), list/read/kill process tools');
}
