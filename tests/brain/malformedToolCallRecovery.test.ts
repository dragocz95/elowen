import { describe, expect, it } from 'vitest';
import {
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { recoverMalformedToolCalls } from '../../src/brain/session/malformedToolCallRecovery.js';

const BAD_UNICODE_ESCAPE = 'Bad Unicode escape in JSON at position 1104 (line 1 column 1105)';

function message(
  model: Model<Api>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  };
}

function assistantStream(model: Model<Api>, answer: AssistantMessage) {
  const out = createAssistantMessageEventStream();
  queueMicrotask(() => {
    out.push({ type: 'start', partial: message(model, [], 'pending') });
    if (answer.stopReason === 'error') out.push({ type: 'error', reason: 'error', error: answer });
    else out.push({ type: 'done', reason: answer.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: answer });
  });
  return out;
}

describe('recoverMalformedToolCalls', () => {
  it('turns a provider-rejected malformed tool argument into a tool validation result so the turn can continue', async () => {
    const runtime = await inMemoryModelRuntime();
    const registry = new ModelRegistry(runtime);
    const api = 'anthropic-messages' as Api;
    let calls = 0;
    registry.registerProvider('anthropic', {
      name: 'Anthropic regression fixture', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
      streamSimple: async (model, context) => {
        calls += 1;
        if (calls === 1) {
          return assistantStream(model, message(model, [{
            type: 'toolCall', id: 'todo-1', name: 'TodoWrite',
            arguments: { todos: [{ title: 'kept', status: 'completed' }, {}, 'status'] },
          }], 'error', BAD_UNICODE_ESCAPE));
        }
        expect(context.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true });
        return assistantStream(model, message(model, [{ type: 'text', text: 'The turn survived.' }], 'stop'));
      },
      models: [{
        id: 'claude-opus-5', name: 'claude-opus-5', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4_000, maxTokens: 512,
      }],
    });
    const model = registry.find('anthropic', 'claude-opus-5');
    if (!model) throw new Error('model missing');
    const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: true });
    const cwd = process.cwd();
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      modelRuntime: recoverMalformedToolCalls(runtime),
      model,
      customTools: [defineTool({
        name: 'TodoWrite', label: 'TodoWrite', description: 'Update todos',
        parameters: Type.Object({
          todos: Type.Array(Type.Object({
            title: Type.String(),
            status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
          })),
        }),
        execute: async () => ({ content: [{ type: 'text', text: 'updated' }], details: {} }),
      })],
      tools: ['TodoWrite'],
      noTools: 'builtin',
    });

    await session.prompt('continue');

    expect(calls).toBe(2);
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'The turn survived.' }],
    });
  });
});
