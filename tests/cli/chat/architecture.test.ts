import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runChat } from '../../../src/cli/chat/app.js';
import type { BrainClient } from '../../../src/cli/chat/brainClient.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const chatRoot = join(root, 'src/cli/chat');
const chatPath = (file: string): string => join(chatRoot, file);
const source = (file: string): string => readFileSync(chatPath(file), 'utf8');
const sourceFromRoot = (file: string): string => readFileSync(join(root, file), 'utf8');
const chatSources = (): string[] => readdirSync(chatRoot)
  .filter((file) => file.endsWith('.ts'))
  .sort();

const filesContaining = (
  pattern: RegExp,
  options: { excludeDefinition?: boolean } = {},
): string[] => chatSources().filter((file) => {
  let body = source(file);
  if (options.excludeDefinition) {
    body = body.replace(/export function computeLayoutBudget[\s\S]*?\n}\n/, '')
      .replace(/export function constrainFrame[\s\S]*?\n}\n/, '');
  }
  pattern.lastIndex = 0;
  return pattern.test(body);
});

describe('chat production architecture boundaries', () => {
  it('runChat enters ChatApplication directly', () => {
    const app = source('app.ts');
    expect(app).toMatch(/from ['"]\.\/chatApplication\.js['"]/);
    expect(app).toMatch(/new ChatApplication\s*\(/);
    expect(app).not.toMatch(/\bcreateShell\b|new TerminalLifecycle\s*\(/);
  });

  it.each(['runtime.ts', 'shell.ts', 'layout.ts', 'streamController.ts'])(
    'has no legacy production module %s',
    (file) => expect(existsSync(chatPath(file))).toBe(false),
  );

  it('has no legacy import edge or factory shim', () => {
    const joined = chatSources().map(source).join('\n');
    expect(joined).not.toMatch(/['"]\.\/(?:runtime|shell|layout|streamController)\.js['"]/);
    expect(joined).not.toMatch(/\b(createShell|createStreamController|allocateShellRows)\b/);
  });

  it('keeps exactly one production owner per structural resource', () => {
    expect(filesContaining(/new FrameScheduler\s*\(/)).toEqual(['renderShell.ts']);
    expect(filesContaining(/computeLayoutBudget\s*\(/, { excludeDefinition: true })).toEqual(['renderShell.ts']);
    expect(filesContaining(/constrainFrame\s*\(/, { excludeDefinition: true })).toEqual(['renderShell.ts']);
    expect(filesContaining(/new TerminalLifecycle\s*\(/)).toEqual(['chatApplication.ts']);
    expect(filesContaining(/new SnapshotHydrator(?:<[^>]+>)?\s*\(/)).toEqual(['chatApplication.ts']);
  });

  it('does not reintroduce pure transcript compatibility APIs', () => {
    const transcript = sourceFromRoot('src/brain/transcript.ts');
    const model = sourceFromRoot('src/brain/transcriptModel.ts');
    for (const name of [
      'withChatViewChange', 'getChatViewChange', 'emptyView', 'fromHistory',
      'pushUser', 'beginAssistant', 'reduce',
    ]) {
      expect(transcript).not.toMatch(new RegExp(`export\\s+(?:function|const)\\s+${name}\\b`));
    }
    expect(model).not.toMatch(/\b(fromView|currentView|withChatViewChange)\b/);
  });

  it('has no dead scheduler/LSP/view introspection branches', () => {
    expect(source('frameScheduler.ts')).not.toMatch(/background(?:IntervalMs)?/);
    expect(sourceFromRoot('src/lsp/manager.ts')).not.toMatch(/fresh:\s*(?:true|false)|fresh:\s*boolean/);
    expect(source('chatViewport.ts')).not.toMatch(/\b(indexedHistoryTurns|cachedHistoryRows|setScrollFromRow)\s*\(/);
  });
});

describe('chat non-TTY contract', () => {
  it('keeps non-TTY chat actionable without starting a client', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const start = vi.fn();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runChat({
        base: 'http://unused', token: 'unused',
        client: { start } as unknown as BrainClient,
      });
      expect(start).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith('elowen chat needs an interactive terminal (a TTY).\n');
    } finally {
      write.mockRestore();
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});
