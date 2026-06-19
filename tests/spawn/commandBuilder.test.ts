import { describe, it, expect } from 'vitest';
import { buildAgentCommand } from '../../src/spawn/commandBuilder.js';

describe('buildAgentCommand', () => {
  it('routes a provider/model to the interactive `opencode` TUI with --prompt', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('--model ollama-cloud/deepseek-v4-flash');
    expect(cmd).toContain('--prompt'); // UI mode: task preloaded into the composer
    expect(cmd).not.toContain('opencode run'); // not headless
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
  it('embeds the close command in the prompt and exports the provided env', () => {
    const cmd = buildAgentCommand(
      { program: 'opencode', model: 'm' },
      { projectPath: '/o', taskId: 'orca-1', agentName: 'Nova', closeCommand: 'node /x/cli.js close orca-1', env: { ORCA_URL: 'http://localhost:4400', ORCA_TOKEN: 'tok' } },
    );
    expect(cmd).toContain('export ORCA_URL=');
    expect(cmd).toContain('export ORCA_TOKEN=');
    expect(cmd).toContain('node /x/cli.js close orca-1');
  });
  it('defaults the close command to `orca close <id>` when none is given', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-9', agentName: 'A' });
    expect(cmd).toContain('orca close orca-9');
  });
  it('injects the task title and description into the agent prompt', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A', taskTitle: 'Add CSV export', taskDescription: 'Use a button on the reports page' });
    expect(cmd).toContain('Add CSV export');
    expect(cmd).toContain('Use a button on the reports page');
  });
  it('uses the configured provider binary and extra args', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A', bin: '/opt/oc/opencode', extraArgs: '--pure' });
    expect(cmd).toContain('/opt/oc/opencode --model m --pure --prompt ');
  });
  it('tells the final phase agent to close the epic itself when epicId is given', () => {
    const cmd = buildAgentCommand(
      { program: 'opencode', model: 'm' },
      { projectPath: '/o', taskId: 'orca-2', agentName: 'A', epicId: 'orca-epic', epicCloseCommand: 'node /x/cli.js close orca-epic' },
    );
    expect(cmd).toContain('phase of epic orca-epic');
    expect(cmd).toContain('node /x/cli.js close orca-epic --summary');
  });
  it('omits the epic-close instruction for a standalone task (no epicId)', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).not.toContain('phase of epic');
  });
});
