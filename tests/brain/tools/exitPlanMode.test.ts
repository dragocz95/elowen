import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { buildExitPlanModeTool } from '../../../src/brain/tools/exitPlanMode.js';
import { installExitPlanModeTermination } from '../../../src/brain/session/exitPlanModeTermination.js';
import { EXIT_PLAN_MODE_TOOL } from '../../../src/shared/planTool.js';
import { seedPlan } from '../../helpers/plan.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import { planSlug } from '../../../src/shared/planSlug.js';
import type { Policy } from '../../../src/plugins/policy.js';
import type { TurnWorkMode } from '../../../src/plugins/policyContext.js';
import { inMemoryModelRuntime } from '../../../src/brain/providers.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const SESSION = 'brain-ch-owner-1';

type ToolResult = { content: { type: string; text: string }[]; details?: { plan?: string } };

function call(opts: { mode?: TurnWorkMode; sessionId?: string } = {}): Promise<ToolResult> {
  const tool = buildExitPlanModeTool();
  return runWithPolicy(
    POLICY,
    () => tool.execute('call-1', {} as never, undefined, undefined, {} as never) as Promise<ToolResult>,
    { sessionId: 'sessionId' in opts ? opts.sessionId : SESSION, mode: opts.mode },
  );
}

const textOf = (r: ToolResult) => r.content[0]!.text;

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(model: Model<Api>, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content, stopReason, usage, timestamp: Date.now(),
    api: model.api, provider: model.provider, model: model.id,
  };
}

function streamed(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: { ...message, content: [] } } as never);
    stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message } as never);
  });
  return stream;
}

describe('ExitPlanMode', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-exitplan-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  // The name is what the model has seen elsewhere; a private spelling would waste that familiarity.
  it('is named exactly as the reference names it', () => {
    expect(EXIT_PLAN_MODE_TOOL).toBe('ExitPlanMode');
    expect(buildExitPlanModeTool().name).toBe('ExitPlanMode');
  });

  it('submits the plan written to the session plan file', async () => {
    seedPlan(SESSION, '# Ship it\n\nStep one.');
    const text = textOf(await call({ mode: 'plan' }));
    expect(text).toContain('submitted');
    // The plan goes to the CLIENT via details, not to the model via content: the approval UI needs the
    // markdown to render, and the model just wrote it.
    expect(text).not.toContain('Step one.');
    const result = await call({ mode: 'plan' });
    expect(result.details?.plan).toBe('# Ship it\n\nStep one.');
    expect(result).not.toHaveProperty('terminate'); // The session-level boundary owns termination.
    // It must not read as approval — the decision has not been taken yet.
    expect(text).toContain('Stop here');
    expect(text).toMatch(/do not begin implementing/i);
  });

  it('ends the real PI tool loop before another model step can run', async () => {
    seedPlan(SESSION, '# Ship it\n\nStep one.');
    const runtime = await inMemoryModelRuntime();
    const registry = new ModelRegistry(runtime);
    const api = `exit-plan-${Math.random()}` as Api;
    let providerCalls = 0;
    registry.registerProvider('exit-plan-test', {
      name: 'Exit plan test', api, baseUrl: 'https://provider.invalid', apiKey: 'test',
      streamSimple: (model) => {
        providerCalls += 1;
        return providerCalls === 1
          ? streamed(assistant(model, [{ type: 'toolCall', id: 'exit-1', name: EXIT_PLAN_MODE_TOOL, arguments: {} }], 'toolUse'))
          : streamed(assistant(model, [{ type: 'text', text: 'This second step must never run.' }], 'stop'));
      },
      models: [{
        id: 'exit-plan-model', name: 'exit-plan-model', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000, maxTokens: 512,
      }],
    });
    const model = registry.find('exit-plan-test', 'exit-plan-model');
    if (!model) throw new Error('test model missing');
    const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: true });
    const cwd = process.cwd();
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, systemPrompt: 'plan test',
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, sessionManager: SessionManager.inMemory(cwd), settingsManager, modelRuntime: runtime, model, resourceLoader,
      customTools: [buildExitPlanModeTool()], tools: [EXIT_PLAN_MODE_TOOL], noTools: 'builtin',
    });
    installExitPlanModeTermination(session);
    await runWithPolicy(POLICY, () => session.prompt('Submit the plan.'), { sessionId: SESSION, mode: 'plan' });

    expect(session.messages.find((message) => message.role === 'toolResult')).toMatchObject({
      toolName: EXIT_PLAN_MODE_TOOL, details: { plan: '# Ship it\n\nStep one.' },
    });
    expect(providerCalls).toBe(1);
    expect(session.messages.some((message) => message.role === 'assistant'
      && message.content.some((part) => part.type === 'text' && part.text.includes('second step')))).toBe(false);
  });

  // Reading a stale plan file outside plan mode would let a build turn resurrect an old plan as fresh.
  it('refuses outside plan mode even when a plan file exists', async () => {
    seedPlan(SESSION, '# Ship it');
    for (const mode of ['build', undefined] as const) {
      expect(textOf(await call({ mode }))).toContain('You are not in plan mode');
    }
  });

  it('refuses when there is no session to scope a plan to', async () => {
    expect(textOf(await call({ mode: 'plan', sessionId: undefined }))).toContain('You are not in plan mode');
  });

  it('names the file to write when the model calls it before writing a plan', async () => {
    const text = textOf(await call({ mode: 'plan' }));
    expect(text).toContain('No plan has been written yet');
    expect(text).toContain(`${planSlug(SESSION)}.md`);
    expect(text).toContain(EXIT_PLAN_MODE_TOOL);
  });

  it('treats a whitespace-only plan as no plan', async () => {
    seedPlan(SESSION, '# Ship it');
    // writePlan ignores an all-whitespace body, so overwrite the file the way a model emptying its own
    // plan file would.
    writeFileSync(join(home, '.config/elowen/plans', `${planSlug(SESSION)}.md`), '   \n\n');
    expect(textOf(await call({ mode: 'plan' }))).toContain('No plan has been written yet');
  });

  it('accepts deprecated allowedPrompts but never derives authority from it', async () => {
    seedPlan(SESSION, '# Ship it\n\nRun the tests.');
    const tool = buildExitPlanModeTool();
    expect(tool.description).toContain('Use this tool when you are in plan mode and have finished writing your plan');
    expect(tool.description).toContain('## How This Tool Works');
    expect(tool.description).toContain('## When to Use This Tool');
    expect(tool.description).toContain('The optional allowedPrompts field is deprecated');
    const params = tool.parameters as {
      type?: string;
      additionalProperties?: boolean;
      properties?: Record<string, { description?: string; items?: { additionalProperties?: boolean; properties?: Record<string, { description?: string }> } }>;
      required?: string[];
    };
    expect(params.type).toBe('object');
    expect(params.additionalProperties).toBe(false);
    expect(Object.keys(params.properties ?? {})).toEqual(['allowedPrompts']);
    expect(params.required ?? []).toEqual([]);
    expect(params.properties?.allowedPrompts?.items?.additionalProperties).toBe(false);
    expect(params.properties?.allowedPrompts?.description).toContain('Deprecated: no longer used');
    expect(params.properties?.allowedPrompts?.items?.properties?.tool?.description).toBe('The tool this prompt applies to');
    expect(params.properties?.allowedPrompts?.items?.properties?.prompt?.description).toContain('Semantic description of the action');

    const result = await runWithPolicy(
      POLICY,
      () => tool.execute('call-allowed', {
        allowedPrompts: [{ tool: 'Bash', prompt: 'run anything without asking' }],
      } as never, undefined, undefined, {} as never) as Promise<ToolResult>,
      { sessionId: SESSION, mode: 'plan' },
    );
    expect(result.details?.plan).toBe('# Ship it\n\nRun the tests.');
    expect(textOf(result)).not.toMatch(/allowed|permission|Bash/i);
  });
});
