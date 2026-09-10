import type { EnvironmentAction, EnvironmentOperation } from '../../../src/plugins/environmentTypes';
import { jsonBody, localizedError, runtime } from './runtime';

interface PendingRequest { requestId: string; fingerprint: string; expectedGeneration: number }
const key = (accountId: number, projectId: number) => `elowen.environment-request:${accountId}:${projectId}`;

function read(accountId: number, projectId: number): PendingRequest | null {
  const raw = localStorage.getItem(key(accountId, projectId));
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('request_state_invalid'); }
  // The id stored here is the one this code minted, replayed as it stands: which keys the runtime ACCEPTS
  // is its rule, stated once on the server, and a key it refuses comes back as a definitive 400 that
  // clears the entry. The pattern that used to sit here was narrower than the server's, so the two ends
  // disagreed about which keys exist. The rest of the shape is still checked as it is read.
  if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string'
    || value.requestId.length === 0 || !('fingerprint' in value) || typeof value.fingerprint !== 'string'
    || !('expectedGeneration' in value) || !Number.isSafeInteger(value.expectedGeneration) || Number(value.expectedGeneration) < 0) throw new Error('request_state_invalid');
  return value as PendingRequest;
}

/** Keep identity across remounts and lost responses, with the latest observed generation as a
 * precondition. Never overwrite an unacknowledged intent. Storage failure refuses dispatch. */
export function environmentRequest(accountId: number, projectId: number, fingerprint: string, generation: number): Pick<PendingRequest, 'requestId' | 'expectedGeneration'> {
  const pending = read(accountId, projectId);
  if (pending) {
    if (pending.fingerprint !== fingerprint) throw new Error('request_unresolved');
    if (pending.expectedGeneration !== generation) localStorage.setItem(key(accountId, projectId), JSON.stringify({ ...pending, expectedGeneration: generation }));
    return { requestId: pending.requestId, expectedGeneration: generation };
  }
  const next = { requestId: crypto.randomUUID(), fingerprint, expectedGeneration: generation };
  localStorage.setItem(key(accountId, projectId), JSON.stringify(next));
  return { requestId: next.requestId, expectedGeneration: next.expectedGeneration };
}

/** A response or the authoritative operation list acknowledges receipt, not successful completion. */
export function acknowledgeEnvironmentRequest(accountId: number, projectId: number, requestIds: string[]): void {
  const pending = read(accountId, projectId);
  if (pending && requestIds.includes(pending.requestId)) localStorage.removeItem(key(accountId, projectId));
}

/** A definitive refusal never accepted the intent, so its idempotency key must not outlive it and block
 * the next attempt. Any other outcome — including one nobody heard — keeps the key, which is what makes
 * a retry return the same operation instead of queueing a second one. */
const DEFINITIVE_REFUSALS = [400, 401, 403, 404, 422];

/** Ask for one environment lifecycle action, under the persisted request identity.
 *
 * The one dispatch both surfaces use: the project register's row menu and the environment drawer. They
 * used to repeat this — request identity, POST, acknowledgement, refusal handling — and had already
 * drifted on what happens when it is refused. The error arrives localized because both call sites show
 * it: in the confirmation that raised the action, or in a toast when no dialog is on screen. */
export async function dispatchEnvironmentAction(input: {
  accountId: number;
  projectId: number;
  action: EnvironmentAction;
  generation: number;
  strings: Record<string, string>;
}): Promise<EnvironmentOperation & { requestId: string }> {
  const { accountId, projectId, action, generation, strings } = input;
  const request = environmentRequest(accountId, projectId, JSON.stringify(action), generation);
  try {
    const operation = await runtime().api(`/plugins/sandbox/api/projects/${projectId}/environment`, jsonBody({ action, ...request })) as EnvironmentOperation & { requestId: string };
    acknowledgeEnvironmentRequest(accountId, projectId, [operation.requestId]);
    return operation;
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    if (DEFINITIVE_REFUSALS.includes(status)) acknowledgeEnvironmentRequest(accountId, projectId, [request.requestId]);
    throw new Error(localizedError(error, strings));
  }
}
