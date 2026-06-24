import { describe, it, expect } from 'vitest';
import { buildAgentCommand } from '../../src/spawn/commandBuilder.js';

describe('buildAgentCommand', () => {
  it('routes a provider/model to the interactive `opencode` TUI with --prompt', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('--model ollama-cloud/deepseek-v4-flash');
    expect(cmd).toContain('--prompt'); // UI mode: task preloaded into the composer
    expect(cmd).not.toContain('opencode run'); // not headless
  });
  it('bypasses opencode permission prompts by default via a merged OPENCODE_CONFIG_CONTENT env', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('export OPENCODE_CONFIG_CONTENT=');
    expect(cmd).toContain('"permission":"allow"');
  });
  it('omits the opencode permission bypass when skipPermissions is off', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A', skipPermissions: false });
    expect(cmd).not.toContain('OPENCODE_CONFIG_CONTENT');
    expect(cmd).toContain('--prompt'); // still launches normally, just with prompts on
  });
  it('routes a bare model to claude with an autonomous approval bypass', () => {
    const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('--model sonnet');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });
  it('omits the claude bypass flag when skipPermissions is off', () => {
    const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A', skipPermissions: false });
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    expect(cmd).toContain('--model sonnet');
  });
  it('routes codex with a positional prompt and autonomous approval bypass', () => {
    const cmd = buildAgentCommand({ program: 'codex', model: 'gpt-5.4' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('codex');
    expect(cmd).toContain('--model gpt-5.4');
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('omits the codex bypass flag when skipPermissions is off', () => {
    const cmd = buildAgentCommand({ program: 'codex', model: 'gpt-5.4' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A', skipPermissions: false });
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain('--model gpt-5.4');
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
      { projectPath: '/o', taskId: 'orca-2', agentName: 'A', epicId: 'orca-epic', epicCloseCommand: 'node /x/cli.js close orca-epic', cli: 'node /x/cli.js' },
    );
    expect(cmd).toContain('phase of epic orca-epic');
    expect(cmd).toContain('node /x/cli.js close orca-epic --summary');
    expect(cmd).toContain('node /x/cli.js ls'); // sibling-phase check uses the node CLI, not bare `orca`
    expect(cmd).not.toContain('`orca ls`');
  });
  it('omits the epic-close instruction for a standalone task (no epicId)', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).not.toContain('phase of epic');
  });
  it('tells a phase agent to build on prior phases instead of redoing the whole goal', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-2', agentName: 'A', epicId: 'orca-epic' });
    expect(cmd).toContain('ONE phase of a larger sequential mission');
    expect(cmd).toContain('do NOT redo or re-verify');
    expect(cmd).toContain('git status'); // nudged to check current repo state first
  });
  it('gives a standalone task the plain implement instruction (no phase framing)', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).not.toContain('ONE phase of a larger sequential mission');
  });
  it('tells the agent to give long shell commands a generous timeout (opencode kills short-timeout commands)', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'orca-1', agentName: 'A' });
    expect(cmd).toContain('1200000 ms');
  });
  it('uses rawPrompt verbatim and skips the worker preamble (reasoning agents)', () => {
    const cmd = buildAgentCommand(
      { program: 'claude-code', model: 'opus' },
      { projectPath: '/repo', taskId: 'pj-1', agentName: 'Pilot', rawPrompt: 'PLAN ONLY: do not implement', env: { ORCA_PLAN_JOB: 'pj-1' } },
    );
    expect(cmd).toContain('--model opus');
    expect(cmd).toContain("'PLAN ONLY: do not implement'");
    expect(cmd).toContain('export ORCA_PLAN_JOB=');
    expect(cmd).not.toContain('orca close'); // no close-command preamble for reasoning agents
    expect(cmd).not.toContain('1200000 ms'); // reasoning agents bypass the worker preamble
  });
});
