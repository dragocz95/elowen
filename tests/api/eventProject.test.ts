import { describe, it, expect } from 'vitest';
import { eventProjectId } from '../../src/api/eventProject.js';

describe('eventProjectId', () => {
  it('uses the project explicitly stamped by a plugin publisher', () => {
    expect(eventProjectId({ type: 'plugin', plugin: 'demo', kind: 'changed', projectId: 7, data: null })).toBe(7);
    expect(eventProjectId({ type: 'plugin', plugin: 'demo', kind: 'global', projectId: null, data: null })).toBeNull();
  });

  it('keeps core instance and user events outside project tenancy', () => {
    expect(eventProjectId({ type: 'plugins' })).toBeNull();
    expect(eventProjectId({ type: 'memory', userId: 2 })).toBeNull();
    expect(eventProjectId({ type: 'auth', kind: 'sso.login', subject: 's', detail: 'linked' })).toBeNull();
  });
});
