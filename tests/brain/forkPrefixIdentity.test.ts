import { describe, expect, it } from 'vitest';
import { defineTool, ModelRegistry, type AgentSession } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { BrainSessionFactory } from '../../src/brain/session/factory.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import {
  FORK_PLACEHOLDER_RESULT,
  buildForkChildMessage,
  forkSeedMessages,
  type ForkMessage,
} from '../../src/brain/session/forkPrefix.js';

/** THE contract of the whole feature: a fork child's outgoing request must begin with exactly the bytes the
 *  parent's did. Anthropic hashes the request prefix in order, so the first differing byte re-bills
 *  everything behind it — a fork whose prefix merely RESEMBLES the parent's is a full-price cold start
 *  wearing a fork's name.
 *
 *  Asserted as string equality on the captured request bodies rather than on the pieces that produce them.
 *  Every earlier version of this bug was a piece that looked right in isolation: a persona branch, a skills
 *  block, one withheld tool schema. Only the assembled body can catch those, so the comparison is made
 *  where the bytes actually are. */

const usage = {
  input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The captured request, in the shape a provider actually sends: one system block, the tool schemas, and
 *  the message history. Everything here is JSON-comparable on purpose. */
interface Captured {
  system: string;
  tools: string;
  messages: unknown[];
}

function assistantMessage(model: Model<Api>, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage, stopReason, timestamp: 1_700_000_000_000,
  };
}

function stream(model: Model<Api>, message: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: 'start', partial: assistantMessage(model, [], 'stop') });
    events.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
  });
  return events;
}

const SYSTEM_PROMPT = 'You are Elowen. Owner-chat persona, byte for byte.';
const APPEND = ['<available_skills>\n- deploy-checklist\n</available_skills>', 'Account instructions.'];

const tools = () => [
  defineTool({
    name: 'Read', label: 'Read', description: 'Read a file.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'file body' }], details: {} }),
  }),
  defineTool({
    name: 'Delegate', label: 'Delegate', description: 'Hand a task to a sub-agent.',
    parameters: Type.Object({ task: Type.String() }),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'delegated' }], details: {} }),
  }),
];

async function harness() {
  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  const provider = `fork-identity-${Math.random()}`;
  const api = `fork-identity-${Math.random()}` as Api;
  const captured: Captured[] = [];
  let call = 0;

  registry.registerProvider(provider, {
    name: 'Fork identity provider', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
    streamSimple: async (model: Model<Api>, context: Context) => {
      call += 1;
      captured.push({
        system: context.systemPrompt ?? '',
        // The tool BLOCK as the provider serializes it: names, descriptions and schemas, in order.
        tools: JSON.stringify((context as { tools?: unknown[] }).tools ?? []),
        messages: JSON.parse(JSON.stringify(context.messages)) as unknown[],
      });
      // The parent's first turn ends in the Delegate call that spawns the fork; everything after is a
      // plain answer, so the capture is never disturbed by a second round of tool use.
      return call === 1
        ? stream(model, assistantMessage(model, [
          { type: 'text', text: 'Forking that off.' },
          { type: 'toolCall', id: 'call-fork-1', name: 'Delegate', arguments: { task: 'audit the store' } },
        ], 'toolUse'))
        : stream(model, assistantMessage(model, [{ type: 'text', text: 'done' }], 'stop'));
    },
    models: [{
      id: 'fork-model', name: 'fork-model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000,
    }],
  });

  const model = registry.find(provider, 'fork-model');
  if (!model) throw new Error('fork test model missing');
  const store = new BrainStore(openDb(':memory:'));
  const factory = new BrainSessionFactory({ store });

  /** Both sessions are built through the SAME real factory call, differing only in what a fork differs in:
   *  the parent link, the fork scope and the inherited transcript. */
  const create = async (sessionId: string, extra: Record<string, unknown> = {}): Promise<AgentSession> => {
    const { session } = await factory.create({
      sessionId, ownerUserId: 1, runtime, model, providerId: provider,
      cwd: process.cwd(), systemPrompt: SYSTEM_PROMPT, appendSystemPrompt: [...APPEND], skills: [],
      tools: tools(), autoCompact: false, autoCompactAtPct: 80,
      ...extra,
    });
    return session;
  };

  return { captured, create, store };
}

async function parentAndFork() {
  const h = await harness();
  const parent = await h.create('brain-parent');
  // One real parent turn: it ends on the Delegate tool call the fork is spawned from.
  await parent.prompt('please audit the store');
  // The parent's FIRST request is the one whose prefix the fork inherits: everything the conversation had
  // sent when the Delegate call was made. Its later requests (the turn continues once the real tool result
  // lands) are irrelevant here and are stepped over below.
  const parentRequest = h.captured[0]!;
  const parentCalls = h.captured.length;

  // The seed is built from the parent's own history, exactly as the channel service builds it at spawn.
  const history = JSON.parse(JSON.stringify(parent.messages)) as ForkMessage[];
  // Everything the parent had asked for but not yet answered when the fork was taken.
  const seed = forkSeedMessages(
    history.filter((message) => message.role !== 'toolResult'),
    1_700_000_000_000,
  );

  const child = await h.create('brain-ch-subagent-sub-fork-1', {
    parentSessionId: 'brain-parent',
    delegatedAccess: { admin: true, projectIds: [], owner: true, permissionBoundary: null, fork: true },
    forkSeed: seed,
  });
  // eslint-disable-next-line no-console
  await child.prompt(buildForkChildMessage('audit the store'));
  const childRequest = h.captured[parentCalls]!;

  return { parentRequest, childRequest, seed, parentCalls };
}

describe('a fork child sends the parent’s prefix byte for byte', () => {
  it('sends an identical system prompt', async () => {
    const { parentRequest, childRequest } = await parentAndFork();
    expect(childRequest.system).toBe(parentRequest.system);
  });

  it('sends an identical tool block', async () => {
    const { parentRequest, childRequest } = await parentAndFork();
    expect(childRequest.tools).toBe(parentRequest.tools);
  });

  it('repeats every message the parent sent, unchanged, before the fork boundary', async () => {
    const { parentRequest, childRequest } = await parentAndFork();
    const shared = childRequest.messages.slice(0, parentRequest.messages.length);
    expect(JSON.stringify(shared)).toBe(JSON.stringify(parentRequest.messages));
  });

  it('closes the boundary with the parent’s assistant turn and a placeholder for its tool call', async () => {
    const { parentRequest, childRequest } = await parentAndFork();
    const tail = childRequest.messages.slice(parentRequest.messages.length) as {
      role: string; toolCallId?: string; content?: unknown;
    }[];
    const boundaryAssistant = tail[0]!;
    expect(boundaryAssistant.role).toBe('assistant');
    const placeholder = tail.find((message) => message.role === 'toolResult')!;
    expect(placeholder.toolCallId).toBe('call-fork-1');
    expect(JSON.stringify(placeholder.content)).toContain(FORK_PLACEHOLDER_RESULT);
  });

  it('carries the directive as the last message, behind the shared worker rules', async () => {
    const { childRequest } = await parentAndFork();
    const last = childRequest.messages.at(-1) as { role: string; content: unknown };
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('audit the store');
    expect(JSON.stringify(last.content)).toContain('fork-boilerplate');
  });
});
