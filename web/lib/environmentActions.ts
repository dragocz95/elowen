'use client';
import type { EnvironmentAction, EnvironmentOperation } from '../../src/shared/wireContract';
import { BASE, ElowenApiError } from './elowenClient';

/** Ask the sandbox plugin for one environment lifecycle operation and get the durable row back.
 *
 *  `requestId` is the plugin's idempotency key: repeating a request under the same key returns the SAME
 *  operation instead of queueing a second one, which is what makes a retry after a lost response safe.
 *  Core surfaces reach the plugin's own route here rather than growing a core mirror of it, so the
 *  request the picker sends and the request the environment screen sends are one contract. */
export async function requestEnvironmentAction(
  projectId: number,
  action: EnvironmentAction,
  requestId?: string,
): Promise<EnvironmentOperation> {
  const response = await fetch(`${BASE}/plugins/sandbox/api/projects/${projectId}/environment`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...(requestId === undefined ? {} : { requestId }) }),
  });
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) {
    throw new ElowenApiError(`environment ${action.kind} refused (${response.status})`, response.status,
      typeof body?.error === 'string' ? body.error : undefined, body);
  }
  return body as unknown as EnvironmentOperation;
}

/** Whether a failed operation is the stale-container case the explicit recreate exists to repair. The
 *  daemon names it in the operation's own error, so no surface has to infer it from a state word. */
export function recreatable(operation: { error: string | null } | null | undefined): boolean {
  return /predates the named project mount/i.test(operation?.error ?? '');
}
