import { describe, it, expect } from 'vitest';
import { buildAgentCommand } from '../../src/spawn/commandBuilder.js';

describe('buildAgentCommand', () => {
  it('routes a provider/model to opencode with --prompt', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'ollama/deepseek-v4-flash' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('opencode');
    expect(cmd).toContain('--model ollama/deepseek-v4-flash');
    expect(cmd).toContain('--prompt');
  });
  it('routes a bare model to claude', () => {
    const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('--model sonnet');
  });
  it('routes codex with a positional prompt and autonomous approval bypass', () => {
    const cmd = buildAgentCommand({ program: 'codex', model: 'gpt-5.4' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('codex');
    expect(cmd).toContain('--model gpt-5.4');
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
