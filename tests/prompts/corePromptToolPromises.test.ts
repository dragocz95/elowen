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
 *  exactly what an instance gets when the owning plugin is disabled or, since the domain plugins moved to
 *  the registry, simply not installed. */
describe('core prompt templates', () => {
  it('name no tool that a plugin owns', () => {
    const owned = pluginToolNames();
    // The scan must actually find the plugin tools, or the assertion below passes vacuously. These four
    // come from four different bundled plugins (askuser, terminal, subagent, files), so a scan that
    // silently stops walking part of the tree fails here rather than reporting a clean prompt.
    for (const known of ['AskUserQuestion', 'Bash', 'Delegate', 'Read']) {
      expect(owned).toContain(known);
    }

    const promised: string[] = [];

    // A promise made in prose ("use ElowenListTasks first") instructs the model exactly as hard as one
    // in code font, so backticks alone are too narrow a net. But a one-word tool name IS an English
    // word — "Read the relevant implementation", "Write progress to files", "Delegate to a sub-agent"
    // open sentences in these very templates — so those count only when the text points at the tool:
    // in backticks, or spelled out as "the Read tool". A name with a second capital (ElowenListTasks,
    // AskUserQuestion, WebFetch) is never an English word and counts bare.
    const referenced = (text: string, tool: string): boolean => {
      const bare = new RegExp(`\\b${tool}\\b`);
      const pointed = new RegExp(`\`${tool}\`|\\b${tool} tool\\b`);
      return /^[A-Z][a-z]+$/.test(tool) ? pointed.test(text) : bare.test(text);
    };
    for (const name of ALWAYS_RENDERED) {
      const text = readFileSync(join(repoRoot, 'prompts', `${name}.md`), 'utf8');
      for (const tool of owned) if (referenced(text, tool)) promised.push(`${name}.md: ${tool}`);
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
