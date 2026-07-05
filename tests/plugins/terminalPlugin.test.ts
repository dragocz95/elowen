import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'orca', userId: '1', admin: true, owner: true };
const scoped: TurnIdentity = { platform: 'discord', userId: '999', admin: true, owner: false };

const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('t', params);
};

describe('terminal plugin', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['terminal'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'orca-term-'));
  });

  it('registers run_command + background process tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['kill_process', 'list_processes', 'read_process_output', 'run_command']);
  });

  it('runs a command in an allowed repo (default cwd = first root)', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: 'echo terminaltest' }), { identity: owner });
    expect(res.content[0].text).toContain('terminaltest');
    expect(res.content[0].text).toContain('[exit 0]');
  });

  it('refuses a cwd outside the allowed roots', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'run_command', { command: 'echo x', cwd: '/etc' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('admin all-access runs with no roots (defaults to process cwd)', async () => {
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'run_command', { command: 'echo adminok' }), { identity: owner });
    expect(res.content[0].text).toContain('adminok');
  });

  it('a user with no repos cannot run anything', async () => {
    const res = await runWithPolicy(userPolicy([]), () => runTool(reg, 'run_command', { command: 'echo nope' }), { identity: owner });
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('refuses ALL terminal tools for a role-scoped (non-owner) caller, even with an admin role', async () => {
    for (const [name, params] of [
      ['run_command', { command: 'cat /etc/hostname' }],
      ['list_processes', {}],
      ['read_process_output', { id: 'x' }],
      ['kill_process', { id: 'x' }],
    ] as const) {
      const res = await runWithPolicy(adminPolicy, () => runTool(reg, name, params), { identity: scoped });
      expect(res.content[0].text).toMatch(/only available to the operator/);
    }
  });

  it('denies terminal tools when there is no identity (outside a turn)', async () => {
    const res = await runWithPolicy(adminPolicy, () => runTool(reg, 'run_command', { command: 'echo x' }));
    expect(res.content[0].text).toMatch(/only available to the operator/);
  });
});
