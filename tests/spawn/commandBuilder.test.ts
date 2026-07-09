import { describe, it, expect } from 'vitest';
import { buildAgentCommand } from '../../src/spawn/commandBuilder.js';

describe('buildAgentCommand', () => {
  it('routes a provider/model to the interactive `opencode` TUI with --prompt', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
    expect(cmd).toContain("--model 'ollama-cloud/deepseek-v4-flash'"); // single-quoted so it can't break the shell
    expect(cmd).toContain('--prompt'); // UI mode: task preloaded into the composer
    expect(cmd).not.toContain('opencode run'); // not headless
  });
  it('bypasses opencode permission prompts by default via a merged OPENCODE_CONFIG_CONTENT env', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
    expect(cmd).toContain('export OPENCODE_CONFIG_CONTENT=');
    expect(cmd).toContain('"permission":"allow"');
  });
  it('omits the opencode permission bypass when skipPermissions is off', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', skipPermissions: false });
    expect(cmd).not.toContain('OPENCODE_CONFIG_CONTENT');
    expect(cmd).toContain('--prompt'); // still launches normally, just with prompts on
  });
  it('routes a bare model to claude with an autonomous approval bypass', () => {
    const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
    expect(cmd).toContain("--model 'sonnet'");
    expect(cmd).toContain('--dangerously-skip-permissions');
  });
  it('omits the claude bypass flag when skipPermissions is off', () => {
    const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', skipPermissions: false });
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    expect(cmd).toContain("--model 'sonnet'");
  });
  it('routes codex with a positional prompt and autonomous approval bypass', () => {
    const cmd = buildAgentCommand({ program: 'codex', model: 'gpt-5.4' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
    expect(cmd).toContain('codex');
    expect(cmd).toContain("--model 'gpt-5.4'");
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('omits the codex bypass flag when skipPermissions is off', () => {
    const cmd = buildAgentCommand({ program: 'codex', model: 'gpt-5.4' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', skipPermissions: false });
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).toContain("--model 'gpt-5.4'");
  });
  it('wires the elowen MCP server into codex via `-c` flags when mcpUrl is set (codex ignores project-local config)', () => {
    const cmd = buildAgentCommand({ program: 'codex', model: 'gpt-5.4' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', mcpUrl: 'http://localhost:4600/mcp' });
    expect(cmd).toContain("-c 'mcp_servers.elowen.url=\"http://localhost:4600/mcp\"'"); // url override, shell-escaped
    expect(cmd).toContain("-c 'mcp_servers.elowen.bearer_token_env_var=\"ELOWEN_TOKEN\"'"); // token read from env, not the command line
    expect(cmd).toContain("--model 'gpt-5.4'"); // MCP flags precede --model, before the positional prompt
  });
  it('omits the codex MCP flags when no mcpUrl is set (workers get no MCP wiring)', () => {
    const cmd = buildAgentCommand({ program: 'codex', model: 'gpt-5.4' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
    expect(cmd).not.toContain('mcp_servers.elowen');
  });
  it('single-quotes the model so shell metacharacters cannot break out of the command (injection defense)', () => {
    // The model field can carry a task-supplied `exec:` value. Even if a bad value slips past the API
    // allow-list, single-quoting must neutralize it — the payload stays one literal --model argument.
    const evil = 'sonnet; touch /tmp/pwned #';
    const cmd = buildAgentCommand({ program: 'claude-code', model: evil }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
    expect(cmd).toContain("--model 'sonnet; touch /tmp/pwned #'"); // wrapped, not interpolated raw
    expect(cmd).not.toContain('--model sonnet; touch'); // the `;` never reaches the shell as a separator
  });
  it('embeds the close command in the prompt and exports the provided env', () => {
    const cmd = buildAgentCommand(
      { program: 'opencode', model: 'm' },
      { projectPath: '/o', taskId: 'elowen-1', agentName: 'Nova', closeCommand: 'node /x/cli.js close elowen-1', env: { ELOWEN_URL: 'http://localhost:4400', ELOWEN_TOKEN: 'tok' } },
    );
    expect(cmd).toContain('export ELOWEN_URL=');
    expect(cmd).toContain('export ELOWEN_TOKEN=');
    expect(cmd).toContain('node /x/cli.js close elowen-1');
  });
  it('defaults the close command to `elowen close <id>` when none is given', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-9', agentName: 'A' });
    expect(cmd).toContain('elowen close elowen-9');
  });
  it('injects the task title and description into the agent prompt', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', taskTitle: 'Add CSV export', taskDescription: 'Use a button on the reports page' });
    expect(cmd).toContain('Add CSV export');
    expect(cmd).toContain('Use a button on the reports page');
  });
  it('uses the configured provider binary and extra args', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', bin: '/opt/oc/opencode', extraArgs: '--pure' });
    expect(cmd).toContain("/opt/oc/opencode --model 'm' --pure --prompt ");
  });
  it('frames a phase preamble as one phase of its mission and points it at `<cli> help`', () => {
    const cmd = buildAgentCommand(
      { program: 'opencode', model: 'm' },
      { projectPath: '/o', taskId: 'elowen-2', agentName: 'A', epicId: 'elowen-epic', cli: 'node /x/cli.js' },
    );
    expect(cmd).toContain('ONE phase of mission elowen-epic');
    expect(cmd).toContain('node /x/cli.js help'); // the full control guide (incl. epic close) is fetched on demand
  });
  it('keeps the epic-close detail OUT of the preamble — it lives in the on-demand guide', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-2', agentName: 'A', epicId: 'elowen-epic' });
    expect(cmd).not.toContain('close the epic yourself'); // moved to agent-guide-phase, not the spawn message
  });
  it('gives a standalone task no mission-phase framing', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
    expect(cmd).not.toContain('ONE phase of mission');
  });
  it('renders a resume note as its own "new input" block, separate from the task details', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', taskDescription: 'Original brief', resumeNote: 'Review rejected: fix the failing test' });
    expect(cmd).toContain('Original brief');                     // static details still present
    expect(cmd).toContain('New input for this run');             // dedicated block header
    expect(cmd).toContain('Review rejected: fix the failing test');
  });
  it('omits the resume-note block entirely on a clean first run (no note)', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', taskDescription: 'Original brief' });
    expect(cmd).not.toContain('New input for this run');
  });
  it('renders the resume note in the phase template too (epicId set)', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-2', agentName: 'A', epicId: 'elowen-epic', resumeNote: 'Review rejected: add the missing test' });
    expect(cmd).toContain('ONE phase of mission elowen-epic'); // confirms the worker-phase template
    expect(cmd).toContain('New input for this run');
    expect(cmd).toContain('Review rejected: add the missing test');
  });
  it('renders the resume note in the resume template too (reattached session)', () => {
    const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'claude-code', sessionId: 's1' }, resumeNote: 'Stalled and relaunched — re-check state' });
    expect(cmd).toContain('resuming your earlier session'); // confirms the worker-resume template
    expect(cmd).toContain('New input for this run');
    expect(cmd).toContain('Stalled and relaunched — re-check state');
  });
  it('points a cold worker at the on-demand control guide (`<cli> help`) instead of inlining the tutorial', () => {
    const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', cli: 'node /x/cli.js' });
    expect(cmd).toContain('node /x/cli.js help'); // bootstrap pointer to the guide
    expect(cmd).not.toContain('1200000 ms'); // the long-timeout tip now lives in the guide, not the preamble
    expect(cmd).toContain('Work only inside your current working directory'); // the safety floor stays inline
  });
  it('uses rawPrompt verbatim and skips the worker preamble (reasoning agents)', () => {
    const cmd = buildAgentCommand(
      { program: 'claude-code', model: 'opus' },
      { projectPath: '/repo', taskId: 'pj-1', agentName: 'Pilot', rawPrompt: 'PLAN ONLY: do not implement', env: { ELOWEN_PLAN_JOB: 'pj-1' } },
    );
    expect(cmd).toContain("--model 'opus'");
    expect(cmd).toContain("'PLAN ONLY: do not implement'");
    expect(cmd).toContain('export ELOWEN_PLAN_JOB=');
    expect(cmd).not.toContain('elowen close'); // no close-command preamble for reasoning agents
    expect(cmd).not.toContain('1200000 ms'); // reasoning agents bypass the worker preamble
  });

  describe('TDD mission mode', () => {
    it('injects the TDD directive into the cold worker preamble when tddMode is on', () => {
      const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', tddMode: true });
      expect(cmd).toContain('Test-Driven Development');
      expect(cmd).toContain('confirm it FAILS'); // the failing-test-first rule
    });
    it('omits the TDD directive when tddMode is off or unset', () => {
      const off = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', tddMode: false });
      const unset = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
      expect(off).not.toContain('Test-Driven Development');
      expect(unset).not.toContain('Test-Driven Development');
      expect(unset).not.toContain('{{tddDirective}}'); // placeholder always substituted, never leaks raw
    });
    it('injects the TDD directive into the phase template too (epicId set)', () => {
      const cmd = buildAgentCommand({ program: 'opencode', model: 'm' }, { projectPath: '/o', taskId: 'elowen-2', agentName: 'A', epicId: 'elowen-epic', tddMode: true });
      expect(cmd).toContain('ONE phase of mission elowen-epic'); // confirms the worker-phase template
      expect(cmd).toContain('Test-Driven Development');
    });
    it('injects the TDD directive into the resume template too (reattached session)', () => {
      const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'claude-code', sessionId: 's1' }, tddMode: true });
      expect(cmd).toContain('resuming your earlier session'); // confirms the worker-resume template
      expect(cmd).toContain('Test-Driven Development');
    });
  });

  describe('new agent CLIs', () => {
    it('routes kilo to the interactive TUI with a --prompt flag and no command-line bypass (7.x)', () => {
      const cmd = buildAgentCommand({ program: 'kilo', model: 'anthropic/claude-sonnet-4-5' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
      expect(cmd).toContain("kilo --model 'anthropic/claude-sonnet-4-5'");
      expect(cmd).toContain('--prompt '); // 7.x delivers the task via --prompt, not a positional
      expect(cmd).not.toContain('kilo run'); // interactive TUI, not a one-shot subcommand
      expect(cmd).not.toContain('--yolo'); // gone in 7.x — auto-approval is config-driven
      expect(cmd).not.toContain('--nosplash'); // gone in 7.x
    });
    it('does not change the kilo command when skipPermissions is toggled off (the toggle is a no-op for kilo 7.x)', () => {
      const on = buildAgentCommand({ program: 'kilo', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
      const off = buildAgentCommand({ program: 'kilo', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', skipPermissions: false });
      expect(off).toEqual(on);
    });
    it('routes pi to the interactive TUI with a positional prompt and no bypass flag (tools run unattended)', () => {
      const cmd = buildAgentCommand({ program: 'pi', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
      expect(cmd).toContain("pi --model 'sonnet'");
      expect(cmd).not.toContain('--yolo');
      expect(cmd).not.toContain('--auto-approve');
    });
    it('does not change the pi command when skipPermissions is toggled off (the toggle is a no-op for pi)', () => {
      const on = buildAgentCommand({ program: 'pi', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
      const off = buildAgentCommand({ program: 'pi', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', skipPermissions: false });
      expect(off).toEqual(on);
    });
    it('routes omp to the interactive TUI with a positional prompt and the --auto-approve bypass', () => {
      const cmd = buildAgentCommand({ program: 'omp', model: 'opus' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
      expect(cmd).toContain("omp --auto-approve --model 'opus'");
    });
    it('omits the omp --auto-approve bypass when skipPermissions is off', () => {
      const cmd = buildAgentCommand({ program: 'omp', model: 'opus' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', skipPermissions: false });
      expect(cmd).not.toContain('--auto-approve');
      expect(cmd).toContain("omp --model 'opus'");
    });
    it('kilo resumes via --session alongside --model (no bypass flag in 7.x)', () => {
      const cmd = buildAgentCommand({ program: 'kilo', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'kilo', sessionId: 'k-7' } });
      expect(cmd).toContain("kilo --session 'k-7' --model 'm'");
    });
    it('pi resumes via --session alongside --model', () => {
      const cmd = buildAgentCommand({ program: 'pi', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'pi', sessionId: 'p-7' } });
      expect(cmd).toContain("pi --session 'p-7' --model 'm'");
    });
    it('omp resumes via --resume alongside --model, after the bypass flag', () => {
      const cmd = buildAgentCommand({ program: 'omp', model: 'm' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'omp', sessionId: 'o-7' } });
      expect(cmd).toContain("--auto-approve --resume 'o-7' --model 'm'");
    });
  });

  describe('resume', () => {
    it('claude resumes with --resume after the bypass flag, before --model, and a continuation prompt', () => {
      const cmd = buildAgentCommand(
        { program: 'claude-code', model: 'sonnet' },
        { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'claude-code', sessionId: 'sess-7' } },
      );
      expect(cmd).toContain("--dangerously-skip-permissions --resume 'sess-7' --model 'sonnet'");
      expect(cmd).toContain('resuming your earlier session'); // worker-resume preamble, not the full worker one
      expect(cmd).not.toContain('First read the project context'); // the cold-start worker preamble is gone
    });
    it('codex resumes via the `resume` subcommand, before the bypass flag and model', () => {
      const cmd = buildAgentCommand(
        { program: 'codex', model: 'gpt-5.5' },
        { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'codex', sessionId: 'cx-9' } },
      );
      expect(cmd).toContain("codex resume 'cx-9' --dangerously-bypass-approvals-and-sandbox --model 'gpt-5.5'");
    });
    it('opencode resumes via -s alongside --model and --prompt', () => {
      const cmd = buildAgentCommand(
        { program: 'opencode', model: 'ollama/x' },
        { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'opencode', sessionId: 'ses_42' } },
      );
      expect(cmd).toContain("-s 'ses_42' --model 'ollama/x'");
      expect(cmd).toContain('--prompt');
    });
    it('shell-escapes the resume session id (injection defense)', () => {
      const cmd = buildAgentCommand(
        { program: 'claude-code', model: 'sonnet' },
        { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'claude-code', sessionId: "x'; rm -rf / #" } },
      );
      expect(cmd).toContain("--resume 'x'\\''; rm -rf / #'"); // wrapped, the `;` never reaches the shell raw
    });
    it('omits resume tokens entirely when no resume is set (cold start unchanged)', () => {
      const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A' });
      expect(cmd).not.toContain('--resume');
      expect(cmd).toContain('Before you do anything else, run'); // the normal (cold) worker bootstrap
    });
    it('points the resumed worker at the control guide and ask, using the resolved cli', () => {
      const cmd = buildAgentCommand({ program: 'claude-code', model: 'sonnet' }, { projectPath: '/o', taskId: 'elowen-1', agentName: 'A', resume: { program: 'claude-code', sessionId: 's1' }, cli: 'node /x/cli.js' });
      expect(cmd).toContain('node /x/cli.js help'); // refresher pointer renders with the daemon cli, not bare `elowen`
      expect(cmd).toContain('node /x/cli.js ask'); // the resume preamble still names the open-question channel
    });
  });
});
