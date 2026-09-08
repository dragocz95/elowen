interface PendingRequest { requestId: string; fingerprint: string; expectedGeneration: number }
const key = (accountId: number, projectId: number) => `elowen.environment-request:${accountId}:${projectId}`;

function read(accountId: number, projectId: number): PendingRequest | null {
  const raw = localStorage.getItem(key(accountId, projectId));
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('request_state_invalid'); }
  if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId) || !('fingerprint' in value) || typeof value.fingerprint !== 'string'
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
