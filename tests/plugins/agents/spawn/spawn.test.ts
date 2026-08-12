import { describe, it, expect } from 'vitest';
import { SpawnService } from '../../../../plugins/agents/src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../../../src/tmux/fakeDriver.js';
import { AgentStore } from '../../../../plugins/agents/src/store/agentStore.js';
import { render } from '../../../../src/prompts/index.js';
import { openAgentsDb } from '../../../helpers/agentsDb.js';

// The plugin SpawnService REQUIRES the host prompt seam (no file-render fallback). The core file
// renderer stands in — the exact default the pre-extraction core service used.
const prompts = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };

describe('SpawnService', () => {
  it('registers the agent and spawns an elowen- session', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    const svc = new SpawnService({ tmux, agents, prompts });
    const { session } = await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'SwiftLake', spec: { program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' } });
    expect(session).toBe('elowen-SwiftLake');
    expect(await tmux.list()).toContain('elowen-SwiftLake');
    expect(agents.programFor('SwiftLake')).toBe('opencode');
  });

  it('delivers ELOWEN_URL/TOKEN/TASK as tmux session env, never as an `export` in the pane command', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    const svc = new SpawnService({ tmux, agents, prompts, elowen: { cli: 'elowen', url: 'http://localhost:4400', token: 's3cr3t-tok' } });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-7', agentName: 'Nova', spec: { program: 'opencode', model: 'm' } });
    // Env reaches the process out-of-band (tmux -e), so the worker can run `elowen ask`/`close`…
    expect(tmux.spawnEnvFor('elowen-Nova')).toMatchObject({ ELOWEN_URL: 'http://localhost:4400', ELOWEN_TOKEN: 's3cr3t-tok', ELOWEN_TASK: 'elowen-7' });
    // …but the token (and any env) is NEVER typed into the pane, where capturePane could surface it (N1).
    expect(tmux.commandFor('elowen-Nova')).not.toContain('export ELOWEN_');
    expect(tmux.commandFor('elowen-Nova')).not.toContain('s3cr3t-tok');
  });

  it('hands a worker the token minted for ITS task, and a reasoning agent the shared one', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    // Only real task ids bind; an overseer/pilot id has no task row, so the resolver returns undefined.
    const tokenForTask = (taskId: string) => taskId === 'elowen-7' ? 'tok-for-7' : undefined;
    const svc = new SpawnService({ tmux, agents, prompts, elowen: { cli: 'elowen', url: 'http://x', token: 'shared-tok', tokenForTask } });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-7', agentName: 'Nova', spec: { program: 'opencode', model: 'm' } });
    expect(tmux.spawnEnvFor('elowen-Nova')?.ELOWEN_TOKEN).toBe('tok-for-7');
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'overseer-m1', agentName: 'overseer-m1', spec: { program: 'claude-code', model: 'opus' }, rawPrompt: 'WATCH' });
    expect(tmux.spawnEnvFor('elowen-overseer-m1')?.ELOWEN_TOKEN).toBe('shared-tok');
  });

  it('merges caller extraEnv into the tmux session env (reasoning agents: ELOWEN_PLAN_JOB etc.)', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    const svc = new SpawnService({ tmux, agents, prompts, elowen: { cli: 'elowen', url: 'http://x', token: 'tok' } });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'pj-1', agentName: 'Pilot', spec: { program: 'claude-code', model: 'opus' }, rawPrompt: 'PLAN', extraEnv: { ELOWEN_PLAN_JOB: 'pj-1' } });
    expect(tmux.spawnEnvFor('elowen-Pilot')?.ELOWEN_PLAN_JOB).toBe('pj-1');
  });

  it('scrubs the token from a tmux spawn failure and re-throws a sanitized error', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    tmux.failSpawn = true; // a real tmux failure embeds `-e ELOWEN_TOKEN=<token>` in its error message
    const svc = new SpawnService({ tmux, agents, prompts, elowen: { cli: 'elowen', url: 'http://x', token: 'sup3r-s3cret' } });
    await expect(svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'opencode', model: 'm' } }))
      .rejects.toThrow(/agent spawn failed/);
    await expect(svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'opencode', model: 'm' } }))
      .rejects.not.toThrow(/sup3r-s3cret/); // the raw token never rides out in the thrown error
  });

  it('applies the provider resolver binary + args to the spawned command', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    const svc = new SpawnService({ tmux, agents, prompts, providers: (program) => program === 'opencode' ? { bin: '/usr/bin/oc', args: '--pure' } : undefined });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'opencode', model: 'm' } });
    expect(tmux.commandFor('elowen-Nova')).toContain("/usr/bin/oc --model 'm' --pure --prompt");
  });

  it('resumes the prior session when its program matches the spawn', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    const svc = new SpawnService({ tmux, agents, prompts });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'claude-code', model: 'sonnet' }, resume: { program: 'claude-code', sessionId: 'sess-7' } });
    expect(tmux.commandFor('elowen-Nova')).toContain("--resume 'sess-7'");
  });

  it('ignores a resume whose program no longer matches the task exec (cold start)', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    const svc = new SpawnService({ tmux, agents, prompts });
    // recorded a claude session, but the operator switched the task's exec to codex since
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'codex', model: 'gpt-5.5' }, resume: { program: 'claude-code', sessionId: 'sess-7' } });
    expect(tmux.commandFor('elowen-Nova')).not.toContain('resume');
  });

  it('ignores resume when the provider has it disabled', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db); const tmux = new FakeTmuxDriver();
    const svc = new SpawnService({ tmux, agents, prompts, providers: () => ({ resume: false }) });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'claude-code', model: 'sonnet' }, resume: { program: 'claude-code', sessionId: 'sess-7' } });
    expect(tmux.commandFor('elowen-Nova')).not.toContain('--resume');
  });
});

describe('SpawnService elowen seam', () => {
  const mk = () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    return { agents: new AgentStore(db), tmux: new FakeTmuxDriver() };
  };

  it('routes program elowen to the brain worker — tmux never spawns', async () => {
    const { agents, tmux } = mk();
    const launched: unknown[] = [];
    const svc = new SpawnService({ tmux, agents, prompts, brainWorker: { launch: async (i) => { launched.push(i); return { session: `elowen-${i.agentName}` }; } } });
    const res = await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'T-1', agentName: 'a9', spec: { program: 'elowen', model: 'relay/kimi' } });
    expect(res.session).toBe('elowen-a9');
    expect(launched).toHaveLength(1);
    expect(await tmux.list()).toEqual([]);
    expect(agents.programFor('a9')).toBe('elowen');
  });

  it('throws clearly when no brain worker is wired or a rawPrompt caller asks for elowen', async () => {
    const { agents, tmux } = mk();
    await expect(new SpawnService({ tmux, agents, prompts }).launch({ projectId: 1, projectPath: '/o', taskId: 't', agentName: 'a', spec: { program: 'elowen', model: 'm' } }))
      .rejects.toThrow(/not available/);
    const withWorker = new SpawnService({ tmux, agents, prompts, brainWorker: { launch: async () => ({ session: 's' }) } });
    await expect(withWorker.launch({ projectId: 1, projectPath: '/o', taskId: 't', agentName: 'a', spec: { program: 'elowen', model: 'm' }, rawPrompt: 'PILOT' }))
      .rejects.toThrow(/raw prompt/i);
  });

  it('resolves the global tddMode() resolver into a CLI worker preamble', async () => {
    const { agents, tmux } = mk();
    const svc = new SpawnService({ tmux, agents, prompts, tddMode: () => true });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'claude-code', model: 'sonnet' } });
    expect(tmux.commandFor('elowen-Nova')).toContain('Test-Driven Development');
  });

  it('omits the TDD directive when the resolver returns false (default)', async () => {
    const { agents, tmux } = mk();
    const svc = new SpawnService({ tmux, agents, prompts, tddMode: () => false });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'claude-code', model: 'sonnet' } });
    expect(tmux.commandFor('elowen-Nova')).not.toContain('Test-Driven Development');
  });

  it('threads the resolved tddMode into the brain worker launch input for an elowen: spec', async () => {
    const { agents, tmux } = mk();
    const launched: { tddMode?: boolean }[] = [];
    const svc = new SpawnService({ tmux, agents, prompts, tddMode: () => true, brainWorker: { launch: async (i) => { launched.push(i); return { session: `elowen-${i.agentName}` }; } } });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'T-1', agentName: 'a9', spec: { program: 'elowen', model: 'relay/kimi' } });
    expect(launched[0].tddMode).toBe(true);
  });

  it('lets an explicit per-call tddMode override the global resolver', async () => {
    const { agents, tmux } = mk();
    const svc = new SpawnService({ tmux, agents, prompts, tddMode: () => false });
    await svc.launch({ projectId: 1, projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', spec: { program: 'claude-code', model: 'sonnet' }, tddMode: true });
    expect(tmux.commandFor('elowen-Nova')).toContain('Test-Driven Development');
  });
});
