import { describe, it, expect, vi, beforeEach } from 'vitest';

const detectGithubAuth = vi.hoisted(() => vi.fn());
vi.mock('../../src/integrations/github/auth.js', () => ({ detectGithubAuth }));

import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';

function makeApp(ghToken?: string) {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const config = new ConfigStore(db);
  if (ghToken) config.update({ autopilot: { ghToken } });
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, projects: new ProjectStore(db), git: null as any,
  });
  return { app };
}

describe('GET /integrations/github-status', () => {
  beforeEach(() => detectGithubAuth.mockReset());

  it('passes tokenSet=false when no token is configured and returns the probe result', async () => {
    detectGithubAuth.mockReturnValue({ ghInstalled: true, ghAuthenticated: true, account: 'octocat', tokenSet: false, ready: true, method: 'gh' });
    const { app } = makeApp();
    const res = await app.request('/integrations/github-status');
    expect(res.status).toBe(200);
    expect(detectGithubAuth).toHaveBeenCalledWith(false);
    expect(await res.json()).toMatchObject({ ready: true, method: 'gh', account: 'octocat' });
  });

  it('passes tokenSet=true when a token is configured and never leaks the token value', async () => {
    detectGithubAuth.mockReturnValue({ ghInstalled: false, ghAuthenticated: false, account: null, tokenSet: true, ready: true, method: 'token' });
    const { app } = makeApp('ghp_supersecret');
    const res = await app.request('/integrations/github-status');
    expect(detectGithubAuth).toHaveBeenCalledWith(true);
    const body = await res.json();
    expect(body).toMatchObject({ tokenSet: true, method: 'token' });
    expect(JSON.stringify(body)).not.toContain('ghp_supersecret');
  });
});
