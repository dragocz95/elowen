import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/daemon/bootstrap.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

describe('buildApp', () => {
  it('wires a healthy app with an injected tmux fake', async () => {
    const { app } = buildApp({ dbPath: ':memory:', tmux: new FakeTmuxDriver(), project: { id: 1, slug: 'orca', path: '/o' }, relay: null });
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/sessions')).status).toBe(200);
  });
});
