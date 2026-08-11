import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the prompts directory holding the `.md` templates. The build copies the repo-root
 * `prompts/` into `dist/prompts/`, so once compiled the templates sit next to this module
 * (`dist/prompts/*.md`). Running uncompiled from `src/prompts/`, they live at the repo root
 * (`<root>/prompts/`). Probe both so the loader works in dist (runtime) and src (tests/dev).
 */
function resolvePromptsDir(): string {
  const candidates = [here, join(here, '..', '..', 'prompts')];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'pilot.md'))) return dir;
  }
  // Fall back to the compiled-sibling location; readTemplate surfaces a clear error if it is wrong.
  return here;
}

const promptsDir = resolvePromptsDir();
const cache = new Map<string, string>();

/** Plugin template overlay: bare template name → absolute `.md` path. A registered name shadows the
 *  core file (resolution: user override → plugin file → core file); swapped whole on plugin reload. */
let pluginSources = new Map<string, string>();

/** Install the plugin prompt-source overlay (from the merged plugin registry). Drops the read cache for
 *  every name leaving OR entering the overlay so a reload re-resolves them from the right file. */
export function setPluginPromptSources(sources: ReadonlyMap<string, string>): void {
  for (const name of pluginSources.keys()) cache.delete(name);
  for (const name of sources.keys()) cache.delete(name);
  pluginSources = new Map(sources);
}

/** Absolute path to a file under the resolved prompts dir (works in dist + src). Single source for
 *  locating bundled prompt assets — e.g. the `skills/elowen-workflow/SKILL.md` master the skillService
 *  installs — so callers don't re-implement the dist/src probe. */
export function promptsPath(...segments: string[]): string {
  return join(promptsDir, ...segments);
}

/** Read a prompt template by name (without the `.md` suffix), trimmed and cached. */
function readTemplate(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(pluginSources.get(name) ?? join(promptsDir, `${name}.md`), 'utf-8').trim();
  cache.set(name, text);
  return text;
}

/** Drop the template cache so the next read re-loads from disk. For tests and on-disk edits. */
export function _resetPromptCache(): void { cache.clear(); }

export type PromptVars = Record<string, string>;

/**
 * Substitute every `{{key}}` token in `text` from `vars`. Literal `replaceAll` (no regex), so
 * placeholder values can contain any characters. Unreferenced placeholders are left untouched.
 * Shared by the file renderer here and the user-aware PromptService (which feeds an override's text).
 */
export function applyVars(text: string, vars: PromptVars = {}): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

/**
 * Render a prompt template: load `<name>.md` and substitute every `{{key}}` token from `vars`.
 * The file-only path (no user context) — the default and the fallback the PromptService resolves to.
 */
export function render(name: string, vars: PromptVars = {}): string {
  return applyVars(readTemplate(name), vars);
}

/** Load a raw template by name without substitution (e.g. the editable planner default). */
export function rawTemplate(name: string): string {
  return readTemplate(name);
}

/** Minimal structural view of {@link PromptService} (avoids an import cycle with promptService.ts). */
type UserAwareRenderer = { render(name: string, vars: PromptVars, userId?: number | null): string };

/** Render `name` through a user's overrides when a PromptService is present, else the file default —
 *  the single resolver every optional-`prompts`-dep call site shares (spawn preamble, guide), instead of
 *  re-spelling the `prompts ? prompts.render(...) : render(...)` fallback at each one. */
export function renderPromptFor(prompts: UserAwareRenderer | undefined, name: string, vars: PromptVars = {}, ownerId?: number | null): string {
  return prompts ? prompts.render(name, vars, ownerId) : render(name, vars);
}
