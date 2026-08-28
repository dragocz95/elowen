import { createAgentSession, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionAPI, PromptTemplate, ResourceLoader, Skill, ToolDefinition, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { BrainStore } from '../../store/brainStore.js';
import { createSessionPersistenceProjector, rehydrate, settlePartialTurn, type SettledTurnUsage } from '../persistence.js';
import { applyProviderRequestProfile, isCanonicalThinkingLevel, type ProviderRequestProfile } from '../modelCapabilities.js';
import type { DelegatedExecutionScope } from '../delegatedScope.js';
import type { ApplyCompaction } from './liveBrain.js';
import { installLiveRecall, type LiveRecallOptions } from './liveRecall.js';
import type { StepDrainCoordinator } from '../stepDrain.js';
import { createCompactionModelRoute, type CompactionModelRoute } from './compactionModelRoute.js';
import { createCompactionCircuitBreaker, type CompactionThresholdBudget } from './compactionCircuitBreaker.js';
import {
  estimatedContextTokens,
  installTurnBoundaryAutoCompaction,
  latestCompaction,
  type PendingCompactionMessage,
} from './turnBoundaryCompaction.js';
import { assessColdCompaction, type AssessColdCompaction } from './coldStartCompaction.js';
import { installHistoryImageStripping } from './historyImageStripping.js';
import { imagesRejected } from './imageRejection.js';
import { installToolResultClearing } from './toolResultClearing.js';
import { createCachePayloadMonitor, installCacheWatch, type CachePayloadMonitor, type CacheWatchFlavor } from './cacheWatch.js';
import { idleThresholdMs, OPENAI_CACHE_MAX_RETENTION_MS } from './cacheTiming.js';
import { installCacheBreakpoints } from './cacheBreakpoints.js';
import {
  createRemoteCompactionV2,
  installCompactionMarkerSanitizer,
  type RemoteCompactionV2,
} from './remoteCompactionV2.js';
import { bearerFromAuth } from '../providerUsage.js';
import { seedActivatedFromHistory, type ToolSearchHandle } from '../toolSearch/toolSearchTool.js';
import { installOpenAIHostedToolSearch } from './openAiHostedToolSearch.js';
import { installAnthropicHostedToolSearch } from './anthropicHostedToolSearch.js';
import { createAnthropicHostedToolReplay, type AnthropicHostedToolReplay } from './anthropicHostedToolReplay.js';
import type { HostedToolSearchProvider } from './hostedToolSearch.js';
import { logger } from '../../shared/logger.js';
import { ProviderRequestRecorder } from './providerRequestRecorder.js';
import { recoverMalformedToolCalls } from './malformedToolCallRecovery.js';
import { realPathWithin } from '../../plugins/pathGuard.js';
import { relative, sep } from 'node:path';

let missingBoundaryCompactionWarned = false;

/** The INITIAL active tool slice: every registered tool name MINUS the deferred ones. Deferred tools stay
 *  in the registry (customTools) so ToolSearch can activate them later; they are simply withheld from the
 *  prompt at spawn. No deferral (undefined/empty) → every tool starts active, byte-identical to before.
 *  Extracted as a pure function so the split is unit-testable without constructing a whole session. */
export function initialActiveToolNames(tools: readonly ToolDefinition[], deferred?: ReadonlySet<string>): string[] {
  const names = tools.map((t) => t.name);
  return deferred && deferred.size > 0 ? names.filter((n) => !deferred.has(n)) : names;
}

/** Everything one PI brain session needs, composed by the caller. The factory only assembles. */
export interface SessionSpec {
  sessionId: string;
  /** Mid-turn memory recall, when the caller wants it for this session. */
  liveRecall?: LiveRecallOptions;
  /** The Elowen user the store row belongs to. */
  ownerUserId: number;
  /** Parent conversation for delegated sessions; persisted for usage/navigation. */
  parentSessionId?: string;
  /** Immutable access boundary for a delegated child; verified on every respawn. */
  delegatedAccess?: DelegatedExecutionScope;
  /** Imported platform transcript rows inserted atomically before history rehydration. */
  seedMessages?: { id: string; role: 'user' | 'assistant'; content: unknown }[];
  runtime: ModelRuntime;
  model: Model<Api>;
  /** The CONFIG provider entry id this session runs on (BrainProviderEntry.id, from the resolved route —
   *  NOT `model.provider`, which is the registry name). Persisted beside the model so a respawn can
   *  restore the exact pair the conversation was running on. */
  providerId?: string;
  /** Distinct model (any provider) used deterministically for PI-owned compaction requests — the user's
   *  chosen compaction model or a provider's stable default. Undefined → compact on the session model. */
  compactionFallbackModel?: Model<Api>;
  cwd: string;
  /** Logical cwd rendered into PI's static prompt; runtime/resource cwd remains the canonical host path. */
  displayCwd?: string;
  /** Exact root allowed to contribute project context files. */
  contextRoot?: string;
  /** Exact host-path scrubber applied to the complete provider payload (history, tool results and prompt). */
  sanitizePaths?: (text: string) => string;
  systemPrompt: string;
  /** Chunks appended after the system prompt (plugin fragments, role prompts). */
  appendSystemPrompt: string[];
  /** Plugin skills fed to PI's native path via the resource loader's `skillsOverride` — PI renders the
   *  progressive-disclosure block in the system prompt AND expands `/skill:name` in prompt/steer/followUp
   *  on its own, so we never format a skills block ourselves. */
  skills: Skill[];
  /** Plugin prompt-command macros fed to PI's native path via the resource loader's `promptsOverride`.
   *  PI exposes each as a `/name` slash command and expands its arguments in prompt()/steer()/followUp()
   *  on its own — the daemon never substitutes. Only the interactive chat spawner populates these; task
   *  workers (no user typing slashes) leave it empty. */
  promptTemplates?: PromptTemplate[];
  tools: ToolDefinition[];
  /** Deferred-tool handle: when present, its `deferred` names are withheld from the INITIAL active set
   *  (they stay in the registry so ToolSearch can activate them), and the live session is wired onto it
   *  after creation so ToolSearch can change the active slice. Undefined → every tool starts active. */
  toolSearch?: ToolSearchHandle;
  /** Explicitly AUTH-BOUND hosted route resolved from BrainProviderEntry.type by the caller. The factory
   *  never infers OAuth from a model/provider label; compaction may route requests elsewhere. */
  hostedToolSearch?: HostedToolSearchProvider;
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  /** Mutable provider switches (currently ChatGPT OAuth Fast) read before every request. */
  requestProfile?: ProviderRequestProfile;
  /** PI's built-in auto-compaction: on/off. When on, PI summarizes the context on its own once it fills
   *  past `autoCompactAtPct` — no separate trigger in our turn loop. */
  autoCompact: boolean;
  /** The operator's remote-compaction switch, read live so it applies without a respawn. Only ever
   *  consulted for a ChatGPT-account session; every other provider is unaffected either way. A caller
   *  that omits it (task workers) keeps the text-summary path. */
  remoteCompactionEnabled?: () => boolean;
  /** Runtime kill switch for exact provider request capture. Read for every new attempt. */
  providerRequestCaptureEnabled?: () => boolean;
  /** Context-window fill percentage (30–95) at which PI auto-compacts. Translated to PI's absolute
   *  `reserveTokens` = round(contextWindow · (1 − pct/100)) — `shouldCompact` fires when the context
   *  exceeds `contextWindow − reserveTokens`, i.e. once the window is `pct`% full. */
  autoCompactAtPct: number;
  /** Authoritative image-carrying snapshot of messages PI can inject before a later provider request.
   * Chat sessions supply their native queue mirror; workers without an interactive queue omit it and
   * the boundary adapter falls back to PI's public text-only accessors. */
  pendingCompactionMessages?: () => readonly PendingCompactionMessage[];
  /** Load the project's AGENTS.md/CLAUDE.md into the system prompt (PI walks `cwd` and its ancestors).
   *  OWNER-CHAT ONLY: shared channels and task workers must leave this off — the ancestor walk would
   *  pull internal instruction files into a prompt foreign senders talk to. */
  contextFiles?: boolean;
  /** Session title to set when the stored row has none yet (task sessions name themselves). */
  title?: string;
  /** Fired once when repeated compaction failures stop this session from compacting at all. Callers
   *  route it to the channel they already use for terminal session errors; a caller without one (a task
   *  worker) leaves it out and the condition is only logged. */
  onCompactionStopped?: (message: string) => void;
  /** Fired once the live session exists, carrying its REHYDRATED history. Callers forward it to the
   *  plugin hook bus as `brain.session.afterSpawn` — the seam a plugin needs to restore per-conversation
   *  state that lives in daemon memory but whose evidence lives in the transcript (the files plugin's
   *  read-before-write guard). Awaited, like `onToolResult`, so the state is in place before the first
   *  turn can run; the bus is fail-open and budgets each hook, so a broken one cannot block a spawn. */
  onSpawned?: (e: { sessionId: string; messages: readonly unknown[] }) => void | Promise<void>;
}

export interface SessionFactoryDeps {
  store: BrainStore;
  /** Where a tool result's image bytes are externalized to when the turn is persisted. Absent for
   *  in-memory stores and tests, where the bytes simply stay on the row. */
  chatImagesDir?: string;
  /** Bill a settled turn's tokens to the origin that ordered it (UsageOriginStore, wired in brainCore).
   *  A seam rather than the store itself: the session factory has no business knowing how attribution is
   *  persisted, and a process without it (the forked sub-agent runner, tests) simply records nothing. */
  onTurnSettled?: (sessionId: string, usage: SettledTurnUsage) => void;
  /** Injected for tests; defaults to PI's createAgentSession. */
  createSession?: typeof createAgentSession;
  /** Injected for tests; builds the resource loader that carries the system prompt. A test passes
   *  `() => undefined` so no disk-touching loader is constructed. */
  resourceLoaderFactory?: (o: BrainResourceLoaderOptions) => ResourceLoader | undefined;
  /** This process's step-boundary shutdown coordinator (see stepDrain.ts). The factory gives every
   *  spawned session its boundary hold and tool-execution bookkeeping; absent → sessions spawn exactly
   *  as before and the shutdown drain falls back to whole-turn waiting. */
  stepDrain?: StepDrainCoordinator;
}

/** Shared construction seam used by chat and embedded task-worker tests. Keeping this shape beside the
 * factory prevents either caller from silently dropping new session-level routing inputs. */
export interface BrainResourceLoaderOptions {
  cwd: string;
  systemPrompt: string;
  appendSystemPrompt?: string[];
  skills?: Skill[];
  prompts?: PromptTemplate[];
  contextFiles?: boolean;
  contextRoot?: string;
  displayCwd?: string;
  sanitizePaths?: (text: string) => string;
  codexReasoningFix?: boolean;
  /** Log the NAMES of the response headers Kimi returns, to learn whether it exposes a rate-limit/quota
   *  signal (the CLI rail already renders one for ChatGPT). A measurement step, not a feature. */
  kimiHeaderProbe?: boolean;
  /** Marker hook for PI-owned compaction requests. The actual stream route is installed on AgentSession. */
  compactionModelRouteExtension?: CompactionModelRoute['extension'];
  /** Cancel gate for automatic compaction once it has failed too many times in a row. */
  compactionCircuitBreakerExtension?: (pi: ExtensionAPI) => void;
  /** Provider-side opaque compaction; present only for a ChatGPT-account session. */
  remoteCompactionExtension?: RemoteCompactionV2['extension'];
  /** Whether THIS session can restore a stored compaction blob. Always supplied: the sanitizer it
   *  installs is what keeps a blob minted before a model switch from reaching a foreign provider as
   *  text, so it is exactly the sessions that answer `false` that need it. */
  remoteCompactionUsable: () => boolean;
  /** Recall memories again mid-turn, searching from the work rather than the opening message. */
  liveRecall?: LiveRecallOptions;
  /** Provider-payload hashes (Anthropic or OpenAI Responses shape) consumed by cacheWatch after each
   *  response. */
  cacheMonitor?: CachePayloadMonitor;
  /** Add the trailing prompt-cache breakpoint (Anthropic only). Deliberately independent of
   *  `cacheMonitor`: that one only watches, this one changes the request, so switching observability off
   *  must not switch the fix off with it. */
  cacheBreakpoints?: boolean;
  /** Auth-bound provider route + expected request model. The model pin prevents a same-session compaction
   *  fallback from inheriting the chat provider's hosted wire transform. */
  hostedToolSearch?: { provider: HostedToolSearchProvider; modelId: string };
  /** Preserve Anthropic's server-owned hosted-search blocks before cache hashing and breakpoint insertion. */
  anthropicHostedReplayExtension?: AnthropicHostedToolReplay['extension'];
  requestProfile?: ProviderRequestProfile;
  settingsManager: SettingsManager;
}

/** PI uses the same reserve both as the proactive threshold and as the summary-output budget during
 * overflow recovery. A zero reserve therefore cannot mean "overflow only": it produces a zero-token
 * summary and makes the recovery fail. Keep disabled proactive compaction at a small emergency margin
 * (5% of context, capped at 4k) so it triggers only at the cliff but still has room to summarize.
 *
 * The dual use also couples the summary budget to the user's percentage: PI caps a summary at
 * `min(floor(0.8 * reserve), model.maxTokens)`, so a LOW threshold (large reserve) permits a LARGE
 * summary. The coupling cannot be broken through the settings surface — reserve is a single knob that
 * the percentage pins exactly, and PI derives both the trigger point and the summary cap from it. The
 * trigger is the user-visible setting and must win; the budget side effect is bounded in practice by the
 * compaction model's maxTokens (the summarization prompt also demands a concise structured output, so a
 * real summary is a few thousand tokens, not 0.8·reserve). */
export function compactionReserveTokens(contextWindow: number, proactive: boolean, atPercent: number): number {
  if (proactive) return Math.max(2, Math.round(contextWindow * (1 - atPercent / 100)));
  return Math.max(256, Math.min(4_096, Math.round(contextWindow * 0.05)));
}

/** The recent-message tail PI keeps verbatim after a compaction. PI's default is a CONSTANT 20000 that
 * Elowen never overrode, so every session silently ran it — 62% of a 32k window but only 10% of a 200k
 * one, and on small models the floor alone swallowed the room the threshold was supposed to buy. The tail
 * is the only part of the post-compaction floor Elowen controls through PI's settings surface, so it must
 * be sized from what actually constrains it.
 *
 * What constrains it is the POST-COMPACTION CEILING, not the trigger. Sizing the tail from the room left
 * under the trigger asks "does the tail still fit below the point that FIRES compaction", and on a large
 * trigger the answer is trivially yes — 500k minus the fixed cost leaves hundreds of thousands of tokens
 * of headroom, so the tail lands on {@link COMPACTION_TAIL_MAX} and the trigger stops influencing it at
 * all. That is the wrong question: a compaction exists to make the context small again, so what the tail
 * must fit under is how much context the conversation may still carry AFTERWARDS.
 *
 * The floor after a compaction is `fixed cost + summary + tail`, where the fixed cost (system prompt +
 * tool definitions) is known — or closely estimable — when the session is built, and the summary is NOT:
 * it starts empty and grows with every compaction because PI's update prompt preserves all previous
 * content. {@link COMPACTION_SUMMARY_ALLOWANCE} is an honest middle estimate for the summary at tail-sizing
 * time ("a few thousand tokens" in practice); the guard in the circuit breaker re-measures the real floor
 * after each compaction and stops the retry loop when the summary has grown past the headroom.
 * {@link COMPACTION_TRIGGER_MARGIN} keeps that floor comfortably below the trigger rather than at it. */
const COMPACTION_TAIL_MIN = 2_000;
const COMPACTION_TAIL_MAX = 20_000;
const COMPACTION_SUMMARY_ALLOWANCE = 8_000;
const COMPACTION_TRIGGER_MARGIN = 5_000;

/** How much context a conversation may still carry once a compaction has run, as a share of the trigger
 *  that fired it. A compaction that leaves the context near its own trigger buys nothing and fires again
 *  on the next turn, having spent a full standalone summarization request — billed at full input price,
 *  because PI sends summaries with `cacheRetention: "none"` and they never read the conversation's cache.
 *
 *  It is a CEILING, not a target: landing further below it is always fine and is never corrected upwards. */
const POST_COMPACTION_CEILING_PCT = 20;

/** The most context this session may keep after a compaction, derived from the trigger in force. */
export function postCompactionCeiling(triggerTokens: number): number {
  return Math.round((triggerTokens * POST_COMPACTION_CEILING_PCT) / 100);
}

/** The token room left under the post-compaction ceiling once the fixed cost and the summary are paid for.
 *  Negative (or smaller than the minimal tail) means the ceiling cannot be honoured on this session —
 *  typically because the never-shrinking fixed cost alone already exceeds it. The tail then sits at its
 *  minimum, which is as close to the ceiling as this session can get: compaction still runs, because
 *  shrinking the context part of the way is strictly better than not shrinking it at all. */
function compactionTailHeadroom(triggerTokens: number, fixedCostTokens: number): number {
  return postCompactionCeiling(triggerTokens) - fixedCostTokens - COMPACTION_SUMMARY_ALLOWANCE;
}

/** Estimate the never-shrinking part of one provider request — system prompt + append chunks + tool
 *  definitions — with the same chars/4 heuristic PI itself uses (estimateTokens) to decide shouldCompact,
 *  so the estimate is measured the same way the threshold is. It is an approximation: it counts the raw
 *  spec strings, not PI's rendered system template or the skills block the loader injects. */
export function estimateFixedCostTokens(
  systemPrompt: string, appendSystemPrompt: readonly string[] | undefined, tools: readonly ToolDefinition[] | undefined,
): number {
  const toolsChars = tools ? JSON.stringify(tools).length : 0;
  return Math.ceil((systemPrompt.length + (appendSystemPrompt?.join('\n\n').length ?? 0) + toolsChars) / 4);
}

/** The retained recent-message tail for one trigger point: whatever the post-compaction ceiling does not
 *  leave over is denied to the tail. PI keeps AT LEAST this many tokens — it cuts at the first message
 *  boundary past the budget and never inside a tool result — so this is a FLOOR handed to PI, not a
 *  guarantee: one oversized entry can still carry the retained tail past the ceiling. Sized by the
 *  headroom, clamped to a coherent minimum and to PI's own default at the top. */
export function compactionKeepRecentTokens(triggerTokens: number, fixedCostTokens: number): number {
  return Math.min(COMPACTION_TAIL_MAX, Math.max(COMPACTION_TAIL_MIN, Math.round(compactionTailHeadroom(triggerTokens, fixedCostTokens))));
}

/** The smallest post-compaction floor this session can be expected to reach: fixed cost + the summary
 *  allowance + the minimal tail. Seeded into the circuit breaker at spawn so an unreachable threshold is
 *  caught BEFORE the first summarization request, not after it. */
function compactionFloorSeedEstimate(fixedCostTokens: number): number {
  return fixedCostTokens + COMPACTION_SUMMARY_ALLOWANCE + COMPACTION_TAIL_MIN;
}

/** The effective auto-compact percentage for one model: the user's per-model override (keyed
 *  `providerId/model`, the same convention as the operator context-window map) when set, else the global
 *  default. Each model has its own context window, so the same percentage yields a different absolute
 *  reserve — letting a user compact a 32k model earlier than a 200k one. */
export function resolveAutoCompactPct(
  byModel: Record<string, number> | undefined, providerId: string, modelId: string, globalPct: number,
): number {
  return byModel?.[`${providerId}/${modelId}`] ?? globalPct;
}

/** The ChatGPT (Codex) backend returns reasoning-summary text ONLY for `reasoning.summary:"concise"`
 *  — with pi's default "auto" (and even "detailed") the reasoning item comes back EMPTY, so the UI
 *  never sees the model's thinking. Verified empirically against gpt-5.5 (auto/detailed → 0 summary
 *  chars, concise → text). pi offers no per-session summary option, so an inline extension patches the
 *  outgoing payload; registered only for openai-codex sessions (the official API honors "auto"). */
function codexReasoningSummary(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => {
    const payload = event.payload as { reasoning?: Record<string, unknown> } | null | undefined;
    if (!payload?.reasoning || typeof payload.reasoning !== 'object') return undefined;
    return { ...payload, reasoning: { ...payload.reasoning, summary: 'concise' } };
  });
}

/** Whether Kimi returns a usage/quota header has no answer in any code on this box (not in the Go
 *  reference cliproxy, not in the JWT, and nothing reads Kimi response headers), so this measures it: log
 *  each distinct response-header NAME the first time it is seen. Names only, never values — a header can
 *  carry an identifier. Bounded noise (one line per name, ever) yet still catches a `*-ratelimit-*` header
 *  that only appears near a limit. If one shows up, the rail can be built on it; if none do, Kimi exposes
 *  nothing and the idea is settled. The `Set` lives for the daemon's lifetime; a restart re-probes. */
const kimiSeenHeaderNames = new Set<string>();
function kimiHeaderProbe(pi: ExtensionAPI): void {
  pi.on('after_provider_response', (event) => {
    const fresh = Object.keys(event.headers ?? {})
      .map((name) => name.toLowerCase())
      .filter((name) => !kimiSeenHeaderNames.has(name));
    if (fresh.length === 0) return;
    for (const name of fresh) kimiSeenHeaderNames.add(name);
    logger('kimi-headers').info(`response header name(s) seen for the first time: ${fresh.sort().join(', ')}`);
  });
}

/** The session's request switches: ChatGPT OAuth Fast mode (OpenAI's priority service tier) and the
 *  provider entry's configured temperature. The state object is deliberately mutable: `/fast` changes it
 *  live and this hook reads the newest value on every model round-trip. With no switch active the
 *  projection returns its input unchanged and we patch nothing at all. */
function providerRequestProfile(profile: ProviderRequestProfile): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const payload = event.payload as Record<string, unknown> | null | undefined;
      if (!payload) return undefined;
      const next = applyProviderRequestProfile(payload, profile);
      return next === payload ? undefined : next;
    });
  };
}

function sanitizePayloadValue(value: unknown, sanitize: (text: string) => string): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map((item) => sanitizePayloadValue(item, sanitize));
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, sanitizePayloadValue(item, sanitize)]));
}

export function providerPathScrubber(sanitize: (text: string) => string): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const next = sanitizePayloadValue(event.payload, sanitize) as typeof event.payload;
      return next === event.payload ? undefined : next;
    });
  };
}

function logicalContextPath(path: string, root: string): string {
  const resolved = realPathWithin(path, [root]);
  if (!resolved) return '';
  const rel = relative(root, resolved).split(sep).join('/');
  return rel || '.';
}

/** PI currently uses one cwd for runtime services and the final static prompt line. Elowen needs the real
 * worktree for resource discovery while exposing only a logical cwd to a workspace-scoped child, so rebuild
 * the documented custom-prompt shape from PI's structured options instead of patching prompt text. */
export function logicalPromptCwd(displayCwd: string, contextRoot?: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_agent_start', (event) => {
      const options = event.systemPromptOptions;
      if (!options.customPrompt) throw new Error('logical prompt cwd requires an explicit custom system prompt');
      let prompt = options.customPrompt;
      if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
      const contextFiles = contextRoot
        ? (options.contextFiles ?? []).map((file) => ({ ...file, path: logicalContextPath(file.path, contextRoot) }))
          .filter((file) => file.path)
        : options.contextFiles ?? [];
      if (contextFiles.length > 0) {
        prompt += '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n';
        for (const file of contextFiles) {
          prompt += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
        }
        prompt += '</project_context>\n';
      }
      prompt += `\nCurrent working directory: ${displayCwd.replaceAll('\\', '/')}\n`;
      return { systemPrompt: prompt };
    });
  };
}

/** Default resource loader: carries the composed system prompt, appends the extra chunks after it,
 *  and disables most disk discovery — the brain is a lean, in-process agent. `noExtensions` skips only
 *  DISCOVERED extensions; the inline factories below still load. Context files are OWNER-ONLY opt-in
 *  (`contextFiles`): PI reads the project's AGENTS.md/CLAUDE.md from `cwd` AND ITS ANCESTORS and renders
 *  them as `<project_instructions path="…">`. That ancestor walk makes it a leak vector on shared
 *  surfaces — a channel session whose cwd falls back to the daemon's project path would inhale internal
 *  instruction files into a prompt foreign senders talk to — so channels and task workers keep it off.
 *  It sits in a separate prompt block from the Elowen persona/appends, so there is no duplication. */
function defaultResourceLoaderFactory(o: BrainResourceLoaderOptions): ResourceLoader {
  const skills = o.skills ?? [];
  const prompts = o.prompts ?? [];
  return new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.cwd, systemPrompt: o.systemPrompt, appendSystemPrompt: o.appendSystemPrompt,
    settingsManager: o.settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: !o.contextFiles,
    // `noSkills` disables disk discovery; the override feeds PI our in-memory plugin skills instead. PI
    // then renders the progressive-disclosure block into the system prompt and expands `/skill:name`
    // itself — no manual skills block, no custom read tool.
    skillsOverride: () => ({ skills, diagnostics: [] }),
    // Same pattern for prompt-command macros: `noPromptTemplates` disables the disk scan; this override
    // feeds PI our in-memory plugin templates, which it exposes as `/name` slash commands and expands
    // ($1/$@/$ARGUMENTS/${N:-default}) itself in prompt()/steer()/followUp() — no daemon-side expansion.
    promptsOverride: () => ({ prompts, diagnostics: [] }),
    ...(o.contextRoot ? {
      agentsFilesOverride: (base) => ({
        agentsFiles: base.agentsFiles.filter((file) => realPathWithin(file.path, [o.contextRoot!]) !== null),
      }),
    } : {}),
    // No longer conditional: the marker sanitizer below has to run on every session, so there is always
    // at least one inline extension to load.
    ...{
      extensionFactories: [
        ...(o.displayCwd ? [logicalPromptCwd(o.displayCwd, o.contextRoot)] : []),
        ...(o.codexReasoningFix ? [codexReasoningSummary] : []),
        ...(o.remoteCompactionExtension ? [o.remoteCompactionExtension] : []),
        // Unconditional: a session that CANNOT use a stored blob is the one that would otherwise send it
        // as raw text, so the guard belongs on every provider, not just the one that mints blobs.
        ((usable) => (pi: ExtensionAPI): void => { installCompactionMarkerSanitizer(pi, usable); })(o.remoteCompactionUsable),
        ...(o.kimiHeaderProbe ? [kimiHeaderProbe] : []),
        ...(o.compactionModelRouteExtension ? [o.compactionModelRouteExtension] : []),
        ...(o.compactionCircuitBreakerExtension ? [o.compactionCircuitBreakerExtension] : []),
        ...(o.requestProfile ? [providerRequestProfile(o.requestProfile)] : []),
        // Before cacheMonitor: observability must see the FINAL hosted-search body (deferred definitions +
        // server tool), not pi-ai's immediate-tools intermediate that never leaves the process.
        ...(o.hostedToolSearch?.provider === 'openai'
          ? [((modelId) => (pi: ExtensionAPI): void => { installOpenAIHostedToolSearch(pi, modelId); })(o.hostedToolSearch.modelId)]
          : []),
        ...(o.hostedToolSearch?.provider === 'anthropic'
          ? [((modelId) => (pi: ExtensionAPI): void => { installAnthropicHostedToolSearch(pi, modelId); })(o.hostedToolSearch.modelId)]
          : []),
        // Anthropic requires server_tool_use/tool_search_tool_result to be replayed verbatim. Restore them
        // before observability and cache breakpoints so both see/hash the exact request sent upstream.
        ...(o.anthropicHostedReplayExtension ? [o.anthropicHostedReplayExtension] : []),
        ...(o.liveRecall ? [((recall) => (pi: ExtensionAPI): void => { installLiveRecall(pi, recall); })(o.liveRecall)] : []),
        ...(o.cacheMonitor ? [o.cacheMonitor.extension] : []),
        // AFTER the monitor, so the snapshot it takes is the payload as pi-ai built it. The monitor hashes
        // canonically (markers stripped), so the order does not change what it reports — it keeps the
        // snapshot honest about what this code did or did not touch.
        ...(o.cacheBreakpoints ? [installCacheBreakpoints] : []),
        ...(o.sanitizePaths ? [providerPathScrubber(o.sanitizePaths)] : []),
      ],
    },
  });
}

/** The shared session assembly behind both the chat brain (`spawnLive`) and the elowen-exec task
 *  workers: store row → history rehydration → resource loader → PI session → persistence
 *  subscription. One implementation, so the reload gotcha below can never drift out of sync. */
export class BrainSessionFactory {
  constructor(private d: SessionFactoryDeps) {}

  async create(spec: SessionSpec): Promise<{
    session: AgentSession;
    applyCompaction: ApplyCompaction;
    /** Live cold-start-compaction eligibility for THIS session, consulted by the turn runner on the
     *  first turn after the prompt cache expired. Built here because only the factory closure holds the
     *  pieces together: the live proactive flag, the circuit breaker and the fixed-cost/tail estimates. */
    assessColdCompaction: AssessColdCompaction;
  }> {
    // Ensure the store row (sole source of truth) exists before rehydration.
    const existing = this.d.store.getSession(spec.sessionId);
    if (!existing) {
      this.d.store.createSession({
        id: spec.sessionId, userId: spec.ownerUserId, model: spec.model.id, provider: spec.providerId,
        parentSessionId: spec.parentSessionId, delegatedAccess: spec.delegatedAccess,
      });
    } else {
      // A durable delegated child never accepts a replacement scope after its first spawn. In
      // particular, a legacy/corrupt child with no scope cannot be upgraded by an owner continuation.
      if (spec.parentSessionId) {
        if (existing.parent_session_id !== spec.parentSessionId
          || !spec.delegatedAccess
          || !this.d.store.hasDelegatedAccess(spec.sessionId, spec.delegatedAccess)) {
          throw new Error('delegated access unavailable');
        }
      } else if (spec.delegatedAccess) {
        throw new Error('delegated access requires a parent session');
      }
      // Deliberately NOT touchSession: spawning attaches a live session to an existing conversation —
      // a page load, a channel waking, an evicted conversation coming back — and none of those are the
      // conversation moving. Stamping it here put yesterday's untouched chat at the top of the register
      // with today's timestamp. The model/provider pair is still recorded, so a later respawn restores it.
      this.d.store.setSessionModel(spec.sessionId, spec.model.id, spec.providerId);
    }
    if (spec.title && !this.d.store.getSession(spec.sessionId)?.title) {
      this.d.store.setTitle(spec.sessionId, spec.title.slice(0, 60));
    }
    if (spec.seedMessages?.length) this.d.store.seedMessages(spec.sessionId, spec.seedMessages);

    // A session is only ever spawned when none is live for it, so any rows still marked pending are the
    // remains of a turn the daemon died in the middle of. Settle them into history BEFORE rehydrating, so
    // the conversation comes back holding the work that turn actually did instead of silently losing it.
    settlePartialTurn(this.d.store, spec.sessionId);
    const sessionManager = rehydrate(this.d.store, spec.sessionId, spec.cwd);
    // Each session owns its own IN-MEMORY SettingsManager so its compaction threshold is per-conversation
    // (the owner's per-user %, the channel default) — shared by createAgentSession (which reads compaction
    // at check time) and the resource loader. It MUST be in-memory, never file-backed: SettingsManager.create
    // would read the user's project `.pi/settings.json` from cwd (letting a checked-in file override Elowen's
    // per-user config) and a PI-side write (e.g. /reasoning → setDefaultThinkingLevel) would persist a
    // settings.json INTO the working repo. inMemory reads nothing from disk and writes nowhere; only the
    // compaction override below (and any session-local PI setting) lives here, dying with the session.
    // `projectTrusted` lets those session-local writes land in the in-memory store instead of erroring.
    const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: true });
    const compactionModelRoute = createCompactionModelRoute(spec.compactionFallbackModel);
    const anthropicHostedReplay = spec.hostedToolSearch === 'anthropic'
      ? createAnthropicHostedToolReplay(spec.model)
      : undefined;
    // A context that is irrecoverably over the limit fails the same way on every retry, and PI re-checks
    // the threshold after every turn — so without this the conversation would pay for a doomed
    // summarization request for the rest of its life. The breaker only refuses attempts; it never
    // changes when compaction triggers or what it summarizes.
    //
    // The threshold budget extends the same idea to a threshold that is physically UNREACHABLE: a
    // compaction whose post-compaction floor (fixed cost + summary + tail) still sits at or above the
    // trigger "succeeds" by PI's measure, so the failure counter never trips — but the next turn fires
    // it again, forever, at full summarization cost. The holder is mutated by applyCompaction below so
    // a live percentage change re-evaluates the guard with the trigger actually in force.
    const fixedCostTokens = estimateFixedCostTokens(spec.systemPrompt, spec.appendSystemPrompt, spec.tools);
    const thresholdBudget: CompactionThresholdBudget = { trigger: null, fixedCostTokens, floorMargin: COMPACTION_TRIGGER_MARGIN };
    const compactionBreaker = createCompactionCircuitBreaker({
      sessionId: spec.sessionId,
      thresholdBudget,
      ...(spec.onCompactionStopped ? { onTripped: spec.onCompactionStopped } : {}),
    });
    // Anthropic by provider (the original scope), ChatGPT backend by wire api: pi-ai maps its
    // input_tokens_details.cached_tokens onto the same usage.cacheRead the watch reads, and the payload
    // snapshot understands the Responses instructions/input shape (see cacheWatch's flavor).
    const cacheFlavor: CacheWatchFlavor | undefined = spec.model.provider === 'anthropic' ? 'anthropic'
      : spec.model.api === 'openai-codex-responses' || spec.model.api === 'openai-responses'
        ? 'openai-responses' : undefined;
    const cacheIdleMs = cacheFlavor === 'openai-responses'
      ? idleThresholdMs(process.env, OPENAI_CACHE_MAX_RETENTION_MS) : undefined;
    const cacheMonitor = cacheFlavor ? createCachePayloadMonitor() : undefined;
    // Provider-side compaction exists only on the ChatGPT backend. `usable` is read live — the operator
    // switch, not the spawn-time snapshot — so turning the feature off mid-conversation immediately stops
    // new blobs AND makes the sanitizer strip the ones already stored, instead of leaving them to be sent
    // as text by a build that no longer swaps them.
    const remoteCompactionUsable = (): boolean =>
      spec.model.provider === 'openai-codex' && spec.remoteCompactionEnabled?.() === true;
    const requestRecorder = new ProviderRequestRecorder({
      store: this.d.store.providerRequests,
      sessionId: spec.sessionId,
      configuredProvider: spec.providerId ?? '',
      enabled: spec.providerRequestCaptureEnabled ?? (() => true),
    });
    // A few factory unit tests inject a createSession stub and deliberately omit a runtime; production
    // SessionSpec always carries one. Preserve that test seam rather than proxying an undefined sentinel.
    const captureRuntime = spec.runtime && typeof spec.runtime === 'object'
      ? requestRecorder.wrapRuntime(recoverMalformedToolCalls(spec.runtime))
      : spec.runtime;
    const remoteCompaction: RemoteCompactionV2 | undefined = spec.model.provider === 'openai-codex'
      ? createRemoteCompactionV2({
        enabled: remoteCompactionUsable,
        model: spec.model,
        systemPrompt: () => [spec.systemPrompt, ...spec.appendSystemPrompt].join('\n\n'),
        // The same resolve-and-refresh path a normal turn takes, so a token that expired mid-conversation
        // is renewed here rather than turning into a silent compaction failure.
        token: async () => bearerFromAuth((await spec.runtime.getAuth(spec.model))?.auth),
        capture: {
          start: (model, payload) => requestRecorder.startRemoteCompaction(model, payload),
          response: (requestId, status) => requestRecorder.markRemoteCompactionResponse(requestId, status),
          finish: (requestId, result) => requestRecorder.finishRemoteCompaction(requestId, result),
        },
        onStaleBlobRetry: () => requestRecorder.armVerifiedRetry(),
      })
      : undefined;
    const resourceLoader = (this.d.resourceLoaderFactory ?? defaultResourceLoaderFactory)({
      cwd: spec.cwd, systemPrompt: spec.systemPrompt, appendSystemPrompt: spec.appendSystemPrompt,
      skills: spec.skills, prompts: spec.promptTemplates, contextFiles: spec.contextFiles,
      ...(spec.displayCwd ? { displayCwd: spec.displayCwd } : {}),
      ...(spec.contextRoot ? { contextRoot: spec.contextRoot } : {}),
      ...(spec.sanitizePaths ? { sanitizePaths: spec.sanitizePaths } : {}),
      codexReasoningFix: spec.model.provider === 'openai-codex',
      kimiHeaderProbe: spec.model.provider === 'kimi-coding',
      compactionModelRouteExtension: compactionModelRoute?.extension,
      compactionCircuitBreakerExtension: compactionBreaker.extension,
      remoteCompactionExtension: remoteCompaction?.extension,
      remoteCompactionUsable,
      requestProfile: spec.requestProfile, settingsManager,
      ...(spec.liveRecall ? { liveRecall: spec.liveRecall } : {}),
      ...(cacheMonitor ? { cacheMonitor } : {}),
      ...(spec.model.provider === 'anthropic' ? { cacheBreakpoints: true } : {}),
      ...(spec.hostedToolSearch ? {
        hostedToolSearch: { provider: spec.hostedToolSearch, modelId: spec.model.id },
      } : {}),
      ...(anthropicHostedReplay ? { anthropicHostedReplayExtension: anthropicHostedReplay.extension } : {}),
    });
    // A resource loader passed to createAgentSession is NOT auto-reloaded (only one it builds itself
    // is), so its system prompt stays empty unless we reload it here. Without this the brain falls
    // back to pi's default "coding assistant" persona and misidentifies itself.
    if (resourceLoader) await resourceLoader.reload();

    const create = this.d.createSession ?? createAgentSession;
    // Reasoning effort for extended-thinking models — PI clamps an unsupported level to the model's
    // range, so passing it for a non-thinking model is harmless. Empty → leave the model default.
    const thinkingLevel = spec.thinkingLevel && isCanonicalThinkingLevel(spec.thinkingLevel) ? spec.thinkingLevel : undefined;
    const { session } = await create({
      cwd: spec.cwd,
      sessionManager,
      modelRuntime: captureRuntime,
      model: spec.model,
      resourceLoader,
      settingsManager,
      // The step-drain wrapper brackets only execute() with per-session bookkeeping; names and schemas —
      // and therefore the system-prompt bytes and the `tools` name list below — are untouched, so
      // in-process and runner sessions keep byte-identical composition.
      customTools: this.d.stepDrain ? this.d.stepDrain.wrapTools(spec.sessionId, spec.tools) : spec.tools,
      // PI treats `tools` as the session's ALLOWED tool names — a hard REGISTRY filter, not merely the
      // initial active slice (sdk: `allowedToolNames = options.tools`). Deferred tools must therefore
      // stay in this list: omitting them here drops them from the registry entirely, getAllTools() stops
      // returning them, and ToolSearch can never fetch or activate them again ("matched nothing" for
      // names its own awareness block advertised). The deferred slice is applied AFTER create via
      // setActiveToolsByName, which narrows only the ACTIVE set and leaves the registry whole.
      tools: spec.tools.map((t) => t.name),
      noTools: 'builtin',
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    // Install replay closest to the provider stream. The compaction route wraps it next, so a cross-model
    // fallback reaches replay with the ACTUAL fallback model and bypasses Anthropic capture/restoration.
    // Installing replay outside compaction would classify from the chat model, then parse OpenAI/Kimi SSE
    // as Anthropic and reject a valid cross-provider compaction.
    anthropicHostedReplay?.install(session);
    // PI's compaction marker extension was loaded above; this wrapper makes only the model substitution.
    compactionModelRoute?.install(session);
    // Outermost: a stale-blob retry re-issues through both the compaction route and replay wrapper, so the
    // retry remains the exact same routed request rather than bypassing either provider-specific seam.
    remoteCompaction?.install(session);
    session.subscribe(requestRecorder.observe);
    // PI's steering queue defaults to "one-at-a-time", so N messages sent during a running turn cost N
    // model rounds and the agent answers each without seeing the ones behind it. "all" hands the whole
    // queue to the loop, which injects every message into the context before a SINGLE model call. The
    // messages stay separate transcript rows — durable per-message rows, positional queue-remove ids and
    // image attachments all survive. Session-local: it lands in the in-memory SettingsManager above.
    session.setSteeringMode('all');
    // Wire the live session onto the deferred-tool handle so ToolSearch (which closes over the handle) can
    // read the registry and change the active slice. AgentSession structurally satisfies the handle's
    // ToolActivationTarget (getAllTools/getActiveToolNames/setActiveToolsByName). No-op when nothing is
    // deferred (handle undefined). Then re-seed `activated` from rehydrated history so a respawn (model
    // switch, LRU revival, restart) does not forget tools the model already fetched — the next visibility
    // pass turns them back on.
    if (spec.toolSearch) {
      // Withhold the deferred tools from the INITIAL active slice (their schemas stay out of the prompt
      // until fetched). Done here — not via the create() `tools` option — because that option is PI's
      // registry allow-list; this call narrows only the active set. The per-turn visibility pass then
      // keeps already-fetched tools advertised and withheld ones hidden.
      if (spec.toolSearch.deferred.size > 0) {
        session.setActiveToolsByName(initialActiveToolNames(spec.tools, spec.toolSearch.deferred));
      }
      spec.toolSearch.session = session;
      seedActivatedFromHistory(spec.toolSearch, session.messages);
    }
    // Egress-only: once the prompt cache is definitely cold, historical image blocks become latched text
    // placeholders for ANY source — Read images, MCP screenshots, future plugins. Warm history and the
    // current run's fresh images stay intact; persisted history is untouched. An image the provider has
    // already REFUSED opens that gate immediately (imageRejection.ts): it fails every later request until
    // it is gone, so leaving it in until the cache goes cold would brick the conversation for an hour.
    installHistoryImageStripping(session, {
      rejected: () => imagesRejected(spec.sessionId),
      ...(cacheIdleMs !== undefined ? { idleMs: cacheIdleMs } : {}),
    });
    // Same egress seam: large tool results that have scrolled two user turns back are swapped for a
    // placeholder + spill-file path, but only once the prompt cache has provably expired (idle gate) —
    // history is never rewritten while a request could still cache-hit, and the per-session latch keeps
    // a cleared result cleared so the prefix stays byte-stable afterwards. The latch is mirrored into
    // brain_tool_result_spills so a respawn restores it even when rehydration changed the message text
    // (externalized images) — the file-equality fallback alone cannot.
    installToolResultClearing(session, spec.sessionId, {
      ...(cacheIdleMs !== undefined ? { idleMs: cacheIdleMs } : {}),
      latchStore: {
        load: () => this.d.store.toolResultSpills(spec.sessionId),
        save: (entry) => { this.d.store.upsertToolResultSpill(spec.sessionId, entry); },
        remove: (toolCallId, occurredAt) => { this.d.store.deleteToolResultSpill(spec.sessionId, toolCallId, occurredAt); },
      },
    });
    // cacheWatch is the tripwire that logs whether a warm drop came from system, tools, a history segment,
    // or a likely provider-side eviction. Installed for Anthropic and both OpenAI Responses wires — all map
    // real cached-token figures into cacheRead; other providers expose best-effort stats whose drops are noise.
    if (cacheMonitor && cacheFlavor) {
      installCacheWatch(session, { monitor: cacheMonitor, sessionId: spec.sessionId, flavor: cacheFlavor });
    }
    // Compaction is PI-native: our per-user % maps to PI's absolute reserveTokens (shouldCompact fires
    // once contextTokens > contextWindow − reserveTokens). Applied AFTER create — createAgentSession reads
    // compaction lazily (getCompactionSettings at each check), so an in-memory override here takes effect;
    // the loader's earlier reload() only rebuilds the system prompt and never touches settings.
    //
    // We keep compaction `enabled` ALWAYS on, because PI's `_checkCompaction` gates BOTH the threshold
    // pass AND context-overflow recovery behind `enabled` — turning it off would leave an overflowing
    // conversation hard-erroring on every turn until a manual /compact. "Proactive off" therefore uses
    // only the small emergency reserve described above, rather than PI's normal early threshold.
    //
    // keepRecentTokens is handed over EXPLICITLY rather than by PI's constant default: it is a floor on
    // the post-compaction context, so it must fit the room left under THIS session's trigger after its
    // own fixed cost (see compactionKeepRecentTokens) — not a constant, and not a fraction of the window.
    //
    // Kept as a re-callable closure (returned to the caller) because PI reads compaction lazily at each
    // check: re-applying it turns a saved threshold change into an immediate effect on a RUNNING
    // conversation, instead of one that only appears after the next respawn.
    // The proactive flag has the same runtime mutability as the threshold, so the turn-boundary check
    // reads it through this cell instead of the spawn-time snapshot — see installTurnBoundaryAutoCompaction.
    let proactiveCompaction = spec.autoCompact;
    const applyCompaction = (proactive: boolean, atPercent: number): void => {
      proactiveCompaction = proactive;
      const reserveTokens = compactionReserveTokens(spec.model.contextWindow, proactive, atPercent);
      // The trigger the user's percentage actually sets; the tail and the breaker's guard both key off it.
      const triggerTokens = Math.max(0, spec.model.contextWindow - reserveTokens);
      thresholdBudget.trigger = triggerTokens;
      settingsManager.applyOverrides({
        compaction: {
          enabled: true,
          reserveTokens,
          keepRecentTokens: compactionKeepRecentTokens(triggerTokens, fixedCostTokens),
        },
      });
      // The live percentage change moved the trigger, so the unreachable-threshold guard re-evaluates
      // against the floor it measured last (or the seeded floor, if no compaction has run yet).
      compactionBreaker.applyBudget();
    };
    applyCompaction(spec.autoCompact, spec.autoCompactAtPct);
    // Seed the guard with the smallest floor this session can reach, so a threshold that cannot be
    // honored is refused BEFORE the first summarization request is spent on it.
    compactionBreaker.applyBudget(compactionFloorSeedEstimate(fixedCostTokens));
    const boundaryCompactionInstalled = installTurnBoundaryAutoCompaction(
      session, sessionManager, () => proactiveCompaction, spec.pendingCompactionMessages,
    );
    if (spec.autoCompact && !boundaryCompactionInstalled && !missingBoundaryCompactionWarned) {
      missingBoundaryCompactionWarned = true;
      logger('brain-compaction').warn(
        'PI runtime does not expose the turn-boundary compaction capability; proactive mid-tool-loop compaction is disabled',
      );
    }
    // The shutdown hold, installed AFTER the compaction wrapper so it runs FIRST at each step boundary:
    // a draining daemon parks the loop before spending a compaction model call on a turn it will not
    // continue. See StepDrainCoordinator.installHold.
    this.d.stepDrain?.installHold(session, spec.sessionId);

    // Count compaction outcomes for the circuit breaker installed above. Its cancel gate reads this
    // count on the next `session_before_compact`, so a session that cannot summarize stops trying.
    session.subscribe(compactionBreaker.observe);
    // Persist settled turns (agent_end) AND every PI compaction (auto at the threshold, manual /compact,
    // overflow recovery) — PI shrinks the live context but writes NOTHING to the store, so without this
    // the token savings evaporate on the next rehydrate. Only a REAL compaction (result present, not
    // aborted) mirrors; a no-op/failed run leaves the store untouched. Callers layer their own
    // subscriptions on top (the `compacted` client-notify in the chat brain, liveness in the worker).
    const onTurnSettled = this.d.onTurnSettled;
    session.subscribe(createSessionPersistenceProjector(
      this.d.store, session, spec.sessionId, spec.model.contextWindow, this.d.chatImagesDir,
      onTurnSettled && ((usage) => { onTurnSettled(spec.sessionId, usage); }),
    ));
    // Cold-start-compaction eligibility, read live at every check: the proactive flag and the breaker
    // state may change during the session's life, and the context/floor estimates must reflect the
    // history as it stands. `contextTokens` measures the same way PI's own shouldCompact does (newest
    // provider usage + estimated unseen tail); the floor mirrors the breaker budget's shape but with the
    // REAL retained tail for the trigger currently in force, not the minimal seed. The summary allowance
    // doubles as the break-even's expected summary OUTPUT size — the same "a few thousand tokens in
    // practice" estimate the floor already budgets for the summary's presence in context.
    const assessCold: AssessColdCompaction = (lastRequestCacheTtlMs) => assessColdCompaction({
      proactive: () => proactiveCompaction,
      breakerBlocks: () => compactionBreaker.blocks('threshold'),
      contextTokens: () => estimatedContextTokens(session.messages, latestCompaction(sessionManager)?.timestamp),
      floorTokens: () => fixedCostTokens + COMPACTION_SUMMARY_ALLOWANCE
        + compactionKeepRecentTokens(thresholdBudget.trigger ?? spec.model.contextWindow, fixedCostTokens),
      summaryOutputTokens: () => COMPACTION_SUMMARY_ALLOWANCE,
    }, lastRequestCacheTtlMs);
    // Last, so observers see the finished session — and before the caller can run a turn on it.
    await spec.onSpawned?.({ sessionId: spec.sessionId, messages: session.messages });
    return { session, applyCompaction, assessColdCompaction: assessCold };
  }
}
