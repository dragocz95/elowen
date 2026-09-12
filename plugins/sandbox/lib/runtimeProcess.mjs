import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

/** Host process transport for the machine runtime: how a control tool or the privileged helper is
 *  launched, what environment it is given, and the bounds its input and output are held to.
 *
 *  This lived in `podman.mjs` for as long as Podman was the only runtime, and the nspawn client imported
 *  it from there. None of it is about containers: it is a bounded launcher for trusted host executables.
 *  It sits in its own module so the runtime does not import its transport from a sibling runtime — and so
 *  deleting one runtime does not take the launcher with it. */

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const INPUT_LIMIT = 1024 * 1024;
export const OUTPUT_LIMIT = 256 * 1024;

export function positive(value, max, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name} bound`);
  return value;
}

export function validateInput(input) {
  if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) throw new Error('Invalid command input');
  if (input !== undefined && Buffer.byteLength(input) > INPUT_LIMIT) throw new Error('Command input exceeds limit');
}

/** The environment every runtime process is given: the service account's own identity and a fixed PATH,
 *  never the daemon's inherited environment. The daemon carries provider credentials, GitHub tokens and
 *  whatever else its unit was started with, and none of it belongs on the command line of a host tool. */
export function serviceProcessEnv(input = {}) {
  const service = userInfo();
  const uid = input.uid ?? process.getuid?.() ?? service.uid;
  const user = input.user ?? service.username;
  return {
    HOME: input.home ?? service.homedir, USER: user, LOGNAME: user, PATH: SYSTEM_PATH,
    XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

/** Only trusted module code chooses the host executable. Never expose this executor as a plugin control. */
export class SpawnExecutor {
  async run(file, args, options) {
    validateInput(options.input);
    positive(options.timeoutMs, 15 * 60_000, 'timeout');
    positive(options.outputLimitBytes, 16 * 1024 * 1024, 'output');
    options.signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { env: options.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      let truncated = false;
      let failure;
      let killTimer;
      const signal = (name) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, name); }
        catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
      };
      const terminate = (error) => {
        failure ??= error;
        signal('SIGTERM');
        killTimer ??= setTimeout(() => signal('SIGKILL'), 250);
      };
      const onAbort = () => terminate(new Error('Runtime command aborted'));
      const timer = setTimeout(() => terminate(new Error(`Runtime command timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // Abort can land between the initial check and listener registration.
      if (options.signal?.aborted) onAbort();
      // A long build is the one command whose output matters BEFORE it finishes, so `onOutput` sees each
      // complete line as it is written. The buffers below are untouched by it: the returned result is
      // still the bounded capture every other caller reads, and a throwing observer must not take the
      // command down with it.
      const partial = { stdout: '', stderr: '' };
      const observe = (stream, chunk) => {
        if (!options.onOutput) return;
        const text = partial[stream] + chunk.toString('utf8');
        const lines = text.split(/\r?\n|\r/);
        partial[stream] = lines.pop() ?? '';
        for (const line of lines) { if (line.trim()) { try { options.onOutput(line); } catch { /* an observer never fails the command */ } } }
      };
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
        const combined = Buffer.concat([buffers[stream], chunk]);
        if (combined.length > options.outputLimitBytes) truncated = true;
        buffers[stream] = combined.subarray(Math.max(0, combined.length - options.outputLimitBytes));
        observe(stream, chunk);
      });
      child.once('error', (error) => { failure ??= error; });
      child.stdin.on('error', (error) => {
        // A command may exit without consuming stdin; its exit code still decides success.
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') terminate(error);
      });
      child.once('close', (code) => {
        // The launcher may exit before descendants that ignored TERM and closed their stdio.
        if (failure) signal('SIGKILL');
        clearTimeout(timer);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else resolve({ code: code ?? 1, stdout: buffers.stdout.toString('utf8'), stderr: buffers.stderr.toString('utf8'), truncated });
      });
      child.stdin.end(options.input);
    });
  }
}
