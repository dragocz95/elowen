import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ManagedProjectRef, SandboxControl, SandboxExecutionCommand } from '../plugins/api.js';

const exec = promisify(execFile);

/** Execute a trusted integration's command through Sandbox, with explicit request identity and bounded IO. */
export async function runManagedProjectCommand(
  sandbox: SandboxControl,
  projectRef: ManagedProjectRef,
  accountUserId: number,
  command: SandboxExecutionCommand,
  options: { cwd?: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  const prepared = await sandbox.prepareExecution({ projectRef, command, cwd: options.cwd ?? '/workspace', leaseKind: 'files' },
    { accountUserId, roots: ['/workspace'] });
  // Runtime validation remains necessary: a partially loaded provider must not become host execution.
  const cancellation = 'cancel' in prepared ? prepared.cancel : undefined;
  const input = 'stdin' in prepared ? prepared.stdin : undefined;
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let failure: unknown;
  try {
    if (prepared.mode !== 'managed' || prepared.projectRef?.kind !== 'managed' || prepared.projectRef.projectId !== projectRef.projectId) {
      throw new Error('managed project provider returned a different execution target');
    }
    if (typeof cancellation !== 'function') throw new Error('managed execution requires verified guest cancellation');
    if (input !== undefined && ((typeof input !== 'string' && !Buffer.isBuffer(input)) || Buffer.byteLength(input) > 1024 * 1024)) {
      throw new Error('invalid or oversized prepared stdin');
    }
    heartbeat = setInterval(() => {
      Promise.resolve().then(() => prepared.lease.heartbeat()).catch((error: unknown) => { failure = error; controller.abort(); });
    }, 5000);
    heartbeat.unref();
    const launch = prepared.launch;
    const runOptions = { cwd: prepared.cwd, env: launch.env, encoding: 'utf8' as const,
      timeout: options.timeout ?? 10_000, maxBuffer: options.maxBuffer ?? 1024 * 1024,
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal };
    const pending = launch.type === 'argv' ? exec(launch.file, launch.args, runOptions)
      : exec('/bin/sh', ['-c', launch.command], runOptions);
    pending.child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') { failure = error; controller.abort(); }
    });
    pending.child.stdin?.end(input);
    const result = await pending;
    return { stdout: prepared.sanitizeOutput(result.stdout), stderr: prepared.sanitizeOutput(result.stderr) };
  } catch (error) {
    failure ??= error;
    if (typeof cancellation === 'function') {
      try { await cancellation(); }
      catch (cleanup) { failure = new AggregateError([failure, cleanup], 'Managed command cancellation failed'); }
    }
    throw failure;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try { await prepared.lease.release(); }
    catch (cleanup) { throw new AggregateError([...(failure ? [failure] : []), cleanup], 'Managed command cleanup failed'); }
  }
}
