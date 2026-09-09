import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentContributionUserId, currentToolPolicy, toolOwnedByOtherAccount, toolVisibleUnderPolicy } from '../../plugins/policyContext.js';
import { logger } from '../../shared/logger.js';
import { collapseWhitespace, escapeRegExp } from '../../shared/text.js';

const log = logger('tool-search');

/** The minimal live-session surface the tool needs to read the registry and change the active slice —
 *  typed structurally (a subset of both PI's `AgentSession` and `ExtensionAPI`) so the search/activation
 *  logic stays unit-testable without a real session. */
export interface ToolActivationTarget {
  /** PI's live registry contains the final callable definitions after schema caps and `_reason` transforms. */
  getAllTools(): { name: string; description?: string; parameters?: unknown }[];
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
  /** Names registered by plugins; built-ins are subject only to an explicit deny, as in visibleToolNames. */
  readonly pluginNames?: ReadonlySet<string>;
  /** Which of the session's tools belong to individual ACCOUNTS — a shared room's composition (see
   *  PluginRegistry.sharedRoomToolOwners), absent on every session composed for one account. `activated` is
   *  session-wide and the schemas it publishes are read by whoever writes next, so the search has to apply
   *  ownership itself: without it, one member's `select:` would fetch a colleague's tool schema into the
   *  shared prompt for the rest of the conversation. */
  readonly personalToolOwners?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Optional search extensions wired by the spawner: semantic re-ranking and the live skill catalog.
   *  Both are read at CALL time, never captured at spawn. */
  readonly search?: ToolSearchExtras;
  /** The live PI session, wired once created; undefined until then (the tool reports a clear error). */
  session?: ToolActivationTarget;
}

/** One searchable skill entry — name and description only; a body is fetched later via SkillLoad. */
export interface SkillEntry {
  name: string;
  description: string;
}

/** The semantic half of a search: cosine scores (0..1) for the given documents, strongest implied by the
 *  value. Structurally satisfied by the daemon's `ToolSemanticIndex`; tests inject stubs. An empty map
 *  means "unavailable this time" (unconfigured model, timeout, endpoint error) — the caller falls back
 *  to keyword ranking. */
export interface SemanticRanker {
  rank(query: string, docs: readonly { id: string; text: string }[]): Promise<Map<string, number>>;
}

/** Search extensions the spawner wires onto a handle. The skills getter resolves the LIVE plugin
 *  registry per call (never a captured generation) and returns only the skills this turn may be told
 *  about — SkillLoad visible and model-invocable ones. */
export interface ToolSearchExtras {
  readonly semantic?: SemanticRanker;
  readonly skills?: () => Promise<readonly SkillEntry[]>;
}

/** Create a fresh handle for a session whose deferral policy withholds `deferred`. */
export function createToolSearchHandle(
  deferred: Set<string>,
  pluginNames?: ReadonlySet<string>,
  personalToolOwners?: ReadonlyMap<string, ReadonlySet<number>>,
  search?: ToolSearchExtras,
): ToolSearchHandle {
  return {
    deferred,
    activated: new Set(),
    pluginNames,
    ...(personalToolOwners ? { personalToolOwners } : {}),
    ...(search ? { search } : {}),
    session: undefined,
  };
}

/** The subset of a rehydrated message this module reads. Kept structural (not the PI import) so the seed
 *  logic is unit-testable with plain objects. `activatedTools` appears on a compaction summary: the names
 *  rolled onto the divider by the compaction that deleted the ToolSearch results themselves. */
interface ToolResultLike { role?: string; toolName?: string; isError?: boolean; details?: unknown; activatedTools?: unknown }

/** Re-seed `handle.activated` from rehydrated history so a RESPAWN (model switch, LRU revival, daemon
 *  restart) does not silently forget which deferred tools the model already fetched — otherwise the model,
 *  seeing its own past "Activated …" result, would call a tool that is back in the withheld state and get an
 *  unknown-tool error. Scans past ToolSearch results for their recorded `details.matched`, re-adding only
 *  names that are still deferred in THIS session (a tool no longer registered/deferred is simply dropped).
 *  Idempotent; the next visibility pass turns the re-seeded names back on.
 *
 *  Also reads the compaction summary's `activatedTools`. A compaction deletes the rows before its kept
 *  tail, so the ToolSearch result that activated a tool early in a long conversation is simply GONE from
 *  history — scanning only tool results would re-seed an empty set and un-advertise a tool the model is
 *  still using. The compaction rolls those names onto the divider for exactly this read. */
export function seedActivatedFromHistory(handle: ToolSearchHandle, messages: readonly unknown[]): void {
  if (handle.deferred.size === 0) return;
  const activate = (names: readonly unknown[]): void => {
    for (const name of names) {
      if (typeof name === 'string' && handle.deferred.has(name)) handle.activated.add(name);
    }
  };
  for (const raw of messages) {
    const m = raw as ToolResultLike;
    if (Array.isArray(m?.activatedTools)) { activate(m.activatedTools); continue; }
    if (m?.role !== 'toolResult' || m.toolName !== 'ToolSearch' || m.isError) continue;
    const matched = (m.details as { matched?: unknown } | undefined)?.matched;
    if (Array.isArray(matched)) activate(matched);
  }
}

/** Read the active set back after activating, and report anything PI silently refused. Two reasons this
 *  cannot be assumed to have worked: `setActiveToolsByName` keeps only names it finds in its tool REGISTRY
 *  and ignores the rest without erroring, and it replaces the whole set — so a name already active but no
 *  longer registered disappears in the same call. Both matter beyond the tool being uncallable, because
 *  PI records `addedToolNames` (the load point for native deferred-tool loading — Anthropic's
 *  `defer_loading`/`tool_reference` as well as OpenAI Responses' `tool_search_call`/`tool_search_output`)
 *  only when the set after the call is a strict superset of the set before it. A silent drop therefore
 *  also costs a full prompt-cache rewrite on the next request. Returns the names that failed to stick,
 *  for tests. */
export function verifyActivation(
  session: ToolActivationTarget,
  requested: ReadonlySet<string>,
  matched: readonly string[],
  activeBefore?: ReadonlySet<string>,
): string[] {
  const actual = new Set(session.getActiveToolNames());
  // A match that was ALREADY active adds nothing to the set, which is the other condition under which PI
  // records no `addedToolNames` — native deferred loading is skipped for this result on both providers
  // (no Anthropic tool_reference, no OpenAI tool_search_call/output items).
  // Worth its own line: it means the deferred set and the active set disagreed before the call.
  if (activeBefore && matched.length > 0 && matched.every((name) => activeBefore.has(name))) {
    log.warn(`activation was a no-op — ${matched.join(', ')} already active; deferred-tool loading will be skipped for this result`);
  }
  const missing = [...requested].filter((name) => !actual.has(name));
  if (missing.length === 0) return [];
  const wanted = missing.filter((name) => matched.includes(name));
  const lost = missing.filter((name) => !matched.includes(name));
  if (wanted.length > 0) {
    log.warn(`activation did not stick for ${wanted.length} tool(s): ${wanted.join(', ')} — not in PI's tool registry`);
  }
  if (lost.length > 0) {
    log.warn(`activating dropped ${lost.length} already-active tool(s): ${lost.join(', ')} — deferred-tool loading will be skipped for this result`);
  }
  return missing;
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

/** Split a tool name into lowercase search parts. MCP namespaces retain their prefix convenience,
 * while separators and CamelCase form searchable words. */
function nameParts(name: string): string[] {
  return name
    .replace(/^mcp__/, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
}

interface Candidate { name: string; description: string; parameterNames?: string }

const MAX_PARAMETER_NAMES = 128;
const MAX_PARAMETER_DEPTH = 6;
const MAX_PARAMETER_TEXT_CHARS = 2_048;

/** Extract only schema property names, never values or defaults. The live registry has already applied the
 * schema cap, but this traversal remains independently bounded because ToolSearch runs on the turn path and
 * plugin schemas are untrusted input. */
function schemaParameterNames(parameters: unknown): string {
  const names: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > MAX_PARAMETER_DEPTH || names.length >= MAX_PARAMETER_NAMES) return;
    if (seen.has(value)) return;
    seen.add(value);
    const schema = value as Record<string, unknown>;
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        names.push(name, ...nameParts(name));
        if (names.length >= MAX_PARAMETER_NAMES) break;
        visit(child, depth + 1);
      }
    }
    visit(schema.items, depth + 1);
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      const branches = schema[keyword];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, depth + 1);
    }
  };
  visit(parameters, 0);
  return clampCodePoints(names.join(' '), MAX_PARAMETER_TEXT_CHARS);
}

function candidateText(cand: Candidate): string {
  return `${cand.description} ${cand.parameterNames ?? ''}`.toLowerCase();
}

/** Pre-compile a word-boundary matcher (`\bterm\b`) per term, once per search. Word boundaries — not raw
 *  substring — for the DESCRIPTION channel: MCP descriptions are long prose, and a short query term as a
 *  substring produces false positives (`read`→"already"/"thread", `git`→"digit", `list`→"playlist") that,
 *  at the weight-2 tiebreak level, pick the wrong tool exactly when the name gave no signal. Matches Claude
 *  Code's compileTermPatterns. The known cost is missing inflections (`issue`≠"issues"), an accepted trade. */
function compileTermPatterns(terms: readonly string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
  }
  return patterns;
}

/** Whether a term names one of a tool's name parts, either whole or from its beginning. A name part is a
 *  WORD, so a term may complete it from the front but must never be matched somewhere inside it: a free
 *  substring made `load` hit `upload`, which is how "skill load" answered with a browser upload tool while
 *  the tool actually named SkillLoad ranked below it. Prefix keeps the useful half (`upl` → upload,
 *  `issue` → issues) and drops the accidental one. */
function namePartMatches(parts: readonly string[], term: string): boolean {
  return parts.some((p) => p.startsWith(term));
}

/** Score one candidate against the query terms. Exact name-part hit weighs most, then a name-part prefix,
 *  then a word-boundary DESCRIPTION hit — the same ordering Claude Code's ToolSearch uses, trimmed to what
 *  we need (no MCP-vs-non weighting: deferred tools may come from any source; no searchHint: PI tools have none). */
function scoreCandidate(cand: Candidate, terms: readonly string[], patterns: Map<string, RegExp>): number {
  const parts = nameParts(cand.name);
  const text = candidateText(cand);
  let score = 0;
  for (const term of terms) {
    if (parts.includes(term)) score += 10;
    else if (namePartMatches(parts, term)) score += 5;
    if (patterns.get(term)?.test(text)) score += 2;
  }
  return score;
}

/** The scoring machinery of one keyword query, parsed once and shared by the keyword search and the
 *  semantic blend so both can never disagree about what a term means. */
interface QueryTerms {
  /** `+term` marks a term as REQUIRED: a candidate must match it (in name parts or text) to qualify. */
  required: readonly string[];
  scoringTerms: readonly string[];
  patterns: Map<string, RegExp>;
}

function parseQueryTerms(query: string): QueryTerms | null {
  const rawTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (rawTerms.length === 0) return null;
  const required = rawTerms.filter((t) => t.startsWith('+') && t.length > 1).map((t) => t.slice(1));
  const scoringTerms = rawTerms.map((t) => (t.startsWith('+') && t.length > 1 ? t.slice(1) : t));
  return { required, scoringTerms, patterns: compileTermPatterns(scoringTerms) };
}

/** Whether `name`/`text` satisfies every REQUIRED term — the one eligibility rule for tools and skills
 *  alike, so a `+term` query restricts both channels identically. */
function requiredTermsSatisfied(name: string, text: string, terms: QueryTerms): boolean {
  if (terms.required.length === 0) return true;
  const parts = nameParts(name);
  return terms.required.every((term) => namePartMatches(parts, term) || terms.patterns.get(term)?.test(text));
}

/** Rank one candidate list: keyword score plus whatever the semantic half contributes, strongest first,
 *  capped. `semanticOf` returns the UNWEIGHTED cosine (0 when absent/unavailable). Pure and synchronous
 *  — the caller resolves the semantic scores beforehand. */
function blendCandidates(
  candidates: readonly Candidate[],
  terms: QueryTerms,
  semanticOf: (name: string) => number,
  maxResults: number,
): string[] {
  return candidates
    .map((c) => ({ name: c.name, score: scoreCandidate(c, terms.scoringTerms, terms.patterns) + semanticOf(c.name) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.name);
}

/** Result of resolving a query against the deferred set: the tool names to activate. Pure — no side
 *  effects — so it is unit-testable in isolation from the session. */
export function resolveToolSearch(
  query: string,
  candidates: readonly Candidate[],
  maxResults: number,
): string[] {
  const trimmed = query.trim();

  // `select:A,B,C` — activate these exact deferred tools by name (case-insensitive). The model named them
  // explicitly, so this uses the hard safety bound (MAX_MAX_RESULTS), not the keyword default — a normal
  // hand-listed set is never silently truncated; only a pathological list past the ceiling is capped.
  const select = /^select:(.+)$/i.exec(trimmed);
  if (select) {
    const wanted = (select[1] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return candidates.filter((c) => wanted.includes(c.name.toLowerCase())).map((c) => c.name).slice(0, MAX_MAX_RESULTS);
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

  const terms = parseQueryTerms(trimmed);
  if (!terms) return [];
  const eligible = candidates.filter((c) => requiredTermsSatisfied(c.name, candidateText(c), terms));
  return blendCandidates(eligible, terms, () => 0, maxResults);
}

/** Skill matches beyond this count are dropped — they are a pointer, not a result page. */
const MAX_SKILL_RESULTS = 3;

/** How much one point of cosine similarity adds to a keyword score. Calibrated against the keyword
 *  scale (name-part hit 10, prefix 5, description word 2): a strong semantic match (~0.9 → 2.7) outranks
 *  a single description-word hit but never a name hit, and vocabulary the model shares with the tool
 *  still dominates — semantics fill gaps, they do not overwrite exact words. */
const SEMANTIC_BOOST_WEIGHT = 3;

/** Whether resolveToolSearch answered this query from an EXACT path (`select:`, a bare name, an
 *  `mcp__` prefix with hits) rather than keyword scoring. Those are lookups where the model already
 *  named what it wants — the semantic half must never reorder or extend them. */
function isExactQuery(query: string, candidates: readonly Candidate[]): boolean {
  const trimmed = query.trim();
  if (/^select:(.+)$/i.test(trimmed)) return true;
  if (!trimmed) return false;
  const q = trimmed.toLowerCase();
  if (candidates.some((c) => c.name.toLowerCase() === q)) return true;
  return q.startsWith('mcp__') && q.length > 5 && candidates.some((c) => c.name.toLowerCase().startsWith(q));
}

/** The full resolution ONE ToolSearch call runs: the exact paths untouched, then a HYBRID keyword +
 *  semantic ranking for keyword queries, and the skill matches for the same query. Tools and skills
 *  share ONE semantic ranking (the index's per-call embedding budget), distinguished by id prefixes. */
async function resolveToolSearchHybrid(
  query: string,
  candidates: readonly Candidate[],
  skills: readonly SkillEntry[],
  maxResults: number,
  semantic?: SemanticRanker,
): Promise<{ tools: string[]; skills: SkillEntry[] }> {
  const found = resolveToolSearch(query, candidates, maxResults);
  const terms = parseQueryTerms(query);
  if (isExactQuery(query, candidates) || !terms) return { tools: found, skills: [] };

  const eligible = candidates.filter((c) => requiredTermsSatisfied(c.name, candidateText(c), terms));
  const eligibleSkills = skills.filter((s) => requiredTermsSatisfied(s.name, s.description.toLowerCase(), terms));

  // ONE semantic ranking per search, tools and skills together — the index embeds its misses in a
  // single batch, so splitting the channels would double that batch. An empty result (unconfigured
  // model, timeout, endpoint error) degrades both channels to the keyword answer below.
  const semanticScores = semantic && (eligible.length > 0 || eligibleSkills.length > 0)
    ? await semantic.rank(query, [
        // Name + description only, mirroring the skill channel: parameter names (the lexical channel
        // keeps them) diluted the semantic signal and changed the durable cache key on every schema edit.
        ...eligible.map((c) => ({ id: `tool:${c.name}`, text: `${c.name} ${c.description}` })),
        ...eligibleSkills.map((s) => ({ id: `skill:${s.name}`, text: `${s.name} ${s.description}` })),
      ])
    : new Map<string, number>();
  const contribution = (prefix: string) => (name: string) => (semanticScores.get(`${prefix}:${name}`) ?? 0) * SEMANTIC_BOOST_WEIGHT;

  return {
    tools: blendCandidates(eligible, terms, contribution('tool'), maxResults),
    skills: blendCandidates(
      eligibleSkills.map((s) => ({ name: s.name, description: s.description })),
      terms,
      contribution('skill'),
      MAX_SKILL_RESULTS,
    ).map((name) => eligibleSkills.find((s) => s.name === name)!).filter(Boolean),
  };
}

/** The `<available_tools_deferred>` awareness block appended to the system prompt: one line per deferred
 *  tool (name + trimmed description) so the model learns what it can fetch via ToolSearch WITHOUT carrying
 *  the full parameter schemas. Stable for the life of a session (the registered tool set does not change
 *  mid-session), so it is prompt-cache friendly. Returns '' when nothing is deferred. */
export function formatDeferredToolsBlock(
  all: readonly { name: string; description?: string }[],
  deferred: Set<string>,
): string {
  const deferredTools = all.filter((t) => deferred.has(t.name));
  if (deferredTools.length === 0) return '';
  const shown = deferredTools.slice(0, MAX_AWARENESS_LINES);
  const lines = shown.map((t) => {
    const name = escapeXmlText(t.name);
    const desc = escapeXmlText(clampCodePoints(collapseWhitespace(t.description ?? ''), MAX_DESC_CHARS));
    return `- ${name}${desc ? `: ${desc}` : ''}`;
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
    'ToolSearch({"query":"select:tool_name","max_results":5}) or a keyword query); it becomes callable in the',
    'next model step of this user turn.',
    ...lines,
    '</available_tools_deferred>',
  ].join('\n');
}

/** Hard cap on the hosted catalog block. Names are cheap (~3 tokens each), but an unbounded list on a huge
 *  MCP surface would defeat deferral; past this the block says how many are missing and the provider's own
 *  search still reaches them. */
const MAX_CATALOG_NAMES = 220;

/** The `<available_tool_catalog>` block for a PROVIDER-SIDE tool search session.
 *
 *  Hosted search withholds parameter schemas and — on Anthropic's BM25 variant — the tool list itself: the
 *  model starts the turn seeing only the search tool, so without this block it has to guess which words might
 *  match something. Both vendors call that guess out explicitly and recommend naming the available tool
 *  categories in the system prompt (Anthropic "Tool search tool" → Optimization tips; OpenAI "Function
 *  calling" → use the system prompt to say when each function applies).
 *
 *  Names only, grouped by the plugin that owns them: the group IS the namespace a single search matches, and
 *  a bare name costs ~3 tokens where a description costs fifty. The set is fixed at spawn, so this sits in the
 *  cache-friendly append region exactly like the deferred block. Withholding remains a PROMPT decision only —
 *  the execute-time permission and plan gates are unchanged, so listing a name grants nothing.
 *
 *  OWNER CHAT ONLY. This block is built once, from the session-wide tool set, but real visibility is
 *  per-SENDER: `applyToolVisibility` narrows the active tools to the acting sender's ToolPolicy each turn.
 *  A shared channel carries many senders with different roles, so a static list would name tools the
 *  current sender may not use, while the text promises the opposite. Owner chat has exactly one sender,
 *  who owns everything in it. Any other session kind returns ''. */
export function formatHostedToolCatalogBlock(
  all: readonly { name: string }[],
  toolOwner: ReadonlyMap<string, string>,
  sessionKind: 'owner-chat' | 'trusted-channel' | 'foreign-channel',
): string {
  if (sessionKind !== 'owner-chat' || all.length === 0) return '';
  const groups = new Map<string, string[]>();
  for (const tool of all.slice(0, MAX_CATALOG_NAMES)) {
    const owner = toolOwner.get(tool.name) ?? 'builtin';
    const names = groups.get(owner);
    if (names) names.push(tool.name);
    else groups.set(owner, [tool.name]);
  }
  const lines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, names]) => `- ${escapeXmlText(owner)} (${names.length}): ${[...names]
      .sort((a, b) => a.localeCompare(b)).map(escapeXmlText).join(', ')}`);
  const overflow = all.length - Math.min(all.length, MAX_CATALOG_NAMES);
  if (overflow > 0) lines.push(`- …and ${overflow} more tool(s) reachable only through a search query.`);
  return [
    '<available_tool_catalog>',
    'Every tool listed here is available to you in this session, but this prompt carries only its NAME — the',
    'parameter schema is loaded on demand when you search for it. Search before you conclude that a capability',
    'is missing: the search matches tool names, descriptions and parameter names, so a plain-language query',
    'such as "create a channel" or "schedule a recurring report" finds the right one. The groups below are the',
    'namespaces a single query can match.',
    ...lines,
    '</available_tool_catalog>',
  ].join('\n');
}

/** The exact tool names a query TARGETS by name (not by fuzzy search): the `select:` list, or a bare
 *  single-token query. Empty for a multi-word keyword query (that is a search, not a name request). Used to
 *  detect a re-selection of an already-active tool and to answer about a name this session does not hold.
 *  Returned AS TYPED, because those answers quote the name back and matching is case-insensitive anyway —
 *  callers lowercase where they compare. */
export function requestedExactNames(query: string): string[] {
  const trimmed = query.trim();
  const select = /^select:(.+)$/i.exec(trimmed);
  if (select) return (select[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return trimmed && !/\s/.test(trimmed) ? [trimmed] : [];
}

const ok = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text }], details });

function sanitizeXmlText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '\uFFFD');
}

function escapeXmlText(text: string): string {
  // XML 1.0 rejects most C0 controls even when they came from otherwise valid JavaScript strings. Replace
  // them before escaping metacharacters so every dynamic block remains parseable by a real XML parser.
  return sanitizeXmlText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeXmlData(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'string') return sanitizeXmlText(value);
  if (!value || typeof value !== 'object') return value;
  const known = seen.get(value);
  if (known) return known;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(sanitizeXmlData(item, seen));
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[sanitizeXmlText(key)] = sanitizeXmlData(item, seen);
  }
  return out;
}

/** Serialize the definitions PI can actually call, not the pre-transform plugin schemas. Escaping the
 * complete JSON payload prevents an authored description from closing the function/XML block. */
export function formatToolSearchFunctions(
  tools: readonly { name: string; description?: string; parameters?: unknown }[],
  names: readonly string[],
): string {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const lines = names
    .map((name) => byName.get(name))
    .filter((tool): tool is { name: string; description?: string; parameters?: unknown } => tool !== undefined)
    .map((tool) => escapeXmlText(JSON.stringify(sanitizeXmlData({
      description: tool.description ?? '',
      name: tool.name,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }))))
    .map((definition) => `<function>${definition}</function>`);
  return ['<functions>', ...lines, '</functions>'].join('\n');
}

/** The `ToolSearch` tool. Always active in the prompt; it fetches full schemas for deferred tools and
 *  activates them before the next model step via the handle's live session. Modelled on Claude Code's
 *  ToolSearch: `select:` for direct pick, keywords for search, `+term` for a required term. */
export function toolSearchTool(handle: ToolSearchHandle): ToolDefinition {
  return defineTool({
    name: 'ToolSearch',
    label: 'Search tools',
    description: [
      'Fetch full schema definitions for deferred tools so they can be called. Deferred tools are advertised by',
      'NAME ONLY in the <available_tools_deferred> block: until fetched, only the name is known and calling one',
      'fails validation. Matching definitions are returned inside a <functions> block and become callable in the',
      'next model step of this same user turn. Query forms:',
      '"select:DiscordCreateChannel,mcp__github__create_issue" — fetch these exact tools by name (a bare exact',
      'name works too); "mcp__github" — every deferred tool under that bridged MCP server; "discord channel" —',
      'keyword search over names, descriptions and bounded nested parameter names, best matches up to max_results; "+github create" — require',
      '"github", rank by "create". If nothing is deferred this tool is a no-op.',
    ].join(' '),
    parameters: Type.Object({
      query: Type.String({ description: 'Keywords, or "select:<name>[,<name>...]" for an exact fetch, or "+term" to require a term.' }),
      max_results: Type.Number({
        minimum: 1,
        maximum: MAX_MAX_RESULTS,
        default: DEFAULT_MAX_RESULTS,
        description: `Keyword result limit. Explicit select:<name> queries ignore this limit but remain capped at ${MAX_MAX_RESULTS} for safety.`,
      }),
    }, { additionalProperties: false }),
    execute: async (_id, p: { query: string; max_results: number }) => {
      const session = handle.session;
      if (!session) return ok('ToolSearch is not available in this session.');
      if (handle.deferred.size === 0) {
        return ok('No deferred tools in this session — every tool is already active and callable directly.');
      }
      const max = Math.max(1, Math.min(MAX_MAX_RESULTS, Math.floor(p.max_results ?? DEFAULT_MAX_RESULTS)));
      // WHOSE tools this turn may reach at all. In a room the composed set spans every account, and the
      // name of somebody's personal MCP server is itself private — so ownership is applied before the
      // search runs, not only when the call is made. Without it a member could `select:` a colleague's
      // tool: the answer names it, the schema lands in the shared prompt, and `activated` keeps it there.
      const personal = handle.personalToolOwners
        ? { owners: handle.personalToolOwners, contributionUserId: currentContributionUserId() }
        : undefined;
      // Same for the turn's tool policy: it is a CANDIDATE filter, applied BEFORE the search ranks. A
      // forbidden tool that outscored every allowed one used to consume the max_results budget and push
      // the permitted tool out of the result — with max_results 1 the model was told "your permissions
      // allow none of them" while a perfectly reachable tool existed. Read the exact same plugin/allow
      // and wildcard-deny predicate as `visibleToolNames`, so immediate visibility and deferred schema
      // visibility cannot disagree. No turn policy (tests) means allow.
      const tp = currentToolPolicy();
      const visibleHere = (name: string) => toolVisibleUnderPolicy(name, handle.pluginNames?.has(name) === true, tp);
      // Only deferred tools are searchable — an already-active tool needs no fetch.
      const candidates: Candidate[] = session.getAllTools()
        .filter((t) => handle.deferred.has(t.name) && !toolOwnedByOtherAccount(t.name, personal) && visibleHere(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? '',
          parameterNames: schemaParameterNames(t.parameters),
        }));
      // Keyword queries rank HYBRID: keyword scores plus the daemon's semantic index when wired (exact
      // lookups — select:, bare name, mcp__ prefix — bypass semantics entirely). Skills ride the same
      // search and are REPORTED, never activated: a match is a pointer at SkillLoad, nothing more.
      const skillEntries = handle.search?.skills ? await handle.search.skills() : [];
      const { tools: found, skills: skillHits } = await resolveToolSearchHybrid(p.query, candidates, skillEntries, max, handle.search?.semantic);
      const skillNote = skillHits.length
        ? `\nRelated skills: ${skillHits.map((s) => s.name).join(', ')} — load one with SkillLoad(name) for its full instructions.`
        : '';
      const skillDetails = skillHits.length ? { skills: skillHits.map((s) => s.name) } : {};
      // Defense in depth: only activate tools the ACTING sender is allowed to use. The execute-time gate
      // already refuses a forbidden call, and the per-turn visibility pass hides a forbidden tool again on
      // the next turn — but filtering here stops a forbidden tool's schema from being advertised at all and
      // stops a foreign/read-only caller from writing it into the shared `activated` set.
      const matched = found.filter(visibleHere);
      if (matched.length === 0) {
        // A query that named tools EXACTLY deserves an exact answer, and three different facts used to hide
        // behind one "matched nothing": the name is ALREADY active (common after compaction/respawn, where
        // the model's own history says "Activated …"), it is composed but hidden by this turn's policy — so
        // the execute gate would refuse the call and calling it active is simply untrue — or this session
        // holds no such tool at all. Only the first case is a reason to try other keywords, and the last two
        // are why a model that was told "already active" kept looking for a way to call a tool it never had.
        //
        // The registry is read only for names the CALLER typed, so an answer repeats what the query already
        // contained and never enumerates tools this sender may not hold.
        if (found.length === 0) {
          const wanted = requestedExactNames(p.query).map((name) => name.toLowerCase());
          const registry = session.getAllTools();
          // Same ownership filter as the candidate list: this branch reads the REGISTERED set, which in a
          // room holds every account's tools, so without it the fallback would confirm the existence of a
          // colleague's tool by name. Such a name lands in none of the three groups below and falls through
          // to the non-committal answer, exactly as before.
          const named = wanted.length
            ? registry.filter((t) => wanted.includes(t.name.toLowerCase()) && !handle.deferred.has(t.name)
              && !toolOwnedByOtherAccount(t.name, personal))
            : [];
          const alreadyActive = named.filter((t) => visibleHere(t.name)).map((t) => t.name);
          const forbidden = named.filter((t) => !visibleHere(t.name)).map((t) => t.name);
          // Measured against the WHOLE registry, ownership included: a colleague's tool exists, so it must
          // not be reported as nonexistent either.
          const unknown = requestedExactNames(p.query)
            .filter((name) => !registry.some((t) => t.name.toLowerCase() === name.toLowerCase()));
          const clauses: string[] = [];
          if (alreadyActive.length) {
            const one = alreadyActive.length === 1;
            clauses.push(`${alreadyActive.join(', ')} ${one ? 'is' : 'are'} already active — call ${one ? 'it' : 'them'} directly; no ToolSearch needed.`);
          }
          if (forbidden.length) {
            const one = forbidden.length === 1;
            clauses.push(`${forbidden.join(', ')} ${one ? 'is' : 'are'} not available in this session — the active tool policy does not permit ${one ? 'it' : 'them'}.`);
          }
          if (unknown.length) {
            clauses.push(`No tool named ${unknown.join(', ')} exists in this session. ${handle.deferred.size} tool(s) are deferred; try different keywords if that was a search.`);
          }
          if (clauses.length) {
            // Skill matches ride every keyword answer, this exact-name one included: a bare query that
            // names no tool but IS a skill ("runbook") would otherwise drop the pointer at SkillLoad.
            return ok(`${clauses.join(' ')}${skillNote}`, {
              matched: [],
              ...skillDetails,
              ...(alreadyActive.length ? { alreadyActive } : {}),
              ...(forbidden.length ? { unavailable: forbidden } : {}),
              ...(unknown.length ? { unknown } : {}),
            });
          }
        }
        const why = found.length > 0
          ? `matched ${found.length} tool(s) but your permissions allow none of them`
          : `matched nothing`;
        return ok(`ToolSearch ${why} for "${p.query}". ${handle.deferred.size} tool(s) are deferred; try different keywords or "select:<exact-name>".${skillNote}`, { matched: [], ...skillDetails });
      }
      // Record for future turns, then activate now. `activated` is the authoritative record the per-turn
      // applyToolVisibility reconciles against (it recomputes desired = visible ∩ (¬deferred ∪ activated)
      // each turn); setActiveToolsByName updates PI's live slice before the agent loop builds the next model
      // request, so the tool is callable in the next model step of this same user turn.
      const before = new Set(session.getActiveToolNames());
      const active = new Set(before);
      for (const name of matched) active.add(name);
      session.setActiveToolsByName([...active]);
      // Record only what ACTUALLY stuck. `activated` is the authoritative record applyToolVisibility
      // reconciles against every turn and a respawn re-seeds from, so a name that silently failed to
      // register would be re-asserted for the rest of the conversation while staying uncallable — and the
      // model, told it succeeded, would keep calling a tool that is not there.
      const missing = new Set(verifyActivation(session, active, matched, before));
      const stuck = matched.filter((name) => !missing.has(name));
      for (const name of stuck) handle.activated.add(name);
      if (stuck.length === 0) {
        return ok(`ToolSearch could not activate ${matched.join(', ')} — the tool(s) are not in this session's registry. Proceed without them.`, { matched: [] });
      }
      const failed = matched.filter((name) => missing.has(name));
      const functions = formatToolSearchFunctions(session.getAllTools(), stuck);
      const note = failed.length
        ? `\n${failed.join(', ')} could NOT be activated — proceed without ${failed.length === 1 ? 'it' : 'them'}.`
        : '';
      return ok(`${functions}${note}${skillNote}`, { matched: stuck, ...skillDetails });
    },
  });
}
