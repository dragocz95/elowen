import { describe, it, expect, vi } from 'vitest';
import { Deriver } from '../../../../plugins/agents/src/deriver/deriver.js';
import { FakeTmuxDriver } from '../../../../src/tmux/fakeDriver.js';
import { TaskStore } from '../../../../plugins/work/src/store/taskStore.js';
import { AgentStore } from '../../../../plugins/agents/src/store/agentStore.js';
import { openAgentsDb } from '../../../helpers/agentsDb.js';

const OC_DIALOG = `△ Permission required\n Allow once   Allow always   Reject  ⇆ select  enter confirm`;

function setup(autonomy: string | null = null, decideApproval?: DeriverDecider, missionFor?: (session: string) => string | null) {
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); const agents = new AgentStore(db);
  tasks.create({ id: 'elowen-1', project_id: 1, title: 'T' }); tasks.setStatus('elowen-1', 'in_progress');
  agents.upsert({ project_id: 1, name: 'TestAgent', program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' });
  const tmux = new FakeTmuxDriver(); tmux.setPane('elowen-TestAgent', OC_DIALOG);
  const emitted: { s: string; sig: { type: string } }[] = [];
  const deriver = new Deriver({
    tmux, agents, tasks,
    sink: { emit: (s, sig) => emitted.push({ s, sig }) },
    sessionTaskId: () => 'elowen-1',
    autonomyFor: () => autonomy,
    missionFor,
    decideApproval,
  });
  return { tmux, deriver, emitted };
}
type DeriverDecider = (input: { question: string; context: string; options: { id: string; label: string }[]; autonomy: string; missionId: string | null; taskId: string }) => Promise<{ approve: boolean }>;

describe('Deriver permission handling', () => {
  it('L3 / manual: sends Enter once and emits working (dedup on repeat)', async () => {
    const { tmux, deriver, emitted } = setup('L3');
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([['Enter']]);
    expect(emitted.at(-1)!.sig.type).toBe('working');
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([['Enter']]); // no second Enter
  });

  it('mission-less (autonomy null) also auto-clears', async () => {
    const { tmux, deriver } = setup(null);
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([['Enter']]);
  });

  it('L0: never auto-clears — escalates even when an (approving) overseer is wired', async () => {
    const { tmux, deriver, emitted } = setup('L0', async () => ({ approve: true }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]); // L0 = recommend only, nothing runs
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('L1: routes the prompt through the overseer and clears it when approved', async () => {
    const { tmux, deriver, emitted } = setup('L1', async () => ({ approve: true }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([['Enter']]); // Assist auto-runs clearly-safe steps
    expect(emitted.at(-1)!.sig.type).toBe('working');
  });

  it('L1: escalates when the overseer declines (e.g. below the stricter threshold)', async () => {
    const { tmux, deriver, emitted } = setup('L1', async () => ({ approve: false }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]);
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('passes the L1 autonomy level into decideApproval so the overseer can apply its stricter gate', async () => {
    let seen = 'unset';
    const { deriver } = setup('L1', async (input) => { seen = input.autonomy; return { approve: false }; });
    await deriver.tick();
    expect(seen).toBe('L1');
  });

  it('L3 with overseer: approves a safe prompt (presses Enter)', async () => {
    const { tmux, deriver, emitted } = setup('L3', async () => ({ approve: true }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([['Enter']]);
    expect(emitted.at(-1)!.sig.type).toBe('working');
  });

  it('L3 with overseer: escalates when the overseer declines instead of pressing Enter', async () => {
    const { tmux, deriver, emitted } = setup('L3', async () => ({ approve: false }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]); // reject → no auto-press
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('claude workspace-trust gate: auto-accepts under autonomy WITHOUT consulting the overseer', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db); const agents = new AgentStore(db);
    tasks.create({ id: 'elowen-1', project_id: 1, title: 'T' }); tasks.setStatus('elowen-1', 'in_progress');
    agents.upsert({ project_id: 1, name: 'Nova', program: 'claude-code', model: 'sonnet' });
    const tmux = new FakeTmuxDriver();
    tmux.setPane('elowen-Nova', ' Accessing workspace:\n ❯ 1. Yes, I trust this folder\n   2. No, exit');
    let consulted = false;
    const deriver = new Deriver({
      tmux, agents, tasks, sink: { emit: () => {} }, sessionTaskId: () => 'elowen-1',
      autonomyFor: () => 'L3',
      decideApproval: async () => { consulted = true; return { approve: false }; },
    });
    await deriver.tick();
    expect(tmux.sentKeys('elowen-Nova')).toEqual([['Enter']]); // cleared despite a reject verdict
    expect(consulted).toBe(false); // overseer never asked — trust is environmental
  });

  it('L0: claude trust gate still escalates (autonomy gate precedes auto-accept)', async () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const tasks = new TaskStore(db); const agents = new AgentStore(db);
    tasks.create({ id: 'elowen-1', project_id: 1, title: 'T' }); tasks.setStatus('elowen-1', 'in_progress');
    agents.upsert({ project_id: 1, name: 'Nova', program: 'claude-code', model: 'sonnet' });
    const tmux = new FakeTmuxDriver();
    tmux.setPane('elowen-Nova', ' Accessing workspace:\n ❯ 1. Yes, I trust this folder\n   2. No, exit');
    const emitted: { sig: { type: string } }[] = [];
    const deriver = new Deriver({
      tmux, agents, tasks, sink: { emit: (_s, sig) => emitted.push({ sig }) },
      sessionTaskId: () => 'elowen-1', autonomyFor: () => 'L0',
    });
    await deriver.tick();
    expect(tmux.sentKeys('elowen-Nova')).toEqual([]);
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('passes the session mission id into decideApproval', async () => {
    let seen: string | null = 'unset';
    const { deriver } = setup('L3', async (input) => { seen = input.missionId; return { approve: true }; }, () => 'm-ep');
    await deriver.tick();
    expect(seen).toBe('m-ep');
  });

  it('passes the session task id into decideApproval so the verdict can be persisted against the task', async () => {
    let seen = 'unset';
    const { deriver } = setup('L3', async (input) => { seen = input.taskId; return { approve: true }; }, () => 'm-ep');
    await deriver.tick();
    expect(seen).toBe('elowen-1');
  });

  it('a thrown overseer decision escalates instead of breaking the tick', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tmux, deriver, emitted } = setup('L3', async () => { throw new Error('relay down'); });
    await expect(deriver.tick()).resolves.toBeUndefined();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]); // never auto-clears on a failed decision
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
    err.mockRestore();
  });

  it('a vanished session (capturePane throws) is isolated — the sweep does not break', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tmux, deriver } = setup('L3');
    tmux.capturePane = async () => { throw new Error('no server on this socket'); };
    await expect(deriver.tick()).resolves.toBeUndefined();
    err.mockRestore();
  });
});

const OC_QUESTION = `  ┃  # Questions
  ┃
  ┃  Which port is canonical?
  ┃
  ┃  1. :4500 (uprav package.json)
  ┃  2. :4500 (uprav README + WEB.md)
  ┃  3. :3000 (uprav docs na 3000)
  ┃  4. Type your own answer
  ┃  ↑↓ select  enter submit  esc dismiss`;

type QDecider = (input: { question: string; context: string; options: { id: string; label: string }[]; autonomy: string; missionId: string | null; taskId: string }) => Promise<{ choiceId: string | null }>;

function setupQuestion(autonomy: string | null, decideQuestion?: QDecider, missionFor?: (s: string) => string | null) {
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); const agents = new AgentStore(db);
  tasks.create({ id: 'elowen-1', project_id: 1, title: 'T' }); tasks.setStatus('elowen-1', 'in_progress');
  agents.upsert({ project_id: 1, name: 'TestAgent', program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' });
  const tmux = new FakeTmuxDriver(); tmux.setPane('elowen-TestAgent', OC_QUESTION);
  const emitted: { s: string; sig: { type: string } }[] = [];
  const deriver = new Deriver({
    tmux, agents, tasks, sink: { emit: (s, sig) => emitted.push({ s, sig }) },
    sessionTaskId: () => 'elowen-1', autonomyFor: () => autonomy, missionFor, decideQuestion,
  });
  return { tmux, deriver, emitted };
}

describe('Deriver question handling (the agent asks the user to pick an option)', () => {
  it('navigates to the overseer-picked option (Down × position-1) then accepts, and emits working', async () => {
    const { tmux, deriver, emitted } = setupQuestion('L3', async () => ({ choiceId: '2' }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([['Down', 'Enter']]); // option 2 = one step down
    expect(emitted.at(-1)!.sig.type).toBe('working');
  });

  it('option 1 needs no navigation — just accept', async () => {
    const { tmux, deriver } = setupQuestion('L3', async () => ({ choiceId: '1' }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([['Enter']]);
  });

  it('escalates to a human when the overseer returns no choice (null)', async () => {
    const { tmux, deriver, emitted } = setupQuestion('L3', async () => ({ choiceId: null }));
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]); // nothing pressed
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('L0 escalates the question without ever consulting the overseer', async () => {
    let consulted = false;
    const { tmux, deriver, emitted } = setupQuestion('L0', async () => { consulted = true; return { choiceId: '1' }; });
    await deriver.tick();
    expect(consulted).toBe(false);
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]);
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('a thrown question decision escalates instead of breaking the tick', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tmux, deriver, emitted } = setupQuestion('L3', async () => { throw new Error('relay down'); });
    await expect(deriver.tick()).resolves.toBeUndefined();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]);
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
    err.mockRestore();
  });

  it('with no decider wired at all, escalates (no blind navigation)', async () => {
    const { tmux, deriver, emitted } = setupQuestion('L3');
    await deriver.tick();
    expect(tmux.sentKeys('elowen-TestAgent')).toEqual([]);
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('re-emits needs_input every tick while the question stays escalated (a late client must see it)', async () => {
    const { deriver, emitted } = setupQuestion('L3', async () => ({ choiceId: null }));
    await deriver.tick(); // escalate
    await deriver.tick(); // same prompt still on screen → re-emit, not a false 'working'
    const kinds = emitted.map((e) => e.sig.type);
    expect(kinds).toEqual(['needs_input', 'needs_input']);
  });

  it('does NOT re-consult the overseer on repeat ticks of the same question', async () => {
    let calls = 0;
    const { deriver } = setupQuestion('L3', async () => { calls += 1; return { choiceId: null }; });
    await deriver.tick();
    await deriver.tick();
    expect(calls).toBe(1); // decided once; later ticks only re-emit the stored signal
  });
});
