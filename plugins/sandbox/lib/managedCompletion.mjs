/** Canonical managed-execution completion cwd metadata.
 *
 * Guest fd3 cwd traps do not survive the podman/systemd transport, so the final physical working
 * directory of a canonical prepared user shell is captured by the guest shell itself: an EXIT-trap
 * prelude, prepended to the user's script on the same stdin, writes `pwd -P` into a dedicated
 * execution-owned guest artifact. Nothing here parses user stdout/stderr — the artifact is a
 * separate bounded file addressed by the host-generated execution ID and read back through the
 * same immutable container after the guest process has exited and before the lease is released.
 * A user `exec` replacing the shell, or `trap - EXIT` removing the capture, simply leaves no
 * artifact: callers must report an explicit null rather than pretend the cwd is known. */

const COMPLETION_ROOT = '/run/elowen-meta';
const EXECUTION_ID = /^[a-f0-9]{32}$/;
/** The artifact holds one absolute path; PATH_MAX is a generous upper bound. */
export const COMPLETION_CWD_LIMIT = 4096;

export function completionArtifact(executionId) {
  if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) throw new Error('Invalid host execution ID');
  return `${COMPLETION_ROOT}/${executionId}.cwd`;
}

/** Shell prelude prepended to the managed user script on stdin. It consumes no user stdin, changes
 * neither the user's stdout/stderr nor the exit status, and its own failure only means that no
 * artifact is written (reported as null later), never an execution failure. */
export function completionPrelude(executionId) {
  const artifact = completionArtifact(executionId);
  return `mkdir -p ${COMPLETION_ROOT} 2>/dev/null || true\ntrap "pwd -P > '${artifact}' 2>/dev/null" EXIT\n`;
}

/** Validates a read-back artifact body. Returns the absolute physical cwd, or null when the content
 * is absent, oversized, not a single absolute path, or otherwise unusable. Deliberately rejects
 * JSON-looking or multi-line content instead of trusting it. */
export function parseCompletionCwd(stdout, { truncated = false } = {}) {
  if (truncated || typeof stdout !== 'string' || !stdout.endsWith('\n')) return null;
  const cwd = stdout.slice(0, -1);
  if (cwd.length < 1 || cwd.length > COMPLETION_CWD_LIMIT || !cwd.startsWith('/') || /[\0-\x1f\x7f]/.test(cwd)) return null;
  return cwd;
}