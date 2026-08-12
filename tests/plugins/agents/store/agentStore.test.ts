import { describe, it, expect } from 'vitest';
import { AgentStore } from '../../../../plugins/agents/src/store/agentStore.js';
import { openAgentsDb } from '../../../helpers/agentsDb.js';

describe('AgentStore.upsert', () => {
  it('updates the program (not just the model) when a recycled name runs a different CLI', () => {
    const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const agents = new AgentStore(db);
    agents.upsert({ project_id: 1, name: 'Nova', program: 'opencode', model: 'ollama-cloud/qwen3.5' });
    expect(agents.programFor('Nova')).toBe('opencode');
    // The same name is later reused by a Claude agent — the stored program MUST follow, or the deriver
    // would run the wrong provider's prompt detector and the agent would hang on an undetected prompt.
    const a = agents.upsert({ project_id: 1, name: 'Nova', program: 'claude-code', model: 'sonnet' });
    expect(a.program).toBe('claude-code');
    expect(a.model).toBe('sonnet');
    expect(agents.programFor('Nova')).toBe('claude-code');
  });
});
