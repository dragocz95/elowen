import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
    expect(filesContaining(/new ChatApplicationLifetime(?:<[^>]+>)?\s*\(/)).toEqual(['chatApplication.ts']);
  });

  it('keeps ChatApplication on one production-only construction and lifecycle path', () => {
    const application = source('chatApplication.ts');
    const file = ts.createSourceFile('chatApplication.ts', application, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = file.statements.find((statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'ChatApplication');
    expect(declaration).toBeDefined();
    const constructors = declaration!.members.filter(ts.isConstructorDeclaration);
    expect(constructors).toHaveLength(1);
    const [constructor] = constructors;
    expect(constructor?.parameters).toHaveLength(1);
    expect(constructor?.parameters[0]?.type?.getText(file)).toBe('ChatLaunchOptions');

    const publicInstanceMembers = declaration!.members
      .filter((member): member is ts.MethodDeclaration | ts.PropertyDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
        ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)
        || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
      .filter((member) => {
        const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
        return !modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
          || modifier.kind === ts.SyntaxKind.ProtectedKeyword
          || modifier.kind === ts.SyntaxKind.StaticKeyword);
      })
      .map((member) => member.name?.getText(file));
    expect(publicInstanceMembers).toEqual(['run']);

    const hydratorProperty = declaration!.members.find((member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && member.name.getText(file) === 'hydrator');
    expect(hydratorProperty).toBeDefined();
    expect(hydratorProperty?.initializer).toBeUndefined();
    const hydratorConstructions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && node.expression.getText(file) === 'SnapshotHydrator') {
        hydratorConstructions.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(hydratorConstructions).toHaveLength(1);
    let owner: ts.Node | undefined = hydratorConstructions[0];
    while (owner && !ts.isMethodDeclaration(owner)) owner = owner.parent;
    expect(owner && ts.isMethodDeclaration(owner) ? owner.name.getText(file) : null).toBe('bootstrap');

    expect(application).not.toContain('PreparedChatApplicationOptions');
    expect(application).not.toMatch(/['"]state['"]\s+in\s+options/);
    expect(filesContaining(/new ChatApplication\s*\(/)).toEqual(['app.ts']);
    const exportedNames = file.statements
      .filter((statement) => ts.canHaveModifiers(statement)
        && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .map((statement) => ('name' in statement && statement.name && ts.isIdentifier(statement.name)
        ? statement.name.text
        : null));
    expect(exportedNames).toEqual(['ChatLaunchOptions', 'ChatApplication']);
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

  it('routes every detached UI/client operation through the application lifetime', () => {
    for (const file of ['commands.ts', 'pickers.ts', 'flows.ts', 'chatComposition.ts']) {
      expect(source(file), file).not.toMatch(/\bvoid\s+(?:client|readClipboardImage|runLocalShell)\b/);
    }
    expect(source('chatApplication.ts')).toMatch(/client\.bindLifetime\(this\.lifetime\.signal\)/);
    expect(source('chatApplication.ts')).toMatch(/this\.lifetime\.stop\(\)/);
  });

  it('keeps stream controller replacement inside the stream coordinator', () => {
    expect(source('pickers.ts')).not.toMatch(/\bstreamAc\b|new AbortController\s*\(/);
    expect(source('pickers.ts')).toMatch(/stream\.restartStream\(\)/);
  });

  it('does not compute unused sub-agent status for keyboard navigation', () => {
    expect(source('streamCoordinator.ts')).not.toMatch(/running:\s*s\.status\s*===\s*['"]running['"]/);
  });

  it('keeps test-only routing and root inspection out of production APIs', () => {
    expect(source('inputRouter.ts')).not.toMatch(/customRoute|routeOrContext|constructor\(tui:\s*TUI,\s*route:/);
    expect(source('chatComposition.ts')).not.toMatch(
      /readonly\s+(?:root|renderShell):\s*(?:Component|RenderShell)|\broot:\s*measuredRoot/,
    );
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
