import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlugins } from '../../src/plugins/loader.js';
import { createWorkspacePathView } from '../../src/plugins/pathView.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { workspaceToolDefinition } from '../../src/brain/service/spawner.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
const log = { info() {}, warn() {}, error() {} };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function runTool(registry: PluginRegistry, name: string, input: Record<string, unknown>) {
  const tool = registry.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute(id: string, input: unknown): Promise<unknown> }).execute('bench', input);
}

describe('workspace root prompt/result bytes benchmark', () => {
  it('reports measured bytes for 1, 10 and 50 file calls', async () => {
    const registry = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const scopedView = createWorkspacePathView({
      accountUserId: 1, workspaceId: 'ws_benchmark', projectId: 1, path: repoRoot,
    });
    const legacyTools = registry.tools.filter((tool) => ['Read', 'Write', 'Edit', 'ListDir', 'Search', 'FileInfo', 'GitStatus', 'Glob', 'Grep'].includes(tool.name));
    const scopedTools = legacyTools.map(workspaceToolDefinition).filter(Boolean);
    const report: Record<string, unknown> = {
      promptToolDefinitionBytes: { legacy: bytes(legacyTools), scoped: bytes(scopedTools) },
      calls: {},
    };

    for (const count of [1, 10, 50]) {
      const legacyResults = [];
      const scopedResults = [];
      for (let i = 0; i < count; i += 1) {
        legacyResults.push(await runWithPolicy(policy, () => runTool(registry, 'FileInfo', { path: join(repoRoot, 'package.json') }), {
          sessionId: `bench-legacy-${count}`, contributionUserId: 1, workDir: repoRoot,
        }));
        scopedResults.push(await runWithPolicy(policy, () => runTool(registry, 'FileInfo', { path: 'package.json' }), {
          sessionId: `bench-scoped-${count}`, contributionUserId: 1, workDir: repoRoot, pathView: scopedView,
        }));
      }
      const legacy = bytes(legacyResults);
      const scoped = bytes(scopedResults);
      (report.calls as Record<string, unknown>)[String(count)] = { legacy, scoped, saved: legacy - scoped };
      expect(scoped).toBeLessThan(legacy);
      expect(JSON.stringify(scopedResults)).not.toContain(repoRoot);
    }
    console.log(`WORKSPACE_ROOT_BENCHMARK ${JSON.stringify(report)}`);
  });
});
