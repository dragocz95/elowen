import { describe, it, expect } from 'vitest';
import { Deriver } from '../../src/deriver/deriver.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { AgentStore } from '../../src/store/agentStore.js';

const OC_DIALOG = `△ Permission required\n Allow once   Allow always   Reject  ⇆ select  enter confirm`;

function setup(autonomy: string | null = null, decideApproval?: DeriverDecider) {
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
    decideApproval,
  });
  return { tmux, deriver, emitted };
}
type DeriverDecider = (input: { question: string; context: string; options: { id: string; label: string }[]; autonomy: string }) => Promise<{ approve: boolean; destructive: boolean }>;

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
});
