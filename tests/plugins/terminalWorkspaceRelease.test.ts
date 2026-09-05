import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { processRegistry } from '../../src/brain/processRegistry.js';

const roots: string[] = [];
afterEach(() => {
  for (const process of processRegistry.list()) processRegistry.kill(process.id);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-release-')));
  roots.push(root);
  const project = join(root, 'project');
  const workspace = join(root, 'workspace');
  for (const path of [project, workspace, join(workspace, 'nested')]) mkdirSync(path);
  writeFileSync(join(project, 'marker.txt'), 'PROJECT');
  writeFileSync(join(workspace, 'marker.txt'), 'WORKSPACE');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  // Reuse the exact same registered Bash tool and session across all turn scopes.
  const registry = await loadPlugins({ dirs: [join(repo, 'plugins')], enabled: ['terminal'], logger: { info() {}, warn() {}, error() {} } });
  const tool = registry.tools.find((candidate) => candidate.name === 'Bash')!;
  const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [project, workspace] };
  const run = (workDir: string, command: string, cwd?: string) => runWithPolicy(policy,
    () => tool.execute('probe', { command, ...(cwd ? { cwd } : {}) }),
    { identity: { platform: 'elowen', userId: '1', admin: true, owner: true }, contributionUserId: 1, sessionId: 'reused-conversation', workDir });
  return { project, workspace, run };
}

it('returns a reused Bash session to the project after its effective workspace is released', async () => {
  const { project, workspace, run } = await fixture();
  expect((await run(workspace, 'cat marker.txt')).content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('WORKSPACE') })]));
  const released = await run(project, 'cat marker.txt');
  expect(released.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('PROJECT') })]));
  expect(JSON.stringify(released)).not.toContain('WORKSPACE');
});

it('keeps ordinary cd persistence within one effective root but not across a project switch', async () => {
  const { project, workspace, run } = await fixture();
  await run(workspace, 'cd nested');
  expect(JSON.stringify(await run(workspace, 'pwd'))).toContain(join(workspace, 'nested'));
  expect(JSON.stringify(await run(project, 'pwd'))).not.toContain(join(workspace, 'nested'));
  expect(JSON.stringify(await run(project, 'pwd'))).toContain(project);
  // An explicit allowed cwd still wins over the default and persists in the current scope.
  await run(project, 'pwd', workspace);
  expect(JSON.stringify(await run(project, 'cat marker.txt'))).toContain('WORKSPACE');
});
