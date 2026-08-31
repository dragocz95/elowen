import { estimateTokens, type AgentSession } from '@earendil-works/pi-coding-agent';
import type {
  BrainContextBreakdown,
  BrainContextCategory,
  BrainContextCategoryId,
  BrainContextToolCost,
} from '../shared/wireContract.js';
import { anthropicHostedReplayMetadata, isAnthropicServerOwnedBlock } from './session/anthropicHostedToolReplay.js';

/** PI's transcript message. `@earendil-works/pi-agent-core` (where the union lives) is not a direct
 *  dependency, so the type is pulled off the estimator we measure with — the same derivation
 *  turnBoundaryCompaction uses. */
export type ContextMessage = Parameters<typeof estimateTokens>[0];

/** One tool as the model currently sees it: the name, its description and its JSON parameter schema —
 *  everything that is serialized into the request's tool block. */
interface ContextToolSchema {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Everything the breakdown is computed from, lifted off a live session by {@link contextSnapshotOf}.
 *  A plain value object so the arithmetic can be exercised without constructing a PI session. */
export interface ContextSnapshot {
  model: string;
  contextWindow: number;
  /** The provider's authoritative context count for the last request; null when nothing was sent yet. */
  reportedTokens: number | null;
  systemPrompt: string;
  /** ACTIVE tools only — a deferred tool's schema is withheld from the prompt and costs nothing. */
  tools: readonly ContextToolSchema[];
  messages: readonly ContextMessage[];
  /** Context tokens at which auto-compaction fires; null when the session reports no threshold. */
  compactAtTokens: number | null;
}

/** Display order of the categories. Fixed rather than sorted by size so the same slice stays in the same
 *  place between two reads of the same conversation. */
const CATEGORY_ORDER: readonly BrainContextCategoryId[] = ['system', 'tools', 'user', 'assistant', 'toolResults', 'other'];

/** How many tool rows the ranking carries. Enough to name the real consumers, short enough for a modal. */
const MAX_TOOL_ROWS = 8;

/** Anthropic server-tool delta usage is cumulative billing usage, not the resident request size. Sessions
 * on that wire opt into the local structured estimate; every other provider keeps PI's native usage. */
const locallyEstimatedSessions = new WeakSet<AgentSession>();

export function useLocalResidentContextEstimate(session: AgentSession): void {
  locallyEstimatedSessions.add(session);
}

export function usesLocalResidentContextEstimate(session: AgentSession): boolean {
  return locallyEstimatedSessions.has(session);
}

/** PI's compaction heuristic (chars/4) applied to a raw string, so a tool schema, a system prompt and a
 *  message are all measured on ONE scale — `estimateTokens` uses exactly this formula per content block.
 *  It is an estimate by construction: the daemon has no tokenizer for the provider's vocabulary. */
function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function schemaTokensOf(tool: ContextToolSchema): number {
  const parameters = tool.parameters === undefined ? '' : JSON.stringify(tool.parameters);
  return textTokens(tool.name + (tool.description ?? '') + parameters);
}

/** The single resident-context ruler shared by status, the breakdown and Anthropic hosted-search
 * compaction checks. It measures the structured request inputs that remain resident; billing usage is
 * intentionally absent. */
function omittedHostedTokens(message: ContextMessage): number {
  const replay = anthropicHostedReplayMetadata(message as never);
  return replay?.content.reduce((sum, block) =>
    isAnthropicServerOwnedBlock(block) ? sum + textTokens(JSON.stringify(block)) : sum, 0) ?? 0;
}

export function estimateResidentContextTokens(
  snapshot: Pick<ContextSnapshot, 'systemPrompt' | 'tools' | 'messages'>,
): number {
  const messageTokens = snapshot.messages.reduce((total, message) =>
    total + estimateTokens(message) + omittedHostedTokens(message), 0);
  return textTokens(snapshot.systemPrompt)
    + snapshot.tools.reduce((total, tool) => total + schemaTokensOf(tool), 0)
    + messageTokens;
}

function share(tokens: number, contextWindow: number): number {
  return contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
}

function categoryOf(message: ContextMessage): BrainContextCategoryId {
  switch (message.role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'toolResult': return 'toolResults';
    // Compaction/branch summaries, extension-injected system messages and `!` bash echoes all occupy the
    // window without belonging to any of the above. They are grouped rather than each given a category:
    // a slice nobody can act on is noise, and 'other' still shows up when it grows.
    default: return 'other';
  }
}

/** Accumulate the per-tool lens: what each tool costs across the whole window. Deliberately NOT a
 *  partition of the categories — a tool's call arguments are also part of the assistant message that
 *  carries them. The categories answer "of what", this answers "because of which tool". */
function toolCosts(snapshot: ContextSnapshot): BrainContextToolCost[] {
  const rows = new Map<string, BrainContextToolCost>();
  const row = (name: string, active: boolean): BrainContextToolCost => {
    const existing = rows.get(name);
    if (existing) {
      if (active) existing.active = true;
      return existing;
    }
    const fresh: BrainContextToolCost = { name, schemaTokens: 0, callTokens: 0, resultTokens: 0, tokens: 0, percent: 0, active };
    rows.set(name, fresh);
    return fresh;
  };

  for (const tool of snapshot.tools) row(tool.name, true).schemaTokens += schemaTokensOf(tool);
  for (const message of snapshot.messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        row(block.name, false).callTokens += textTokens(block.name + JSON.stringify(block.arguments));
      }
      continue;
    }
    if (message.role === 'toolResult') row(message.toolName, false).resultTokens += estimateTokens(message);
  }

  return [...rows.values()]
    .map((tool) => ({ ...tool, tokens: tool.schemaTokens + tool.callTokens + tool.resultTokens }))
    .filter((tool) => tool.tokens > 0)
    .map((tool) => ({ ...tool, percent: share(tool.tokens, snapshot.contextWindow) }))
    // Name breaks ties so two equally sized tools keep a stable order between reads.
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
    .slice(0, MAX_TOOL_ROWS);
}

/** Turn a session snapshot into the structured "what is filling my window" answer: every measured
 *  category, the free remainder and the heaviest tools. Pure — no I/O, no rendering, no clock. */
export function buildContextBreakdown(snapshot: ContextSnapshot): BrainContextBreakdown {
  const tokens: Record<BrainContextCategoryId, number> = {
    system: textTokens(snapshot.systemPrompt),
    tools: snapshot.tools.reduce((total, tool) => total + schemaTokensOf(tool), 0),
    user: 0,
    assistant: 0,
    toolResults: 0,
    other: 0,
  };
  for (const message of snapshot.messages) {
    tokens[categoryOf(message)] += estimateTokens(message) + omittedHostedTokens(message);
  }

  const estimatedTokens = estimateResidentContextTokens(snapshot);
  // An empty category is omitted rather than sent as a zero: a renderer would otherwise draw a labelled
  // bar with no width, which reads as "measured and tiny" instead of "not present".
  const categories: BrainContextCategory[] = CATEGORY_ORDER
    .filter((id) => tokens[id] > 0)
    .map((id) => ({ id, tokens: tokens[id], percent: share(tokens[id], snapshot.contextWindow) }));
  const freeTokens = Math.max(0, snapshot.contextWindow - estimatedTokens);

  return {
    model: snapshot.model,
    contextWindow: snapshot.contextWindow,
    reportedTokens: snapshot.reportedTokens,
    estimatedTokens,
    percent: share(estimatedTokens, snapshot.contextWindow),
    categories,
    free: { tokens: freeTokens, percent: share(freeTokens, snapshot.contextWindow) },
    tools: toolCosts(snapshot),
    compactAtTokens: snapshot.compactAtTokens,
  };
}

function providerContextUsage(session: AgentSession): ReturnType<AgentSession['getContextUsage']> | undefined {
  try { return session.getContextUsage(); }
  catch { return undefined; }
}

function residentInputs(session: AgentSession, messages: readonly ContextMessage[] = session.messages): Pick<ContextSnapshot, 'systemPrompt' | 'tools' | 'messages'> {
  const active = new Set(session.getActiveToolNames());
  return {
    systemPrompt: session.systemPrompt,
    tools: session.getAllTools()
      .filter((tool) => active.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    messages,
  };
}

/** Local resident size only for sessions whose provider usage is known to be cumulative. Undefined means
 * the caller must retain its ordinary provider-backed behavior. */
export function localResidentContextTokens(
  session: AgentSession,
  messages: readonly ContextMessage[] = session.messages,
): number | undefined {
  return locallyEstimatedSessions.has(session) ? estimateResidentContextTokens(residentInputs(session, messages)) : undefined;
}

/** Statusline context usage with the same provider-specific ownership rule as compaction. Billing totals
 * remain read directly from message usage elsewhere. */
export function residentContextUsageOf(session: AgentSession): ReturnType<AgentSession['getContextUsage']> | undefined {
  const providerUsage = providerContextUsage(session);
  if (!locallyEstimatedSessions.has(session)) return providerUsage;
  const contextWindow = session.model?.contextWindow ?? providerUsage?.contextWindow ?? 0;
  if (contextWindow <= 0) return undefined;
  const tokens = estimateResidentContextTokens(residentInputs(session));
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

/** Read the breakdown inputs off a live PI session. The only impure step: everything it touches is a
 *  public read (`systemPrompt`, the tool registry, the transcript, the compaction settings), so building
 *  the report can never change what the next request sends. */
export function contextSnapshotOf(session: AgentSession, model: string): ContextSnapshot {
  const usage = residentContextUsageOf(session);
  const contextWindow = usage?.contextWindow ?? session.model?.contextWindow ?? 0;
  const compaction = session.settingsManager.getCompactionSettings();
  return {
    model,
    contextWindow,
    reportedTokens: usage?.tokens ?? null,
    ...residentInputs(session),
    // PI compacts once the context exceeds `contextWindow − reserveTokens`, so that difference IS the
    // threshold. Reported only when compaction is enabled and the window is known.
    compactAtTokens: compaction.enabled && contextWindow > 0 ? Math.max(0, contextWindow - compaction.reserveTokens) : null,
  };
}
