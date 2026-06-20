import { describe, it, expect, vi } from 'vitest';
import { Deriver } from '../../src/deriver/deriver.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { AgentStore } from '../../src/store/agentStore.js';

const OC_DIALOG = `△ Permission required\n Allow once   Allow always   Reject  ⇆ select  enter confirm`;

function setup(autonomy: string | null = null, decideApproval?: DeriverDecider, missionFor?: (session: string) => string | null) {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); const agents = new AgentStore(db);
  tasks.create({ id: 'orca-1', project_id: 1, title: 'T' }); tasks.setStatus('orca-1', 'in_progress');
  agents.upsert({ project_id: 1, name: 'TestAgent', program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' });
  const tmux = new FakeTmuxDriver(); tmux.setPane('orca-TestAgent', OC_DIALOG);
  const emitted: { s: string; sig: { type: string } }[] = [];
  const deriver = new Deriver({
    tmux, agents, tasks,
    sink: { emit: (s, sig) => emitted.push({ s, sig }) },
    sessionTaskId: () => 'orca-1',
    autonomyFor: () => autonomy,
    missionFor,
    decideApproval,
  });
  return { tmux, deriver, emitted };
}
type DeriverDecider = (input: { question: string; context: string; options: { id: string; label: string }[]; autonomy: string; missionId: string | null }) => Promise<{ approve: boolean; destructive: boolean }>;

describe('Deriver permission handling', () => {
  it('L3 / manual: sends Enter once and emits working (dedup on repeat)', async () => {
    const { tmux, deriver, emitted } = setup('L3');
    await deriver.tick();
    expect(tmux.sentKeys('orca-TestAgent')).toEqual([['Enter']]);
    expect(emitted.at(-1)!.sig.type).toBe('working');
    await deriver.tick();
    expect(tmux.sentKeys('orca-TestAgent')).toEqual([['Enter']]); // no second Enter
  });

  it('mission-less (autonomy null) also auto-clears', async () => {
    const { tmux, deriver } = setup(null);
    await deriver.tick();
    expect(tmux.sentKeys('orca-TestAgent')).toEqual([['Enter']]);
  });

  it('L1 / L0: does NOT press Enter; escalates as needs_input', async () => {
    const { tmux, deriver, emitted } = setup('L1');
    await deriver.tick();
    expect(tmux.sentKeys('orca-TestAgent')).toEqual([]); // never auto-clears
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('L3 with overseer: approves a safe prompt (presses Enter)', async () => {
    const { tmux, deriver, emitted } = setup('L3', async () => ({ approve: true, destructive: false }));
    await deriver.tick();
    expect(tmux.sentKeys('orca-TestAgent')).toEqual([['Enter']]);
    expect(emitted.at(-1)!.sig.type).toBe('working');
  });

  it('L3 with overseer: escalates a destructive prompt instead of pressing Enter', async () => {
    const { tmux, deriver, emitted } = setup('L3', async () => ({ approve: true, destructive: true }));
    await deriver.tick();
    expect(tmux.sentKeys('orca-TestAgent')).toEqual([]); // destructive → no auto-press
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('claude workspace-trust gate: auto-accepts under autonomy WITHOUT consulting the overseer', async () => {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db); const agents = new AgentStore(db);
    tasks.create({ id: 'orca-1', project_id: 1, title: 'T' }); tasks.setStatus('orca-1', 'in_progress');
    agents.upsert({ project_id: 1, name: 'Nova', program: 'claude-code', model: 'sonnet' });
    const tmux = new FakeTmuxDriver();
    tmux.setPane('orca-Nova', ' Accessing workspace:\n ❯ 1. Yes, I trust this folder\n   2. No, exit');
    let consulted = false;
    const deriver = new Deriver({
      tmux, agents, tasks, sink: { emit: () => {} }, sessionTaskId: () => 'orca-1',
      autonomyFor: () => 'L3',
      decideApproval: async () => { consulted = true; return { approve: false, destructive: true }; },
    });
    await deriver.tick();
    expect(tmux.sentKeys('orca-Nova')).toEqual([['Enter']]); // cleared despite a reject verdict
    expect(consulted).toBe(false); // overseer never asked — trust is environmental
  });

  it('L1: claude trust gate still escalates (autonomy gate precedes auto-accept)', async () => {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
    const tasks = new TaskStore(db); const agents = new AgentStore(db);
    tasks.create({ id: 'orca-1', project_id: 1, title: 'T' }); tasks.setStatus('orca-1', 'in_progress');
    agents.upsert({ project_id: 1, name: 'Nova', program: 'claude-code', model: 'sonnet' });
    const tmux = new FakeTmuxDriver();
    tmux.setPane('orca-Nova', ' Accessing workspace:\n ❯ 1. Yes, I trust this folder\n   2. No, exit');
    const emitted: { sig: { type: string } }[] = [];
    const deriver = new Deriver({
      tmux, agents, tasks, sink: { emit: (_s, sig) => emitted.push({ sig }) },
      sessionTaskId: () => 'orca-1', autonomyFor: () => 'L1',
    });
    await deriver.tick();
    expect(tmux.sentKeys('orca-Nova')).toEqual([]);
    expect(emitted.at(-1)!.sig.type).toBe('needs_input');
  });

  it('passes the session mission id into decideApproval', async () => {
    let seen: string | null = 'unset';
    const { deriver } = setup('L3', async (input) => { seen = input.missionId; return { approve: true, destructive: false }; }, () => 'm-ep');
    await deriver.tick();
    expect(seen).toBe('m-ep');
  });

  it('a thrown overseer decision escalates instead of breaking the tick', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tmux, deriver, emitted } = setup('L3', async () => { throw new Error('relay down'); });
    await expect(deriver.tick()).resolves.toBeUndefined();
    expect(tmux.sentKeys('orca-TestAgent')).toEqual([]); // never auto-clears on a failed decision
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
