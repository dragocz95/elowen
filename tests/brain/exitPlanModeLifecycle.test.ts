import { describe, expect, it, vi } from 'vitest';
import {
  defineTool,
  ModelRegistry,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { BrainSessionFactory } from '../../src/brain/session/factory.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { EXIT_PLAN_MODE_TOOL } from '../../src/shared/planTool.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

const usage = {
  input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  model: Model<Api>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage, stopReason, timestamp: Date.now(),
  };
}

function stream(model: Model<Api>, message: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: 'start', partial: assistant(model, []) });
    events.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
  });
  return events;
}

async function fixture(exitExecute: () => Promise<{ content: { type: 'text'; text: string }[]; details: { plan: string } }>) {
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  const provider = `exit-plan-${Math.random()}`;
  const api = `exit-plan-${Math.random()}` as Api;
  let requests = 0;
  registry.registerProvider(provider, {
    name: 'Exit plan test provider', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
    streamSimple: async (model) => {
      requests += 1;
      return requests === 1
        ? stream(model, assistant(model, [
          { type: 'toolCall', id: 'plan-1', name: EXIT_PLAN_MODE_TOOL, arguments: {} },
          { type: 'toolCall', id: 'sibling-1', name: 'SiblingRead', arguments: {} },
        ], 'toolUse'))
        : stream(model, assistant(model, [{ type: 'text', text: 'This second request must not happen.' }]));
    },
    models: [{
      id: 'test-model', name: 'test-model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20_000, maxTokens: 1_000,
    }],
  });
  const model = registry.find(provider, 'test-model');
  if (!model) throw new Error('test model missing');

  const sibling = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sibling complete' }], details: {} }));
  const store = new BrainStore(openDb(':memory:'));
  const factory = new BrainSessionFactory({ store });
  const { session } = await factory.create({
    sessionId: 'exit-plan-session', ownerUserId: 1, runtime, model, providerId: provider,
    cwd: process.cwd(), systemPrompt: 'Test system prompt', appendSystemPrompt: [], skills: [],
    tools: [
      defineTool({
        name: EXIT_PLAN_MODE_TOOL, label: 'Submit plan', description: 'Submit a completed plan.',
        parameters: Type.Object({}), execute: exitExecute,
      }),
      defineTool({
        name: 'SiblingRead', label: 'Sibling read', description: 'A sibling call in the same batch.',
        parameters: Type.Object({}), execute: sibling,
      }),
    ],
    autoCompact: false, autoCompactAtPct: 80,
  });
  const events: AgentSessionEvent['type'][] = [];
  session.subscribe((event) => events.push(event.type));
  return { session, sibling, events, requestCount: () => requests };
}

describe('ExitPlanMode turn lifecycle', () => {
  it('preserves the submitted plan and ends a batched turn before another provider request', async () => {
    const f = await fixture(async () => ({
      content: [{ type: 'text', text: 'Plan submitted.' }],
      details: { plan: '# Approved boundary\n\n- Wait for the user.' },
    }));

    await f.session.prompt('prepare a plan');

    expect(f.requestCount()).toBe(1);
    expect(f.sibling).toHaveBeenCalledOnce();
    expect(f.session.messages).toContainEqual(expect.objectContaining({
      role: 'toolResult', toolCallId: 'plan-1', toolName: EXIT_PLAN_MODE_TOOL,
      details: { plan: '# Approved boundary\n\n- Wait for the user.' }, isError: false,
    }));
    expect(f.events.filter((type) => type === 'agent_end')).toHaveLength(1);
    expect(f.events.at(-1)).toBe('agent_settled');
  });

  it('does not treat a cancelled ExitPlanMode result as a submitted plan', async () => {
    const f = await fixture(async () => { throw new Error('planning cancelled'); });

    await f.session.prompt('prepare a plan');

    expect(f.requestCount()).toBe(2);
    expect(f.session.messages).toContainEqual(expect.objectContaining({
      role: 'toolResult', toolCallId: 'plan-1', toolName: EXIT_PLAN_MODE_TOOL, isError: true,
    }));
    expect(f.events.filter((type) => type === 'agent_end')).toHaveLength(1);
    expect(f.events.at(-1)).toBe('agent_settled');
  });
});
