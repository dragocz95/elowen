import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PluginLogger } from '../../plugins/api.js';

/**
 * Typed sub-agents defined by markdown files. Each `.md` is one agent type: YAML frontmatter
 * (`name`/`description`/`tools`/`model`) plus a body that becomes the child's system prompt. Built-in
 * types ship in `prompts/agents/`; a user adds their own in `<config>/agents/`, overriding a built-in of
 * the same name. All of the type logic lives here (host-side TS) so it is unit-testable — the subagent
 * plugin only forwards the chosen `subagent_type`.
 */

/** The read-only agent toolset: the look-but-never-touch tools PLUS Bash (gated to read-only commands by
 *  the minted permission boundary — see readOnlyBoundary.ts). The SINGLE source of "read-only" for delegated
 *  children: both a read-only agent TYPE and a bare `read_only` delegation resolve to this list host-side (in
 *  brain/platforms.ts), so the subagent plugin no longer carries its own copy. Bash is here because an
 *  unattended read-only agent may run read-only shell — the boundary, not this list, keeps it look-only. */
export const READ_ONLY_AGENT_TOOLS: readonly string[] = [
  'Read', 'Search', 'ListDir', 'FileInfo', 'GitStatus', 'CodebaseSearch', 'CodebaseStatus', 'Bash',
];

/** How an agent's `tools:` frontmatter resolves. `read-only` → the read-only toolset above with a minted
 *  read-only boundary; `inherit`/`all` → no restriction (the child keeps the caller's scope); an explicit
 *  list → exactly those tools. */
type AgentToolsSpec = 'read-only' | 'all' | 'inherit' | string[];

export interface AgentDef {
  name: string;
  description: string;
  /** System-prompt body (unrendered — placeholders are resolved by renderAgentPrompt at use time). */
  body: string;
  toolsSpec: AgentToolsSpec;
  source: 'builtin' | 'user';
  filePath: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Split the leading `---\n…\n---` YAML frontmatter from the markdown body. Returns null when there is no
 *  frontmatter block (an agent file must have one — it carries name + description). */
function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const m = /^﻿?---\s*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(text);
  if (!m) return null;
  return { frontmatter: m[1] ?? '', body: (m[2] ?? '').trim() };
}

/** Normalize the `tools:` frontmatter value into an AgentToolsSpec. A missing value inherits (today's
 *  generic behavior). An empty/invalid list is rejected (return null) rather than silently widened. */
function parseToolsSpec(raw: unknown): AgentToolsSpec | null {
  if (raw === undefined || raw === null) return 'inherit';
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'read-only' || v === 'readonly') return 'read-only';
    if (v === 'all') return 'all';
    if (v === 'inherit') return 'inherit';
    return null;
  }
  if (Array.isArray(raw)) {
    const names = [...new Set(raw.map((t) => String(t ?? '').trim()).filter(Boolean))];
    return names.length ? names : null;
  }
  return null;
}

/** Parse one agent `.md` file into an AgentDef, or null when it is not a valid agent definition (no
 *  frontmatter, bad name, missing description, malformed tools). Never throws on a bad file — the caller
 *  logs and skips it. */
export function parseAgentFile(text: string, source: 'builtin' | 'user', filePath: string): AgentDef | null {
  const split = splitFrontmatter(text);
  if (!split) return null;
  let fm: unknown;
  try { fm = parseYaml(split.frontmatter); } catch { return null; }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null;
  const meta = fm as Record<string, unknown>;

  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!NAME_RE.test(name)) return null;
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!description) return null;
  const toolsSpec = parseToolsSpec(meta.tools);
  if (toolsSpec === null) return null;
  if (!split.body) return null;

  return { name, description, body: split.body, toolsSpec, source, filePath };
}

/** Load and merge agent definitions from the built-in dir first, then the user dir — a user file
 *  overrides a built-in of the same name (loaded last wins). A malformed file is skipped and logged;
 *  one bad `.md` never breaks the rest. */
export function loadAgentRegistry(opts: {
  builtinDir?: string;
  userDir?: string;
  logger?: Pick<PluginLogger, 'warn'>;
}): Map<string, AgentDef> {
  const map = new Map<string, AgentDef>();
  for (const { dir, source } of [
    { dir: opts.builtinDir, source: 'builtin' as const },
    { dir: opts.userDir, source: 'user' as const },
  ]) {
    if (!dir || !existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(dir, file);
      try {
        if (!statSync(filePath).isFile()) continue;
        const def = parseAgentFile(readFileSync(filePath, 'utf-8'), source, filePath);
        if (def) map.set(def.name, def);
        else opts.logger?.warn(`agent file skipped (invalid frontmatter): ${filePath}`);
      } catch (e) {
        opts.logger?.warn(`agent file skipped: ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return map;
}

/** Resolve an agent's tool allow-list: undefined = no restriction (inherit the caller's scope), else the
 *  exact allow-list the child is narrowed to. */
export function resolveAgentTools(def: AgentDef): readonly string[] | undefined {
  if (def.toolsSpec === 'read-only') return READ_ONLY_AGENT_TOOLS;
  if (def.toolsSpec === 'all' || def.toolsSpec === 'inherit') return undefined;
  return def.toolsSpec;
}

/** The catalog the subagent plugin advertises in its tool description (name + one-line description). */
export function agentCatalog(reg: Map<string, AgentDef>): { name: string; description: string }[] {
  return [...reg.values()].map((d) => ({ name: d.name, description: d.description }));
}
