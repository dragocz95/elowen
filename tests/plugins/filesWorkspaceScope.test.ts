import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPlugins } from '../../src/plugins/loader.js';
import { createWorkspacePathView } from '../../src/plugins/pathView.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { workspaceToolDefinition } from '../../src/brain/service/spawner.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

function runTool(reg: PluginRegistry, name: string, params: Record<string, unknown>) {
  const tool = reg.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute(id: string, input: unknown): Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> })
    .execute('tool', params);
}

describe('Files tools in an explicit workspace PathView', () => {
  let root: string;
  let secondRoot: string;
  let reg: PluginRegistry;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'elowen-files-workspace-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'same.ts'), 'export const value = 1;\n');
    secondRoot = mkdtempSync(join(tmpdir(), 'elowen-files-workspace-second-'));
    mkdirSync(join(secondRoot, 'src'));
    writeFileSync(join(secondRoot, 'src', 'same.ts'), 'export const value = 10;\n');
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  });

  const scopedAt = <T>(workspaceId: string, workspaceRoot: string, fn: () => T): T => runWithPolicy(policy, fn, {
    sessionId: 'brain-workspace-test',
    contributionUserId: 1,
    workDir: workspaceRoot,
    pathView: createWorkspacePathView({ accountUserId: 1, workspaceId, projectId: 1, path: workspaceRoot }),
  });
  const scoped = <T>(fn: () => T): T => scopedAt('ws_files', root, fn);

  it('reads, writes, edits, lists and searches with relative paths and no host prefix in results', async () => {
    const read = await scoped(() => runTool(reg, 'Read', { file_path: 'src/same.ts' }));
    expect(read.content[0]!.text).toContain('value = 1');
    expect(JSON.stringify(read)).not.toContain(root);
    // The RESULT still reports `path`: read-state recovery keys on details.path, so the rename of the
    // input parameters deliberately left the output shape alone.
    expect(read.details).toMatchObject({ path: 'src/same.ts', workspaceId: 'ws_files' });

    const edit = await scoped(() => runTool(reg, 'Edit', { file_path: 'src/same.ts', old_string: 'value = 1', new_string: 'value = 2' }));
    expect(JSON.stringify(edit)).not.toContain(root);
    expect(readFileSync(join(root, 'src', 'same.ts'), 'utf8')).toContain('value = 2');

    const write = await scoped(() => runTool(reg, 'Write', { file_path: 'src/new.ts', content: 'export {};\n' }));
    expect(JSON.stringify(write)).not.toContain(root);
    const listed = await scoped(() => runTool(reg, 'ListDir', { path: 'src' }));
    expect(listed.content[0]!.text).toContain('new.ts');
    const grep = await scoped(() => runTool(reg, 'Grep', { path: '.', pattern: 'value = 2' }));
    expect(grep.content[0]!.text).toContain('src/same.ts');
    expect(JSON.stringify(grep)).not.toContain(root);
  });

  it('does not let the same relative path in one worktree vouch for a sibling worktree', async () => {
    await scoped(() => runTool(reg, 'Read', { file_path: 'src/same.ts' }));
    const refused = await scopedAt('ws_second', secondRoot, () => runTool(reg, 'Edit', {
      file_path: 'src/same.ts', old_string: 'value = 10', new_string: 'value = 11',
    }));
    expect(refused.content[0]!.text).toContain('has not been read in this conversation');
    await scopedAt('ws_second', secondRoot, () => runTool(reg, 'Read', { file_path: 'src/same.ts' }));
    await scopedAt('ws_second', secondRoot, () => runTool(reg, 'Edit', {
      file_path: 'src/same.ts', old_string: 'value = 10', new_string: 'value = 11',
    }));
    expect(readFileSync(join(secondRoot, 'src', 'same.ts'), 'utf8')).toContain('value = 11');
  });

  // The tests above prove the tools BEHAVE under a PathView. This one proves they are still THERE:
  // composition and behaviour are separate gates, and for a long time only the second one passed. Every
  // Files path tool worked correctly inside a workspace, but none except GitStatus carried the
  // `workspaceSafe` declaration, so the spawner's fail-closed filter removed all of them and a
  // workspace-scoped sub-agent was handed no way to read or write a single file. Nothing failed loudly —
  // the child simply reported that it had no file tools.
  it('survives the spawner composition filter a workspace-scoped child is built with', () => {
    const composed = reg.tools
      .filter((tool) => !reg.hostFilesystemTools.has(tool.name)
        && reg.workspaceSafeTools.has(tool.name)
        && !reg.workspaceUnsafeTools.has(tool.name))
      .map(workspaceToolDefinition)
      .filter((tool): tool is NonNullable<typeof tool> => !!tool);
    expect(composed.map((tool) => tool.name).sort()).toEqual(
      ['Edit', 'FileInfo', 'GitStatus', 'Glob', 'Grep', 'ListDir', 'Read', 'Search', 'Write'],
    );
    // …and that the contract the model reads travelled with them, so no description still tells a
    // confined child to pass the absolute path it would then be refused for.
    const read = composed.find((tool) => tool.name === 'Read');
    expect(read?.description).toContain('relative to the assigned workspace');
    expect(read?.description).not.toContain('The path must be absolute.');
  });

  it('rejects absolute paths and traversal even under an admin policy', async () => {
    const absolute = await scoped(() => runTool(reg, 'Read', { file_path: join(root, 'src', 'same.ts') }));
    expect(absolute.content[0]!.text).toContain('absolute paths are unavailable');
    expect(JSON.stringify(absolute)).not.toContain(root);
    const traversal = await scoped(() => runTool(reg, 'Read', { file_path: '../secret' }));
    expect(traversal.content[0]!.text).toContain('outside the assigned workspace');
  });
});
