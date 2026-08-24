import type { ToolDeferralOverrides, ToolLoadingMode } from '../../shared/wireContract.js';

/** Prefix every bridged external MCP tool carries (see the mcp plugin's registerBridgedTool). */
export const MCP_TOOL_PREFIX = 'mcp__';

/** Tools on the core interaction path must always remain active. Patterns are exact or prefix*. */
const NEVER_DEFER: readonly string[] = [
  'ToolSearch',
  'Read', 'Edit', 'Write', 'Search', 'Grep', 'Glob', 'ListDir', 'FileInfo', 'GitStatus',
  'Bash', 'ListProcesses', 'ProcessOutput', 'KillProcess',
  'AskUserQuestion', 'ShareImage', 'ShareFile', 'ExitPlanMode', 'Todo*',
  'Elowen*', 'Memory*', 'Lsp*', 'Delegate*', 'Workflow*',
];

/** Below 11 unresolved MCP tools, automatic MCP deferral stays off. */
export const DEFAULT_DEFER_THRESHOLD = 10;

export interface DeferralOptions {
  enabled?: boolean;
  threshold?: number;
}

export interface ToolDeferralCandidate {
  name: string;
  sourceId: string;
  planSafe: boolean;
  defaultDeferred: boolean;
  /** The accounts this tool belongs to, when it is one or more accounts' PERSONAL tool rather than an
   *  instance-wide one — set only by a shared room, which composes several people's owner-scoped tools into
   *  a set no single turn is ever shown (each turn is narrowed to the writer's own). Absent everywhere
   *  else. Read only by the automatic-MCP threshold, which must count what ONE writer faces. */
  owners?: ReadonlySet<number>;
}

export type ToolDeferralReason =
  | 'global-disabled'
  | 'never-defer'
  | 'plan-safe'
  | 'tool-override'
  | 'source-override'
  | 'source-default'
  | 'mcp-threshold'
  | 'default-immediate';

export interface ToolDeferralDecision {
  name: string;
  effective: ToolLoadingMode;
  reason: ToolDeferralReason;
}

/** True when name matches an exact entry or a prefix* entry of NEVER_DEFER. */
export function isNeverDeferred(name: string): boolean {
  for (const pattern of NEVER_DEFER) {
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

/** Source-agnostic eligibility. Plan-safe locking is candidate metadata resolved by the shared policy. */
export function isDeferrable(name: string): boolean {
  return !isNeverDeferred(name);
}

function configurableDecision(
  candidate: ToolDeferralCandidate,
  overrides: ToolDeferralOverrides | undefined,
): ToolDeferralDecision | undefined {
  const toolOverride = overrides?.tools[candidate.sourceId]?.[candidate.name];
  if (toolOverride) {
    return { name: candidate.name, effective: toolOverride, reason: 'tool-override' };
  }

  const sourceOverride = overrides?.sources[candidate.sourceId];
  if (sourceOverride) {
    return { name: candidate.name, effective: sourceOverride, reason: 'source-override' };
  }

  if (candidate.defaultDeferred) {
    return { name: candidate.name, effective: 'deferred', reason: 'source-default' };
  }

  return undefined;
}

/** How many unresolved MCP tools the WORST-OFF single writer actually faces: every instance-wide one, plus
 *  the personal tools of whichever account owns the most. The threshold asks "is this prompt heavy with MCP
 *  tools?", and in a shared room the composed set answers for several people at once — each turn is narrowed
 *  to the writer's own tools before the prompt is built, so counting the union would defer a room's tools at
 *  a size no writer ever sees. Outside a room no candidate carries owners and this is a plain count. */
function worstCaseWriterMcpCount(candidates: readonly ToolDeferralCandidate[]): number {
  let instance = 0;
  const perOwner = new Map<number, number>();
  for (const candidate of candidates) {
    if (!candidate.owners || candidate.owners.size === 0) { instance++; continue; }
    for (const owner of candidate.owners) perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
  }
  return instance + Math.max(0, ...perOwner.values());
}

/** Resolve the single runtime/UI policy in precedence order while preserving candidate order. */
export function resolveToolDeferralDecisions(
  candidates: readonly ToolDeferralCandidate[],
  overrides?: ToolDeferralOverrides,
  options: DeferralOptions = {},
): ToolDeferralDecision[] {
  if (options.enabled === false) {
    return candidates.map(({ name }) => ({ name, effective: 'immediate', reason: 'global-disabled' }));
  }

  const unresolvedMcp = candidates.filter((candidate) => {
    if (isNeverDeferred(candidate.name) || candidate.planSafe) return false;
    if (configurableDecision(candidate, overrides)) return false;
    return candidate.name.startsWith(MCP_TOOL_PREFIX);
  });
  const deferAutomaticMcp = worstCaseWriterMcpCount(unresolvedMcp) > (options.threshold ?? DEFAULT_DEFER_THRESHOLD);

  return candidates.map((candidate): ToolDeferralDecision => {
    if (isNeverDeferred(candidate.name)) {
      return { name: candidate.name, effective: 'immediate', reason: 'never-defer' };
    }
    if (candidate.planSafe) {
      return { name: candidate.name, effective: 'immediate', reason: 'plan-safe' };
    }

    const configured = configurableDecision(candidate, overrides);
    if (configured) return configured;

    if (candidate.name.startsWith(MCP_TOOL_PREFIX)) {
      return {
        name: candidate.name,
        effective: deferAutomaticMcp ? 'deferred' : 'immediate',
        reason: 'mcp-threshold',
      };
    }

    return { name: candidate.name, effective: 'immediate', reason: 'default-immediate' };
  });
}

/** Select names withheld from the initial active set from the shared policy decisions. */
export function computeDeferredToolNames(
  candidates: readonly ToolDeferralCandidate[],
  overrides?: ToolDeferralOverrides,
  options: DeferralOptions = {},
): Set<string> {
  return new Set(
    resolveToolDeferralDecisions(candidates, overrides, options)
      .filter((decision) => decision.effective === 'deferred')
      .map((decision) => decision.name),
  );
}
