import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

function message(model: Model<Api>, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason, timestamp: Date.now(),
  };
}

function stream(model: Model<Api>, answer: AssistantMessage) {
  const out = createAssistantMessageEventStream();
  queueMicrotask(() => {
    out.push({ type: 'start', partial: message(model, [], 'pending') });
    out.push({ type: 'done', reason: answer.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: answer });
  });
  return out;
}

function textOf(message: unknown): string {
  const content = (message as { content?: { type?: string; text?: string }[] })?.content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}

describe('files plugin — host tool validation', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-files-host-validation-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rejects an unsafe Read range through the advertised schema before execute can bless the file', async () => {
    const path = join(dir, 'precious.txt');
    writeFileSync(path, 'precious\n');
    const registry = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const readTool = registry.tools.find((tool) => tool.name === 'Read');
    const writeTool = registry.tools.find((tool) => tool.name === 'Write');
    if (!readTool || !writeTool) throw new Error('files tools missing');

    const runtime = await inMemoryModelRuntime();
    const models = new ModelRegistry(runtime);
    const api = 'files-host-validation' as Api;
    let calls = 0;
    models.registerProvider('files-test', {
      name: 'Files validation fixture', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
      streamSimple: async (model, context: Context) => {
        calls += 1;
        const schema = context.tools?.find((tool) => tool.name === 'Read')?.parameters as {
          properties?: { offset?: { maximum?: number }; limit?: { maximum?: number } };
        } | undefined;
        expect(schema?.properties?.offset?.maximum).toBe(Number.MAX_SAFE_INTEGER);
        expect(schema?.properties?.limit?.maximum).toBe(Number.MAX_SAFE_INTEGER);
        if (calls === 1) {
          return stream(model, message(model, [{
            type: 'toolCall', id: 'read-invalid', name: 'Read',
            arguments: { file_path: path, offset: Number.MAX_SAFE_INTEGER + 1 },
          }], 'toolUse'));
        }
        const validation = context.messages.at(-1);
        expect(validation).toMatchObject({ role: 'toolResult', toolName: 'Read', isError: true });
        expect(textOf(validation)).toContain('Validation failed for tool "Read"');
        expect(textOf(validation)).toContain('offset');
        return stream(model, message(model, [{ type: 'text', text: 'done' }], 'stop'));
      },
      models: [{
        id: 'files-model', name: 'files-model', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4_000, maxTokens: 512,
      }],
    });
    const model = models.find('files-test', 'files-model');
    if (!model) throw new Error('model missing');
    const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: true });
    const { session } = await createAgentSession({
      cwd: dir,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager,
      modelRuntime: runtime,
      model,
      customTools: [readTool, writeTool],
      tools: ['Read', 'Write'],
      noTools: 'builtin',
    });
    const sessionId = 'brain-files-host-validation';
    await runWithPolicy(userPolicy([dir]), () => session.prompt('read the file'), { sessionId });

    const write = await runWithPolicy(userPolicy([dir]), () => writeTool.execute(
      'write-after-invalid-read', { file_path: path, content: 'clobber' },
    ), { sessionId });
    expect(textOf(write)).toMatch(/has not been read in this conversation/);
    expect(readFileSync(path, 'utf-8')).toBe('precious\n');
  });

  it('rejects the unknown replaceAll alias before Edit executes', async () => {
    const path = join(dir, 'replace-all-alias.txt');
    writeFileSync(path, 'keep me\n');
    const registry = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const readTool = registry.tools.find((tool) => tool.name === 'Read');
    const editTool = registry.tools.find((tool) => tool.name === 'Edit');
    if (!readTool || !editTool) throw new Error('files tools missing');

    const runtime = await inMemoryModelRuntime();
    const models = new ModelRegistry(runtime);
    const api = 'files-alias-validation' as Api;
    let calls = 0;
    models.registerProvider('files-alias-test', {
      name: 'Files alias validation fixture', api, baseUrl: 'https://provider.invalid', apiKey: 'key',
      streamSimple: async (model, context: Context) => {
        calls += 1;
        if (calls === 1) {
          return stream(model, message(model, [{
            type: 'toolCall', id: 'edit-invalid', name: 'Edit',
            arguments: { file_path: path, old_string: 'keep me', new_string: 'changed', replaceAll: true },
          }], 'toolUse'));
        }
        const validation = context.messages.at(-1);
        expect(validation).toMatchObject({ role: 'toolResult', toolName: 'Edit', isError: true });
        expect(textOf(validation)).toContain('Validation failed for tool "Edit"');
        expect(textOf(validation)).toContain('replaceAll');
        return stream(model, message(model, [{ type: 'text', text: 'done' }], 'stop'));
      },
      models: [{
        id: 'files-alias-model', name: 'files-alias-model', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4_000, maxTokens: 512,
      }],
    });
    const model = models.find('files-alias-test', 'files-alias-model');
    if (!model) throw new Error('model missing');
    const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: true });
    const { session } = await createAgentSession({
      cwd: dir,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager,
      modelRuntime: runtime,
      model,
      customTools: [readTool, editTool],
      tools: ['Read', 'Edit'],
      noTools: 'builtin',
    });
    const sessionId = 'brain-files-alias-validation';
    await runWithPolicy(userPolicy([dir]), () => readTool.execute('read-before-edit', { file_path: path }), { sessionId });
    await runWithPolicy(userPolicy([dir]), () => session.prompt('edit the file'), { sessionId });

    expect(readFileSync(path, 'utf-8')).toBe('keep me\n');
  });
});
