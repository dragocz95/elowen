import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentToolPolicy, toolPermitted } from '../../plugins/policyContext.js';

/** The minimal live-session surface the tool needs to read the registry and change the active slice —
 *  typed structurally (a subset of both PI's `AgentSession` and `ExtensionAPI`) so the search/activation
 *  logic stays unit-testable without a real session. */
export interface ToolActivationTarget {
  getAllTools(): { name: string; description?: string }[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
}

/** Per-session state shared between the composition path, the `ToolSearch` tool and `applyToolVisibility`.
 *  Created host-side at spawn (with the computed `deferred` set), then given its live `session` reference
 *  once PI has built it. `activated` accumulates the deferred tools the model has fetched so far, so every
 *  subsequent turn's visibility pass keeps them advertised. */
export interface ToolSearchHandle {
  /** Registered-tool names withheld from the initial active set (empty when deferral is inert). */
  readonly deferred: Set<string>;
  /** Deferred tools the model has already fetched via ToolSearch — re-added to the active set each turn. */
  readonly activated: Set<string>;
  /** The live PI session, wired once created; undefined until then (the tool reports a clear error). */
  session?: ToolActivationTarget;
}

/** Create a fresh handle for a session whose deferral policy withholds `deferred`. */
export function createToolSearchHandle(deferred: Set<string>): ToolSearchHandle {
  return { deferred, activated: new Set(), session: undefined };
}

/** The subset of a rehydrated `ToolResultMessage` this module reads. Kept structural (not the PI import)
 *  so the seed logic is unit-testable with plain objects. */
interface ToolResultLike { role?: string; toolName?: string; isError?: boolean; details?: unknown }

/** Re-seed `handle.activated` from rehydrated history so a RESPAWN (model switch, LRU revival, daemon
 *  restart) does not silently forget which deferred tools the model already fetched — otherwise the model,
 *  seeing its own past "Activated …" result, would call a tool that is back in the withheld state and get an
 *  unknown-tool error. Scans past ToolSearch results for their recorded `details.matched`, re-adding only
 *  names that are still deferred in THIS session (a tool no longer registered/deferred is simply dropped).
 *  Idempotent; the next visibility pass turns the re-seeded names back on. */
export function seedActivatedFromHistory(handle: ToolSearchHandle, messages: readonly unknown[]): void {
  if (handle.deferred.size === 0) return;
  for (const raw of messages) {
    const m = raw as ToolResultLike;
    if (m?.role !== 'toolResult' || m.toolName !== 'ToolSearch' || m.isError) continue;
    const matched = (m.details as { matched?: unknown } | undefined)?.matched;
    if (!Array.isArray(matched)) continue;
    for (const name of matched) {
      if (typeof name === 'string' && handle.deferred.has(name)) handle.activated.add(name);
    }
  }
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 25;
/** Hard cap on how many deferred tools the awareness block lists in the system prompt. Beyond this, a
 *  "…and N more" line points the model at keyword search — an unbounded block would defeat the whole point
 *  of deferral (a light prompt) exactly when it matters most (a huge MCP surface). */
const MAX_AWARENESS_LINES = 200;
const MAX_DESC_CHARS = 140;

/** Truncate to at most `max` Unicode code points (never splitting a surrogate pair, unlike String.slice,
 *  which counts UTF-16 code units and can leave a lone surrogate in the prompt). */
function clampCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

/** Split a bridged MCP tool name (`mcp__server__tool`) into lowercase search parts. Double and single
 *  underscores both separate — a server or tool fragment may itself contain `_`. */
function nameParts(name: string): string[] {
  return name
    .replace(/^mcp__/, '')
    .split(/__+/)
    .flatMap((seg) => seg.split('_'))
    .map((p) => p.toLowerCase())
    .filter(Boolean);
}

interface Candidate { name: string; description: string }

/** Score one candidate against the query terms. Exact name-part hit weighs most, then partial name-part,
 *  then a description substring — the same ordering Claude Code's ToolSearch uses, trimmed to what we need. */
function scoreCandidate(cand: Candidate, terms: string[]): number {
  const parts = nameParts(cand.name);
  const desc = cand.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (parts.includes(term)) score += 10;
    else if (parts.some((p) => p.includes(term))) score += 5;
    if (desc.includes(term)) score += 2;
  }
  return score;
}

/** Result of resolving a query against the deferred set: the tool names to activate. Pure — no side
 *  effects — so it is unit-testable in isolation from the session. */
export function resolveToolSearch(
  query: string,
  candidates: readonly Candidate[],
  maxResults: number,
): string[] {
  const trimmed = query.trim();

  // `select:A,B,C` — activate these exact deferred tools by name (case-insensitive). Capped at maxResults
  // like the keyword branch, so `select:` with a huge list cannot bypass the activation limit.
  const select = /^select:(.+)$/i.exec(trimmed);
  if (select) {
    const wanted = (select[1] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return candidates.filter((c) => wanted.includes(c.name.toLowerCase())).map((c) => c.name).slice(0, maxResults);
  }

  const q = trimmed.toLowerCase();
  // Exact-name fast path: the model typed a bare deferred-tool name instead of `select:` — fetch it
  // directly rather than running it through keyword scoring (which might rank a sibling higher).
  const exact = candidates.find((c) => c.name.toLowerCase() === q);
  if (exact) return [exact.name];
  // MCP namespace prefix: "mcp__github" → every deferred tool under that server, up to the cap. Lets the
  // model pull a whole server's toolset when it knows the integration but not the exact tool names.
  if (q.startsWith('mcp__') && q.length > 5) {
    const byPrefix = candidates.filter((c) => c.name.toLowerCase().startsWith(q)).map((c) => c.name).slice(0, maxResults);
    if (byPrefix.length > 0) return byPrefix;
  }

  const rawTerms = q.split(/\s+/).filter(Boolean);
  if (rawTerms.length === 0) return [];
  // `+term` marks a term as REQUIRED: a candidate must match it (in name parts or description) to qualify.
  const required = rawTerms.filter((t) => t.startsWith('+') && t.length > 1).map((t) => t.slice(1));
  const scoringTerms = rawTerms.map((t) => (t.startsWith('+') && t.length > 1 ? t.slice(1) : t));

  const eligible = candidates.filter((c) => {
    if (required.length === 0) return true;
    const parts = nameParts(c.name);
    const desc = c.description.toLowerCase();
    return required.every((term) => parts.some((p) => p.includes(term)) || desc.includes(term));
  });

  return eligible
    .map((c) => ({ name: c.name, score: scoreCandidate(c, scoringTerms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.name);
}

/** The `<available_tools_deferred>` awareness block appended to the system prompt: one line per deferred
 *  tool (name + trimmed description) so the model learns what it can fetch via ToolSearch WITHOUT carrying
 *  the full parameter schemas. Stable for the life of a session (the bridged MCP set does not change
 *  mid-session), so it is prompt-cache friendly. Returns '' when nothing is deferred. */
export function formatDeferredToolsBlock(
  all: readonly { name: string; description?: string }[],
  deferred: Set<string>,
): string {
  const deferredTools = all.filter((t) => deferred.has(t.name));
  if (deferredTools.length === 0) return '';
  const shown = deferredTools.slice(0, MAX_AWARENESS_LINES);
  const lines = shown.map((t) => {
    const desc = clampCodePoints((t.description ?? '').replace(/\s+/g, ' ').trim(), MAX_DESC_CHARS);
    return `- ${t.name}${desc ? `: ${desc}` : ''}`;
  });
  const overflow = deferredTools.length - shown.length;
  if (overflow > 0) {
    // Never list the whole set — the point is a light prompt. Keyword search still reaches the rest.
    lines.push(`- …and ${overflow} more deferred tool(s); use a ToolSearch keyword query to find them.`);
  }
  return [
    '<available_tools_deferred>',
    'These tools exist in this session but are advertised by NAME ONLY to keep the prompt light — their full',
    'parameter schema is withheld until you fetch it. To call one, first run ToolSearch (e.g.',
    'ToolSearch({"query":"select:<name>"}) or a keyword query); it becomes callable on your next turn.',
    ...lines,
    '</available_tools_deferred>',
  ].join('\n');
}

const ok = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text }], details });

/** The `ToolSearch` tool. Always active in the prompt; it fetches full schemas for deferred tools and
 *  activates them for the next turn via the handle's live session. Modelled on Claude Code's ToolSearch:
 *  `select:` for direct pick, keywords for search, `+term` for a required term. */
export function toolSearchTool(handle: ToolSearchHandle): ToolDefinition {
  return defineTool({
    name: 'ToolSearch',
    label: 'Search tools',
    description: [
      'Fetch full parameter schemas for deferred tools so you can call them. Some tools (bridged external',
      'MCP tools) are advertised by NAME ONLY in the <available_tools_deferred> block: until fetched, only',
      'the name is known — there is no parameter schema, so the tool cannot be invoked. This tool matches a',
      'query against the deferred list and activates the matches; they become callable ON YOUR NEXT TURN.',
      'Query forms:',
      '"select:mcp__github__create_issue,mcp__github__list_issues" — fetch these exact tools by name (a bare',
      'exact name works too); "mcp__github" — every deferred tool under that server; "github issue" —',
      'keyword search over names and descriptions, best matches up to max_results; "+github create" —',
      'require "github", rank by "create". If nothing is deferred this tool is a no-op.',
    ].join(' '),
    parameters: Type.Object({
      query: Type.String({ description: 'Keywords, or "select:<name>[,<name>...]" for an exact fetch, or "+term" to require a term.' }),
      max_results: Type.Optional(Type.Number({ description: `Max tools to activate (default ${DEFAULT_MAX_RESULTS}, capped at ${MAX_MAX_RESULTS}).` })),
    }),
    execute: async (_id, p: { query: string; max_results?: number }) => {
      const session = handle.session;
      if (!session) return ok('ToolSearch is not available in this session.');
      if (handle.deferred.size === 0) {
        return ok('No deferred tools in this session — every tool is already active and callable directly.');
      }
      const max = Math.max(1, Math.min(MAX_MAX_RESULTS, Math.floor(p.max_results ?? DEFAULT_MAX_RESULTS)));
      // Only deferred tools are searchable — an already-active tool needs no fetch.
      const candidates: Candidate[] = session.getAllTools()
        .filter((t) => handle.deferred.has(t.name))
        .map((t) => ({ name: t.name, description: t.description ?? '' }));
      const found = resolveToolSearch(p.query, candidates, max);
      // Defense in depth: only activate tools the ACTING sender is allowed to use. The execute-time gate
      // already refuses a forbidden call, and the per-turn visibility pass hides a forbidden tool again on
      // the next turn — but filtering here stops a forbidden tool's schema from being advertised at all and
      // stops a foreign/read-only caller from writing it into the shared `activated` set. Deferred tools are
      // bridged MCP (plugin) tools, so `toolPermitted` is the right predicate. No turn policy (tests) → allow.
      const tp = currentToolPolicy();
      const matched = tp ? found.filter((name) => toolPermitted(name, tp)) : found;
      if (matched.length === 0) {
        const why = found.length > 0
          ? `matched ${found.length} tool(s) but your permissions allow none of them`
          : `matched nothing`;
        return ok(`ToolSearch ${why} for "${p.query}". ${handle.deferred.size} tool(s) are deferred; try different keywords or "select:<exact-name>".`, { matched: [] });
      }
      // Record for future turns, then activate now. `activated` is the authoritative record the per-turn
      // applyToolVisibility reconciles against (it recomputes desired = visible ∩ (¬deferred ∪ activated)
      // each turn); the setActiveToolsByName here makes the tool self-contained — it takes effect on the
      // next agent turn (PI rebuilds the prompt on the boundary), which is why the result says so.
      for (const name of matched) handle.activated.add(name);
      const active = new Set(session.getActiveToolNames());
      for (const name of matched) active.add(name);
      session.setActiveToolsByName([...active]);
      return ok(`Activated ${matched.length} tool(s): ${matched.join(', ')}. They are callable on your next turn.`, { matched });
    },
  });
}
