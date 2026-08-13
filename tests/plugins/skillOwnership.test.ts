import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A skill is a briefing the model believes. One that names a tool teaches the model that the tool is
 *  there — and a model convinced a missing tool should exist works around its absence instead of
 *  reporting it. So a skill about a plugin's tools has to load and unload WITH that plugin, which means
 *  shipping inside it. This is the guard for the whole class: it caught the task tools being taught by
 *  the core skills plugin after the task domain had moved out of core. */
describe('a skill that teaches a plugin’s tools ships with that plugin', () => {
  const load = async (enabled: string[]) => {
    const db = openDb(':memory:');
    const registry = await loadPlugins({
      dirs: [resolve(repoRoot, 'plugins')],
      enabled,
      pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
      logger: log,
    });
    db.close();
    return registry;
  };
  /** What the model will actually READ: a registered skill is a pointer to its file, not its text. */
  const bodyOf = (reg: Awaited<ReturnType<typeof load>>, name: string): string => {
    const skill = reg.skills.find((s) => s.name === name);
    if (!skill) throw new Error(`skill '${name}' not registered`);
    return readFileSync(skill.filePath, 'utf8');
  };
  /** Every task tool the work plugin declares in its manifest — none of them may be taught elsewhere. */
  const TASK_TOOLS = ['ElowenListTasks', 'ElowenCreateTask', 'ElowenPlan', 'ElowenUpdateTask', 'ElowenGetTask', 'ElowenStopTask', 'ElowenTaskOutput'];

  it('the task tools are taught by the plugin that provides them', async () => {
    const reg = await load(['work']);
    const body = bodyOf(reg, 'elowen-tasks');
    for (const tool of ['ElowenListTasks', 'ElowenCreateTask', 'ElowenPlan']) expect(body).toContain(tool);
  });

  it('and by nothing that outlives it — the core skills plugin no longer names them', async () => {
    const reg = await load(['skills']);
    expect(reg.skills.map((s) => s.name)).toContain('elowen-control');
    expect(reg.skills.map((s) => s.name)).not.toContain('elowen-tasks');
    const everything = reg.skills.map((s) => readFileSync(s.filePath, 'utf8')).join('\n');
    for (const tool of TASK_TOOLS) expect(`${tool} taught without its plugin: ${everything.includes(tool)}`).toBe(`${tool} taught without its plugin: false`);
  });

  it('so disabling the domain takes its guidance with it', async () => {
    const withWork = await load(['skills', 'work']);
    expect(withWork.skills.map((s) => s.name)).toEqual(expect.arrayContaining(['elowen-control', 'elowen-tasks']));
    const withoutWork = await load(['skills']);
    expect(withoutWork.skills.map((s) => s.name)).not.toContain('elowen-tasks');
  });
});
