import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadAgentRegistry, parseAgentFile, NAME_RE } from './agentRegistry.js';
import { builtinToolMetas } from '../tools/index.js';
import type { PluginAgentCatalog, AgentCatalogEntry, AgentCatalogResult } from '../../plugins/api.js';

/** The core-owned editor over the typed sub-agent catalog (one `.md` per agent: frontmatter
 *  name/description/tools + a body prompt). Built-in explore/plan ship in dist/prompts/agents and are
 *  read-only; user agents live next to the DB in <config>/agents. The catalog FORMAT — and therefore
 *  its validation — is core's (agentRegistry parses these files for delegation), so the editor lives
 *  here too; the subagent plugin serves the HTTP surface over it via ctx.host.agentCatalog(). */
export function makeAgentCatalog(opts: {
  builtinDir: string;
  /** Absent for an in-memory DB (tests) — writes then answer 503. */
  userDir?: string;
  /** Tool names of the LIVE merged plugin registry — resolved per save so a reload is picked up. */
  pluginToolNames: () => Promise<string[]>;
}): PluginAgentCatalog {
  const isBuiltin = (name: string): boolean => existsSync(join(opts.builtinDir, `${name}.md`));
  // Normalize the tools spec: a preset keyword, or an explicit tool-name list.
  const agentToolsValue = (tools: unknown): string | string[] => {
    if (Array.isArray(tools)) return tools.map((t) => String(t).trim()).filter(Boolean);
    const v = typeof tools === 'string' ? tools.trim() : '';
    return v || 'inherit';
  };
  // Serialize the frontmatter via the YAML library, NOT string interpolation — a description containing
  // a colon-space or a leading '#' (both common) would otherwise produce invalid YAML that
  // parseAgentFile rejects, blocking a legitimate save with a misleading error.
  const buildAgentBody = (name: string, description: string, tools: unknown, body: string): string => {
    const frontmatter = stringifyYaml({ name, description: description.replaceAll('\n', ' '), tools: agentToolsValue(tools) }).trimEnd();
    return `---\n${frontmatter}\n---\n\n${body.trim()}\n`;
  };

  return {
    list(): AgentCatalogEntry[] {
      const reg = loadAgentRegistry({ builtinDir: opts.builtinDir, userDir: opts.userDir });
      // A user file body is returned so the editor can prefill; built-in bodies are read-only, so they
      // are left off the payload (and kept smaller).
      return [...reg.values()].map((a) => ({
        name: a.name,
        description: a.description,
        tools: a.toolsSpec,
        source: a.source,
        canDelete: a.source === 'user',
        ...(a.source === 'user' ? { body: a.body } : {}),
      }));
    },

    // Create or overwrite a user sub-agent. A name shadowing a built-in is refused (built-ins are
    // read-only); the composed file is validated with the real registry parser before it is written, so
    // an invalid tools spec / frontmatter never lands on disk.
    async save(name, input): Promise<AgentCatalogResult> {
      if (!NAME_RE.test(name)) return { error: 'name must be kebab-case (a-z, 0-9, dashes), max 64 chars', status: 400 };
      if (isBuiltin(name)) return { error: `a built-in agent named "${name}" already exists and is read-only`, status: 400 };
      if (!opts.userDir) return { error: 'agents dir unavailable', status: 503 };
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (description === '' || body.trim() === '') return { error: 'description and body must be non-empty', status: 400 };
      // Bound both fields so a single agent file cannot be grown without limit (the description rides
      // the sub-agent catalog in every delegate tool description; the body becomes the child's system
      // prompt).
      if (description.length > 4096) return { error: 'description must be at most 4096 characters', status: 400 };
      if (body.length > 65536) return { error: 'body must be at most 65536 characters', status: 400 };
      // An explicit tool list must name tools that actually exist — an unknown name is not a narrower
      // toolset, it silently no-ops at delegation-time intersection and leaves the child unable to act.
      // Validate against the LIVE toolset: the native brain tools (Elowen*/Memory*) plus every plugin
      // tool in the merged registry. Preset keywords (read-only/all/inherit) arrive as a string, not an
      // array, and are validated by parseAgentFile below instead.
      if (Array.isArray(input.tools)) {
        const known = new Set<string>([
          ...builtinToolMetas().map((m) => m.name),
          ...(await opts.pluginToolNames()),
        ]);
        const requested = input.tools.map((t) => String(t).trim()).filter(Boolean);
        const unknownTools = requested.filter((toolName) => !known.has(toolName));
        if (unknownTools.length) return { error: `unknown tool(s): ${unknownTools.join(', ')}`, status: 400 };
      }
      const composed = buildAgentBody(name, description, input.tools, body);
      if (!parseAgentFile(composed, 'user', join(opts.userDir, `${name}.md`))) {
        return { error: 'invalid agent definition — check the tools value (read-only / all / inherit or a tool list) and the body', status: 400 };
      }
      mkdirSync(opts.userDir, { recursive: true });
      writeFileSync(join(opts.userDir, `${name}.md`), composed, 'utf-8');
      return { ok: true };
    },

    remove(name): AgentCatalogResult {
      if (!NAME_RE.test(name)) return { error: 'invalid agent name', status: 400 };
      if (isBuiltin(name)) return { error: 'built-in agents cannot be deleted', status: 400 };
      const file = opts.userDir ? join(opts.userDir, `${name}.md`) : null;
      if (!file || !existsSync(file)) return { error: 'unknown agent', status: 404 };
      unlinkSync(file);
      return { ok: true };
    },
  };
}
