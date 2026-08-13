import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

/** Every tool name a bundled plugin defines. Read from the `defineTool({ name: '…' })` call itself
 *  rather than from a manifest, because a manifest only lists the plan-safe subset — the promise a core
 *  prompt must not make is about EXISTENCE, so the set has to be every tool a plugin owns. */
function pluginToolNames(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // `dist`/`web` hold build output of the same sources; node_modules is not ours.
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'web' || entry.name === 'node_modules') continue;
        walk(join(dir, entry.name));
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        const text = readFileSync(join(dir, entry.name), 'utf8');
        for (const m of text.matchAll(/defineTool\(\s*\{[\s\S]{0,240}?name:\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) names.add(m[1]!);
      }
    }
  };
  walk(join(repoRoot, 'plugins'));
  return names;
}

/** The system prompts the core renders for EVERY turn on EVERY instance, whatever is installed. The
 *  `cli/*` mode templates are deliberately not here: they are injected only while a mode is active and
 *  they are written around plugin-owned tooling end to end, so the durable fix for those is to move the
 *  template into its owning plugin (registerPrompts owns whole templates) — tracked separately. */
const ALWAYS_RENDERED = ['elowen', 'elowen-platform', 'scheduled', 'worker-brain', 'planner', 'planner-fallback'];

/** A core template is read with no knowledge of which plugins the instance runs. Naming a plugin-owned
 *  tool in one therefore instructs the model to prefer a tool it may not have been given — which is
 *  exactly what an instance with `agents` or `work` disabled gets. */
describe('core prompt templates', () => {
  it('name no tool that a plugin owns', () => {
    const owned = pluginToolNames();
    // The scan must actually find the plugin tools, or the assertion below passes vacuously.
    for (const known of ['ElowenListTasks', 'ElowenListMissions', 'ElowenListSessions', 'AskUserQuestion']) {
      expect(owned).toContain(known);
    }

    const promised: string[] = [];
    for (const name of ALWAYS_RENDERED) {
      const text = readFileSync(join(repoRoot, 'prompts', `${name}.md`), 'utf8');
      for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) {
        if (owned.has(m[1]!)) promised.push(`${name}.md: ${m[1]}`);
      }
    }
    expect(promised).toEqual([]);
  });

  it('still names the core tools they depend on', () => {
    // The rule is about OWNERSHIP, not about scrubbing every tool name: a template may name a tool the
    // core itself registers. `ElowenCloseTask` comes from src/brain/worker/brainWorker.ts and is the
    // only way an embedded worker settles its task, so worker-brain.md has to keep naming it.
    expect(readFileSync(join(repoRoot, 'prompts', 'worker-brain.md'), 'utf8')).toContain('`ElowenCloseTask`');
    expect(pluginToolNames().has('ElowenCloseTask')).toBe(false);
  });
});
