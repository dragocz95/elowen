import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeEnvironmentRequest, environmentRequest } from '../../../plugins/sandbox/web-src/environmentRequest';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
const action = JSON.stringify({ kind: 'restore', snapshotId: 'snapshot-1' });

describe('durable environment request identity', () => {
  it('reuses request identity while checking the latest explicitly observed generation', () => {
    const first = environmentRequest(2, 7, action, 3);
    expect(first.requestId).toMatch(/^[a-f0-9-]+$/);
    expect(environmentRequest(2, 7, action, 4)).toEqual({ requestId: first.requestId, expectedGeneration: 4 });
  });

  it('isolates persisted intent by account and project', () => {
    const first = environmentRequest(2, 7, action, 3);
    expect(environmentRequest(3, 7, action, 3).requestId).not.toBe(first.requestId);
    expect(environmentRequest(2, 8, action, 3).requestId).not.toBe(first.requestId);
  });

  it('does not overwrite an unresolved intent with another action', () => {
    const first = environmentRequest(2, 7, action, 3);
    expect(() => environmentRequest(2, 7, JSON.stringify({ kind: 'delete' }), 3)).toThrow('request_unresolved');
    expect(environmentRequest(2, 7, action, 3)).toEqual(first);
  });

  it('only retires an intent when its exact request ID is acknowledged', () => {
    const first = environmentRequest(2, 7, action, 3);
    acknowledgeEnvironmentRequest(2, 7, ['unrelated']);
    expect(environmentRequest(2, 7, action, 3)).toEqual(first);
    acknowledgeEnvironmentRequest(2, 7, [first.requestId]);
    expect(environmentRequest(2, 7, action, 3).requestId).not.toBe(first.requestId);
  });

  it('refuses malformed saved state instead of silently issuing another operation', () => {
    localStorage.setItem('elowen.environment-request:2:7', '{');
    expect(() => environmentRequest(2, 7, action, 3)).toThrow('request_state_invalid');
  });

  it('fails before dispatch when the browser cannot persist request identity', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    expect(() => environmentRequest(2, 7, action, 3)).toThrow('Storage unavailable');
    expect(localStorage.getItem('elowen.environment-request:2:7')).toBeNull();
  });
});
