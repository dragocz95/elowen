import type { Db } from './db.js';
import { stripControlChars } from '../shared/text.js';
import { DEFAULT_BINS, EXEC_NOTES, KNOWN_EXECS, execRefSpec, isAllowedExec, parseExecRef } from '../shared/execs.js';
import type { EmbeddingConfig } from '../embeddings/embeddingService.js';
import { HOSTED_TOOL_SEARCH_PROTOCOL } from '../shared/hostedToolSearchProtocol.js';
import { type BrainLimits, type BrainProviderCompatibility, type HostedToolSearchCapabilities, type HostedToolSearchCapability, type RuntimeConfig, type RuntimeLimits, type ToolDeferralOverrides } from '../shared/wireContract.js';
import { DEFAULT_MEMORY_RETENTION, type MemoryRetentionConfig } from '../brain/memoryVitality.js';

// The brain-limits shape is the daemon↔web wire contract (Settings → Elowen AI → Limits) — defined
// once in src/shared and re-exported here, so the two can never drift. The runtime block is its sibling
// group (Settings → Elowen AI → Runtime) and travels the same way.
export type { BrainLimits, RuntimeConfig };

/** How the memory subsystem generates embeddings. `providerId` references a brain provider whose API
 *  key is reused (no second secret is stored). `baseUrl` optionally overrides the provider's endpoint;
 *  `dimensions` (when set) is forwarded to the API and asserted against every returned vector's width.
 *  Empty `providerId`/`model` = embeddings disabled → retrieval degrades to keyword search. */
export interface EmbeddingBlock {
  providerId: string;
  model: string;
  baseUrl: string;
  dimensions: number | null;
}

// The bound every brain exec is judged against lives in brain/config.ts as configuredBrainProviders:
// it has to see connected OAuth accounts and the relay fallback, which serve models under ids that never
// appear in `brain.providers`, and a set that misses those would deny models the pickers legitimately offer.

/** Map the persisted embedding block to an EmbeddingService config. The API key is NOT carried here —
 *  EmbeddingService resolves it from the referenced brain provider (`providerId`) via its resolver.
 *  An empty `providerId`/`model` yields a config the embed queue treats as "not configured". */
export function toEmbeddingConfig(block: EmbeddingBlock): EmbeddingConfig {
  return {
    providerId: block.providerId || undefined,
    model: block.model,
    baseUrl: block.baseUrl || undefined,
    dimensions: block.dimensions ?? undefined,
  };
}

/** Memory categorization model config. `providerId` references a brain provider whose API key is reused
 *  at call time (no second secret is stored); `baseUrl` optionally overrides the provider's endpoint.
 *  Empty `providerId`/`model` = categorization disabled. Holds no secret → safe to expose verbatim. */
export interface CategorizationBlock {
  providerId: string;
  model: string;
  baseUrl: string;
}

/** Dashboard personalization (the daily digest + agent-written hero). `digest` names the model the
 *  generator runs on, same contract as `categorization` (provider key reused at call time, no secret);
 *  empty `providerId`/`model` = fall back to the categorization model. The greeting/pills toggles only
 *  FILTER what the recap route returns — generation always stores the full payload, so enabling one
 *  later costs no new inference. Holds no secret → safe to expose verbatim. */
export interface DashboardBlock {
  recapEnabled: boolean;
  digestEnabled: boolean;
  greetingEnabled: boolean;
  pillsEnabled: boolean;
  continueEnabled: boolean;
  digest: { providerId: string; model: string };
}

/** Shape-check a stored/patched dashboard block field-by-field: for read() the fallback is the
 *  default block, for update() it is the current block — which makes the same helper both the
 *  sanitizer and the per-field merge. */
function sanitizeDashboard(input: unknown, fallback: DashboardBlock): DashboardBlock {
  const p = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}) as {
    recapEnabled?: unknown; digestEnabled?: unknown; greetingEnabled?: unknown; pillsEnabled?: unknown;
    continueEnabled?: unknown; digest?: { providerId?: unknown; model?: unknown };
  };
  const bool = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);
  return {
    recapEnabled: bool(p.recapEnabled, fallback.recapEnabled),
    digestEnabled: bool(p.digestEnabled, fallback.digestEnabled),
    greetingEnabled: bool(p.greetingEnabled, fallback.greetingEnabled),
    pillsEnabled: bool(p.pillsEnabled, fallback.pillsEnabled),
    continueEnabled: bool(p.continueEnabled, fallback.continueEnabled),
    digest: {
      providerId: typeof p.digest?.providerId === 'string' ? p.digest.providerId : fallback.digest.providerId,
      model: typeof p.digest?.model === 'string' ? p.digest.model : fallback.digest.model,
    },
  };
}

interface ProviderConfig { bin: string; args: string; skipPermissions: boolean; resume: boolean }
type Providers = Record<string, ProviderConfig>;

export interface ElowenConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  allowedSkins: string[];
  modelNotes: Record<string, string>;
  providers: Providers;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number; trustProxy: boolean };
  /** Automatic cleanup of stale brain conversations. Off by default (opt-in): when on, an hourly janitor
   *  deletes user conversations whose last activity is older than `days`. Never touches running sessions,
   *  the active pointer, sessions with running children, delegated children, or platform channel sessions —
   *  only a user's own idle conversations. */
  sessionRetention: { enabled: boolean; days: number };
  /** When on, the hourly systemd timer (`elowen update --auto`) upgrades to the latest npm release and
   *  restarts the services. Off by default (opt-in). */
  autoUpdate: boolean;
  /** Web Push VAPID public key (safe to expose) + whether a keypair has been generated. The private
   *  key NEVER leaves the daemon — read it only via `webPushKeys()`. */
  webPush: { publicKey: string; publicKeySet: boolean };
  /** Contact address embedded in every push as the VAPID `sub` claim, so a push service can reach the
   *  operator about this instance. Apple REJECTS a token whose contact is not a real address (403
   *  BadJwtToken) and the send fails silently, so this must be a working `https://…` or `mailto:…`.
   *  Empty falls back to the instance URL when public, else the project URL. */
  webPushContact: string;
  /** Which plugins the admin has enabled, and which bundled ones were soft-removed (hidden from the
   *  installed list without deleting npm-owned files — restorable). Per-plugin config (which may hold
   *  secrets) is NOT exposed here — read it daemon-side via `pluginConfig(name)`. */
  plugins: { enabled: string[]; removed: string[] };
  /** The brain's dedicated model providers (public view: API keys stripped to `apiKeySet`). Empty →
   *  there is no configured API-key provider. `agentName` is the assistant's display
   *  identity ("Elowen" by default) — it feeds the persona prompts everywhere the brain speaks.
   *  `maxSteps` caps the agent's per-run model round-trips; `modelContextWindows` lets the operator pin a
   *  max context window per Elowen AI model (`providerId/model`) for endpoints that don't report one. */
  brain: { providers: BrainProviderPublic[]; agentName: string; maxSteps: number; modelContextWindows: Record<string, number>; limits: BrainLimits; hiddenOauth: string[] };
  /** Operator-tunable runtime knobs (Settings → Elowen AI → Runtime): the `!` shell timeout, the memory
   *  relevance floor, the deferred-tool policy, activity-log retention and the memory-retention block
   *  (auto-eviction toggle, grace window, vitality floor and per-importance half-lives). `limits.eventRetentionDays` is
   *  the always-on twin of `sessionRetention.days` above — kept here, with the other numeric knobs, because
   *  it is a pure ceiling with no opt-in of its own, where session retention is an off-by-default feature. */
  runtime: RuntimeConfigWithRetention;
  /** Memory embedding provider config (no secret — the API key comes from the referenced brain provider). */
  embedding: EmbeddingBlock;
  /** Memory categorization model (workspace-level; no secret — key reused from the brain provider). */
  categorization: CategorizationBlock;
  /** Dashboard personalization: daily digest + agent-written hero (no secret → public verbatim). */
  dashboard: DashboardBlock;
}

/** How a brain provider authenticates/talks upstream. `openai` = any OpenAI-compatible endpoint;
 *  `anthropic` = the Anthropic Messages API; `oauth-*` = a pi-ai OAuth account (no API key stored here —
 *  tokens live in the brain's AuthStorage file). */
export type BrainProviderType = 'openai' | 'anthropic' | 'oauth-anthropic' | 'oauth-github-copilot' | 'oauth-openai-codex' | 'oauth-kimi';

/** Which wire API an `openai`-type entry speaks. Absent → auto: the official OpenAI endpoint gets the
 *  Responses API (richer: server-side prompt caching, reasoning summaries), everything else the
 *  ubiquitous Chat Completions. */
export type BrainProviderApi = 'openai-completions' | 'openai-responses';

/** Safe baseline for an arbitrary OpenAI-compatible Chat Completions endpoint. Optional OpenAI
 *  extensions are fail-closed: the operator enables only what that endpoint documents. */
export const DEFAULT_OPENAI_COMPATIBILITY: BrainProviderCompatibility = {
  supportsDeveloperRole: false,
  supportsLongCacheRetention: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  supportsStore: false,
  supportsReasoningEffort: false,
  maxTokensField: 'max_completion_tokens',
};

interface BrainProviderPublic {
  id: string;
  label: string;
  type: BrainProviderType;
  baseUrl: string;
  /** Models offered in the picker. For `openai` providers an empty list means "auto-fetch /models". */
  models: string[];
  api?: BrainProviderApi;
  compatibility?: BrainProviderCompatibility;
  apiKeySet: boolean;
  /** Not a secret — the operator set it and needs to see it back. See BrainProviderStored.temperature. */
  temperature?: number;
}

interface BrainProviderStored {
  id: string; label: string; type: BrainProviderType; baseUrl: string; models: string[];
  api?: BrainProviderApi;
  compatibility?: BrainProviderCompatibility;
  apiKey: string | null;
  /** Sampling temperature for this endpoint. Absent → the field is never sent and the model's own default
   *  applies, which is the only safe default: some models accept nothing else (Kimi K3 answers
   *  `only 1 is allowed for this model`, Claude Opus 4.7+ rejects non-default values too). */
  temperature?: number;
}

/** A malformed capability falls back independently to the conservative baseline. One typo must not
 *  silently enable a different OpenAI extension, and unknown fields never reach the provider runtime. */
function sanitizeOpenAiCompatibility(input: unknown): BrainProviderCompatibility {
  const value = input && typeof input === 'object' ? input as Partial<Record<keyof BrainProviderCompatibility, unknown>> : {};
  const flag = (key: Exclude<keyof BrainProviderCompatibility, 'maxTokensField'>): boolean =>
    typeof value[key] === 'boolean' ? value[key] : DEFAULT_OPENAI_COMPATIBILITY[key];
  return {
    supportsDeveloperRole: flag('supportsDeveloperRole'),
    supportsLongCacheRetention: flag('supportsLongCacheRetention'),
    supportsUsageInStreaming: flag('supportsUsageInStreaming'),
    supportsStrictMode: flag('supportsStrictMode'),
    supportsStore: flag('supportsStore'),
    supportsReasoningEffort: flag('supportsReasoningEffort'),
    maxTokensField: value.maxTokensField === 'max_tokens' || value.maxTokensField === 'max_completion_tokens'
      ? value.maxTokensField : DEFAULT_OPENAI_COMPATIBILITY.maxTokensField,
  };
}

/** Keep only well-formed brain provider entries; drop anything with a missing id/type so a loose PUT
 *  can't persist a row the registry would choke on. */
function sanitizeBrainProviders(input: unknown): BrainProviderStored[] {
  if (!Array.isArray(input)) return [];
  const out: BrainProviderStored[] = [];
  const seen = new Set<string>();
  // Must list every BrainProviderType: this is a membership test, not an exhaustive one, so a type the
  // union gained and this array did not is dropped on save without a word.
  const TYPES: BrainProviderType[] = ['openai', 'anthropic', 'oauth-anthropic', 'oauth-github-copilot', 'oauth-openai-codex', 'oauth-kimi'];
  for (const v of input) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Partial<BrainProviderStored>;
    // Brain exec identity is `<provider>/<model>` and splits on the first slash, so a provider id carrying
    // `/` would make two distinct pairs serialize identically. Reject it at the persistence boundary.
    if (typeof p.id !== 'string' || !p.id || p.id.includes('/') || seen.has(p.id)) continue;
    if (!TYPES.includes(p.type as BrainProviderType)) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      label: typeof p.label === 'string' && p.label ? p.label : p.id,
      type: p.type as BrainProviderType,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string' && !!m) : [],
      // Wire-API and compatibility settings are meaningful only for OpenAI-type entries. Compatibility
      // is stored as a fully-resolved block, so the runtime and UI never infer different defaults.
      ...(p.type === 'openai' && (p.api === 'openai-responses' || p.api === 'openai-completions') ? { api: p.api } : {}),
      ...(p.type === 'openai' ? { compatibility: sanitizeOpenAiCompatibility(p.compatibility) } : {}),
      // Out-of-range or non-finite drops the field entirely rather than clamping: sending a temperature we
      // invented is worse than sending none, since "none" is a valid, working request everywhere.
      ...(typeof p.temperature === 'number' && Number.isFinite(p.temperature) && p.temperature >= 0 && p.temperature <= 2
        ? { temperature: p.temperature } : {}),
      apiKey: typeof p.apiKey === 'string' && p.apiKey ? p.apiKey : null,
    });
  }
  return out;
}

// Default executable name per agent program (resolveExecutor program ids). Derived from the shared
// executor table so program ids + their bins stay in one place (audit #43/S21).
const DEFAULT_PROVIDERS: Providers = Object.fromEntries(
  Object.entries(DEFAULT_BINS).map(([program, bin]) => [program, { bin, args: '', skipPermissions: true, resume: true }]),
);

/** Keep only well-formed provider entries ({ bin, args, skipPermissions, resume }). A malformed value
 *  (e.g. bin as a number from a hand-edited row or a loose PUT) is dropped, never persisted/returned —
 *  it would otherwise reach spawn() as an invalid executable. `skipPermissions` and `resume` both
 *  default to true when absent (older configs, or a partial PUT) so unattended agents keep bypassing
 *  permission prompts and resuming prior sessions unless the operator explicitly turns either off. */
function sanitizeProviders(input: unknown): Providers {
  if (!input || typeof input !== 'object') return {};
  const out: Providers = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as ProviderConfig).bin === 'string' && typeof (v as ProviderConfig).args === 'string') {
      const skip = (v as ProviderConfig).skipPermissions;
      const resume = (v as ProviderConfig).resume;
      out[k] = { bin: (v as ProviderConfig).bin, args: (v as ProviderConfig).args, skipPermissions: typeof skip === 'boolean' ? skip : true, resume: typeof resume === 'boolean' ? resume : true };
    }
  }
  return out;
}

/** Token TTL must be a whole number of days ≥ 1 (it feeds a SQLite date modifier). Anything
 *  invalid falls back to the current value. */
const clampTtlDays = (next: number | undefined, fallback: number): number =>
  typeof next === 'number' && Number.isFinite(next) && next >= 1 ? Math.floor(next) : fallback;

/** Default and bounds for the brain's per-run agent step ceiling. A whole number in [1, 200]; anything
 *  invalid falls back to the current value. Enforced in BrainService (turn_start counting → abort). */
const DEFAULT_MAX_STEPS = 200;
const clampMaxSteps = (next: number | undefined, fallback: number): number =>
  typeof next === 'number' && Number.isFinite(next) ? Math.min(1000, Math.max(1, Math.floor(next))) : fallback;

/** Operator-tunable brain limits — the constants that used to be hardcoded across the brain runtime,
 *  surfaced so the instance owner can trade cost/verbosity/latency to taste. Each is a whole number,
 *  clamped to a sane range; an unset/invalid field falls back to the current value (so a partial patch
 *  never wipes a sibling). Consumed at: messageView (tool-output preview), ElicitationRegistry
 *  (AskUserQuestion wait), MemoryService.retrieve (recall size), the goal loop (turn budget + YOLO
 *  safety ceiling), Channels (live-session LRU cap), and the subagent plugin (context handed to a
 *  delegated child / workflow node). The shape is the shared wire contract (re-exported above). */
export const DEFAULT_BRAIN_LIMITS: BrainLimits = {
  toolOutputMaxLines: 100,
  // Above Claude Code's BASH_MAX_OUTPUT_DEFAULT (30 000 chars): a truncated build or test log costs a
  // second run to read the part that was cut, which is dearer than the tokens the headroom spends.
  toolOutputMaxChars: 41_000,
  // A single result above this is spilled to disk and the model gets a placeholder instead
  // (toolResultClearing's size trigger). Claude Code's equivalent sits at 50 000.
  toolResultInlineBytes: 60_000,
  // Matches Claude Code's per-message budget: four full-size single results, ~50k tokens, the point at
  // which one turn's fan-out alone costs a quarter of a 200k window (toolResultClearing's group trigger).
  toolResultGroupBudgetBytes: 200_000,
  // Three failed automatic compactions in a row. PI's own retry budget is already spent INSIDE each
  // attempt, so three failures mean three exhausted retry chains — a transient provider outage does not
  // reach it, while an irrecoverable context wastes three calls rather than one per turn forever.
  compactionFailureLimit: 3,
  // Six hours: a question may legitimately wait out a working day rather than a session, and an
  // elicitation that expires unanswered costs the whole turn that was waiting on it.
  elicitationTimeoutMs: 21_600_000,
  memoryRecallCount: 10,
  // ~5000 tokens, the budget the hits SHARE — at memoryRecallCount that is ~2000 chars each, enough for
  // a memory carrying a decision and its reasoning to arrive whole instead of cut mid-sentence.
  memoryRecallChars: 20_000,
  // Recall during work injects small batches, but a long turn can move through several genuinely distinct
  // topics. The search ceiling prevents a no-result tool loop from issuing unbounded embeddings. 20 kB
  // covers the observed p90 of whole-turn injections (~19.8k characters) while capping the suffix at ~5k tokens.
  memoryLiveRecallPasses: 10,
  memoryLiveRecallCount: 2,
  memoryLiveRecallBytes: 20_000,
  // A goal worth starting autonomously routinely needs tens of turns. Budget and ceiling are set equal:
  // the ceiling exists to stop a runaway goal, not to cut short one that is still making progress.
  goalTurnBudget: 50,
  goalMaxTurns: 50,
  channelSessionCap: 32,
  delegateContextChars: 40_000,
};

/** Adjustable range of a tuning knob: its default ±50%, derived from the default so raising a default
 *  later carries its bound with it instead of leaving the two to drift apart. `maxOverride` exists for
 *  the one knob whose ceiling is set by a downstream cap rather than by this rule. */
const band = (key: keyof BrainLimits, maxOverride?: number): [min: number, max: number] => {
  const def = DEFAULT_BRAIN_LIMITS[key];
  return [Math.round(def / 2), maxOverride ?? Math.round(def * 1.5)];
};

const BRAIN_LIMIT_BOUNDS: Record<keyof BrainLimits, [min: number, max: number]> = {
  // The four ceilings below are raised past the ±50% rule at the instance owner's request: the rule
  // sizes a tuning margin around a sensible default, but these are the knobs an operator reaches for
  // when a single tool result or a recalled memory genuinely needs more room than the default allows.
  // In the editor's own unit (4 chars per token) that is ~20k tokens of tool output and ~5k of recall.
  toolOutputMaxLines: band('toolOutputMaxLines', 200),
  toolOutputMaxChars: band('toolOutputMaxChars', 80_000),
  // Plain ±50% rule (25 000–75 000): unlike the transcript-preview caps this is what the model actually
  // receives inline, so its tuning margin is the default band rather than a raised operator ceiling.
  toolResultInlineBytes: band('toolResultInlineBytes'),
  // Plain ±50% rule (100 000–300 000). The floor is what matters: it stays above the per-result ceiling
  // (90 000), so a group can always hold one full-size inline result and the aggregate layer can never be
  // tuned into spilling every result it sees. selectBudgetedToolResults re-floors it at the value in force.
  toolResultGroupBudgetBytes: band('toolResultGroupBudgetBytes'),
  // Exempt from the ±50% rule: 0 must NOT be reachable — it would trip the breaker before a session ever
  // attempted a compaction, i.e. silently mean "never compact automatically", which is the one outcome
  // this knob exists to prevent. 1 stops after a single failure; 10 is patient without being unbounded.
  compactionFailureLimit: [1, 10],
  // memoryRecallChars is the budget these hits SHARE, so raising the count alone makes each hit smaller:
  // at the char floor, 20 memories leave ~500 chars each and most get cut mid-sentence. An operator who
  // wants many memories wants the char budget raised with it — hence both ceilings.
  memoryRecallCount: band('memoryRecallCount', 20),
  // Ceiling doubled at the instance owner's request: ~10k tokens of recalled memory. The floor still
  // follows the default, so the extra range is headroom above it rather than a shifted band.
  memoryRecallChars: band('memoryRecallChars', 40_000),
  // Zero searches is the explicit live-recall kill switch. A cap remains necessary when repeated changing
  // work produces no injectable memory; without it, an agent tool loop could issue embeddings forever.
  memoryLiveRecallPasses: [0, 20],
  memoryLiveRecallCount: [0, 10],
  memoryLiveRecallBytes: band('memoryLiveRecallBytes', 40_000),
  // Raised past the ±50% rule at the owner's request to ~20k tokens of ceiling. It is bounded by
  // MAX_PROMPT_TOTAL_CHARS (brain/delegatedScope.ts), the budget packDelegatedPromptAppend fair-shares
  // with the child's role prompt — that budget was raised to 120 000 alongside this, so the value here
  // is now reachable rather than trimmed straight back off.
  delegateContextChars: band('delegateContextChars', 80_000),
  // Deliberately exempt from the ±50% rule: for these four the wide range is load-bearing, not a tuning
  // margin. The elicitation range reaches 6 hours — a question may legitimately wait out a whole working
  // day, not just a session — and the default sits at that ceiling. A busy channel may hold many more
  // live sessions than a quiet one, and the two goal knobs are one family — a per-goal budget that could
  // not approach its own ceiling would make the ceiling unreachable, so both span the same range.
  elicitationTimeoutMs: [30_000, 21_600_000],
  goalTurnBudget: [4, 500],
  goalMaxTurns: [8, 500],
  channelSessionCap: [4, 256],
};
/** Limits written before live recall became batch-based. Kept at this boundary so an old settings row
 *  cannot silently turn its former whole-turn count into an oversized per-batch count. */
interface LegacyLiveRecallLimits {
  memoryLiveRecallChars?: unknown;
}

function clampBrainLimit(key: keyof BrainLimits, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const [min, max] = BRAIN_LIMIT_BOUNDS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Merge a (possibly partial, possibly malformed) limits patch onto `fallback`, clamping each field to
 *  its bound and rounding to a whole number; a missing/invalid field keeps the fallback value. */
function clampBrainLimits(next: unknown, fallback: BrainLimits): BrainLimits {
  const patch = next && typeof next === 'object' && !Array.isArray(next)
    ? next as Partial<BrainLimits> & LegacyLiveRecallLimits
    : {};
  const out = { ...fallback };
  for (const key of Object.keys(BRAIN_LIMIT_BOUNDS) as (keyof BrainLimits)[]) {
    out[key] = clampBrainLimit(key, patch[key], out[key]);
  }

  if (Object.hasOwn(patch, 'memoryLiveRecallChars')) {
    // The old count capped a whole turn. Reusing it as a batch size would multiply context growth on the
    // very installations that had raised it, so retain only its explicit off state and otherwise reset it.
    const legacyDisabled = patch.memoryLiveRecallPasses === 0 || patch.memoryLiveRecallCount === 0;
    out.memoryLiveRecallCount = legacyDisabled ? 0 : DEFAULT_BRAIN_LIMITS.memoryLiveRecallCount;
    out.memoryLiveRecallBytes = clampBrainLimit(
      'memoryLiveRecallBytes', patch.memoryLiveRecallChars, out.memoryLiveRecallBytes,
    );
  }
  return out;
}

/** Operator-tunable runtime limits — the sibling group of DEFAULT_BRAIN_LIMITS, for the knobs that
 *  govern the runtime AROUND a turn rather than the turn's own budget. Consumed at: the chat CLI's `!`
 *  escape (local shell timeout), MemoryService (semantic relevance floor), the deferred-tool policy
 *  (LiveSessionSpawner), the hourly activity-log purge (bootstrap) and the web client's stream watchdog
 *  (`web/lib/streamWatchdog.ts`, which reads them off GET /config). Same contract as the brain limits:
 *  whole numbers, clamped per field, an unset/invalid field keeping the current value. */
const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  localShellTimeoutMs: 30_000,
  // 0.20 cosine, carried in per mille because the clamp rounds to a whole number — see RuntimeLimits.
  // Measured against the live store's pair distribution (p50 0.216), a floor of 0.30 discards the
  // majority of genuine matches; the duplicate/paraphrase thresholds above do the precision work.
  memorySemanticFloorPerMille: 200,
  // RE-MEASURED 24 Aug 2026 against the live store (332 memories, 54946 pairs, qwen3-embedding-8b): the
  // previous 720 was calibrated when the largest pair in the store was 0.765, and the corpus has since
  // grown past it — max is now 0.911 and 1030 pairs sit above 720. Reading the top pairs by hand found NO
  // true restatement anywhere, not even at 0.911 (two distinct findings about one supplier), so on long
  // technical notes written in one voice this cosine separates topic, not duplication: the p99 of pairs
  // where BOTH sides are merely long is already 0.774. 930 is therefore bounded from below by observation
  // — above every pair known to be distinct — and cannot be bounded from above, since the store holds no
  // duplicate to calibrate against. That asymmetry is why MemoryAdd only WARNS on a hit (memoryTools.ts):
  // too high costs a redundant memory the model can still merge, too low costs a curator overwrite.
  // Re-measure after changing the embedding model OR after the store grows substantially.
  memoryDuplicatePerMille: 930,
  // Recall-side, deliberately left alone: a false positive here only drops a search result. Worth
  // re-measuring on the same evidence though — 700 is below the 0.774 p99 above, so recall may be
  // spending its breadth on this check too.
  memoryParaphrasePerMille: 700,
  // 0.10 each, leaving 0.80 for semantic similarity.
  memoryImportanceWeightPerMille: 100,
  memoryVitalityWeightPerMille: 100,
  memoryCuratorMaxOps: 2,
  toolDeferThreshold: 10,
  eventRetentionDays: 30,
  // Thirty days of readable addresses: long enough to investigate a month's traffic pattern, short enough
  // that an address nobody looked at stops being stored as one. Must stay at or below eventRetentionDays
  // in practice — a longer horizon simply never fires, because the row is deleted first.
  originIpRetentionDays: 30,
  // Two and a half missed heartbeats on a watched page…
  streamSilenceLimitMs: 75_000,
  // …and a tighter one at a wake-up, where no watchdog tick could have run while the page slept.
  streamReviveSilenceLimitMs: 45_000,
  toastDurationMs: 4_500,
};

/** Hard floor under BOTH stream silence limits — a correctness bound, not a taste one. The daemon sends an
 *  SSE heartbeat every 30 s whether or not a turn is running, and that beat is the only reason silence is
 *  measurable at all; a limit at or below the beat interval fires in the ordinary gap BETWEEN two beats and
 *  tears down a perfectly healthy stream, on a loop. The 5 s on top absorbs scheduler and network jitter on
 *  a beat that did leave on time. The web client repeats this same floor on whatever value it receives
 *  (`MIN_SILENCE_LIMIT_MS` in `web/lib/streamWatchdog.ts`), because a browser cannot assume the daemon it
 *  is talking to is this version. */
const MIN_STREAM_SILENCE_MS = 35_000;

/** Whether deferred tools are computed at all. On by default — the threshold above already keeps small
 *  MCP surfaces untouched; this is the prod-safety switch that turns the mechanism off wholesale. */
const DEFAULT_TOOL_DEFERRAL_ENABLED = true;

/** Whether a delegated sub-agent turn executes in the forked runner process instead of on the daemon's
 *  own event loop. ON: in-process sub-agents share the daemon's single JS thread, so a fan-out starves the
 *  interactive path — measured at 20 concurrent children, the daemon's own CPU dropped from ~45% to ~5%
 *  once they moved out. The pool sizes itself from the machine, so this is safe on a small VPS too.
 *  `false` is still literally the pre-runner code path, so flipping it back is a rollback with no
 *  redeploy — which is why it stays a switch rather than becoming unconditional. */
const DEFAULT_SUBAGENT_RUNNER_ENABLED = true;

/** AUTO. The pool sizes itself from the machine, which is the whole point — a hard-coded default would be
 *  wrong on either a 2-core VPS or a 16-core server, and probably on both. The operator sets a number only
 *  when the machine's own inputs cannot be trusted (see RuntimeConfig.subagentRunnerPoolMax). */
const DEFAULT_SUBAGENT_RUNNER_POOL_MAX: number | null = null;

/** Whether a ChatGPT-account session compacts through the provider's opaque compaction instead of a text
 *  summary. OFF: the endpoint is an undocumented beta, and the trade is real in both directions — the
 *  blob carries the compacted stretch far more faithfully than prose, so it is on by default: the session
 *  factory already narrows it to openai-codex, and a provider that cannot produce a blob falls back to the
 *  very text summary this replaces, which makes trying it strictly better than not. The cost is that the
 *  compaction note clients render is a marker no human can read. The switch stays as the kill switch for
 *  an endpoint OpenAI does not document; turning it off restores the text-summary path byte for byte,
 *  because that path never stopped being the fallback. */
const DEFAULT_REMOTE_COMPACTION_ENABLED = true;

/** Detailed request capture is additive and guarded by admin-only reads in the later API phase. ON by
 * default so exact history starts accumulating immediately; false stops new writes without deleting data. */
const DEFAULT_PROVIDER_REQUEST_CAPTURE_ENABLED = true;

/** Normalize the pool knob off a patch. Anything that is not `null` or a non-negative integer is not an
 *  answer to "how many runners" — it is corruption or a typo, and taking it would silently resize the
 *  pool — so the current value is kept instead. */
function sanitizePoolMax(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

/** Every bound here is written out rather than derived from the default (the ±50% `band()` rule the brain
 *  limits use): each of these has a domain range that the default sits inside rather than centres —
 *  a 10s floor is what makes a `!` timeout survivable, and cosine similarity has no meaning past ~0.8. */
const RUNTIME_LIMIT_BOUNDS: Record<keyof RuntimeLimits, [min: number, max: number]> = {
  localShellTimeoutMs: [10_000, 300_000],
  memorySemanticFloorPerMille: [100, 800],
  // Both floored at 0.50: below that, memories that merely share a topic start counting as the same fact,
  // and for the duplicate threshold that means overwriting one memory with another. The 0.98 ceiling is
  // where a threshold stops firing at all — which is exactly the defect these two replaced.
  memoryDuplicatePerMille: [500, 980],
  memoryParaphrasePerMille: [500, 980],
  // Capped at 0.30 each, so semantic similarity can never fall below 0.40 of the score no matter how both
  // are set. Past that the ranking stops answering the question that was asked.
  memoryImportanceWeightPerMille: [0, 300],
  memoryVitalityWeightPerMille: [0, 300],
  // 0 disables automatic writing; past a handful per exchange the curator is transcribing, not curating.
  memoryCuratorMaxOps: [0, 6],
  // Below 1 the threshold would defer a session holding a single MCP tool, which costs a prompt-cache
  // break for nothing; past 100 no realistic MCP surface would ever engage it.
  toolDeferThreshold: [1, 100],
  eventRetentionDays: [1, 365],
  // Same range as the log retention above, and for the same reason: a day is the shortest horizon that
  // still lets anyone look at yesterday, a year the longest anyone can call a retention window.
  originIpRetentionDays: [1, 365],
  // The pair shares one floor because they measure the same thing against the same heartbeat; the ceiling
  // is five minutes, past which a dead stream is no longer worth calling detected.
  streamSilenceLimitMs: [MIN_STREAM_SILENCE_MS, 300_000],
  streamReviveSilenceLimitMs: [MIN_STREAM_SILENCE_MS, 300_000],
  // A toast is a glance, not a panel: under two seconds the sentence is gone before it is read, and past
  // fifteen it stops reading as a notice and starts reading as state the page is holding open.
  toastDurationMs: [2_000, 15_000],
};

/** Merge a (possibly partial, possibly malformed) runtime-limits patch onto `fallback` — same per-field
 *  clamp + whole-number rounding as the brain limits, so a partial patch never wipes a sibling. */
function clampRuntimeLimits(next: Partial<RuntimeLimits> | undefined, fallback: RuntimeLimits): RuntimeLimits {
  const out = { ...fallback };
  for (const key of Object.keys(RUNTIME_LIMIT_BOUNDS) as (keyof RuntimeLimits)[]) {
    const v = next?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const [min, max] = RUNTIME_LIMIT_BOUNDS[key];
      out[key] = Math.min(max, Math.max(min, Math.round(v)));
    }
  }
  return out;
}

/** The runtime block as stored/served: the wire RuntimeConfig plus the memory-retention group. The wire
 *  contract deliberately does NOT carry the retention shape — it would have to import it from
 *  brain/memoryVitality.ts, which already imports `MemoryRow` from the contract (a cycle). The daemon's
 *  stored view extends the wire type; web/lib/types.ts mirrors the block on its side. */
type RuntimeConfigWithRetention = RuntimeConfig & { memoryRetention: MemoryRetentionConfig };

/** Memory-retention bounds: a grace window up to a year, an eviction floor up to 90/100 (the floor is a
 *  0..100 vitality, so 90 leaves the top decile out of reach of the sweep), and half-lives up to a
 *  quarter year — the vitality score itself carries the retention curve, so a longer knob would only be
 *  noise; keeping a memory forever is what the 0 "never" sentinel is for. 0 must stay reachable, so the
 *  ranges are clamped, not shifted. Unlike the numeric runtime limits these are NOT rounded to whole
 *  numbers: a half-life of 0.4 days is a legitimate fast decay and `Math.round` would turn it into 0 —
 *  the "never" sentinel — silently. */
const RETENTION_BOUNDS = {
  graceDays: [0, 365] as const,
  vitalityFloor: [0, 90] as const,
  halfLife: [0, 90] as const,
};
const RETENTION_IMPORTANCE_KEYS = [1, 2, 3, 4, 5] as const;

/** A fresh copy of the default retention block — the half-life map is nested, so a plain spread would
 *  share one object between every config instance and a caller could mutate a sibling's defaults. */
const defaultMemoryRetention = (): MemoryRetentionConfig => ({
  ...DEFAULT_MEMORY_RETENTION,
  halfLifeByImportance: { ...DEFAULT_MEMORY_RETENTION.halfLifeByImportance },
});

/** Merge a (possibly partial, possibly malformed) memory-retention patch onto `fallback` — per-field,
 *  like the runtime limits: a missing/invalid field keeps the fallback, a present number is clamped to
 *  its bound. The half-life map merges per importance key, so a patch tuning one level leaves the rest. */
function clampMemoryRetention(next: Partial<MemoryRetentionConfig> | undefined, fallback: MemoryRetentionConfig): MemoryRetentionConfig {
  const clamp = (v: number | undefined, [min, max]: readonly [number, number], cur: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : cur;
  const halfLives: Record<number, number> = { ...fallback.halfLifeByImportance };
  for (const key of RETENTION_IMPORTANCE_KEYS) {
    // The spread guarantees every 1..5 key exists; the ?? only satisfies the indexed-read type.
    const cur = halfLives[key] ?? 0;
    halfLives[key] = clamp(next?.halfLifeByImportance?.[key], RETENTION_BOUNDS.halfLife, cur);
  }
  return {
    enabled: typeof next?.enabled === 'boolean' ? next.enabled : fallback.enabled,
    graceDays: clamp(next?.graceDays, RETENTION_BOUNDS.graceDays, fallback.graceDays),
    vitalityFloor: clamp(next?.vitalityFloor, RETENTION_BOUNDS.vitalityFloor, fallback.vitalityFloor),
    halfLifeByImportance: halfLives,
  };
}

/** Per-model context-window overrides, keyed `providerId/model`. Some endpoints don't report a reliable
 *  max token count, so the operator can pin one. Keep only positive whole numbers; drop anything else. */
function sanitizeContextWindows(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k && typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  return out;
}

/** Keep only the non-empty string members of a stored/patched list, dropping any malformed entries. */
/** The skins an account may choose between, as the operator listed them. Grammar-checked only: the
 *  daemon cannot know which skins a given web build actually compiled — that registry is a build
 *  artifact of `web/`, exactly as it is for the ELOWEN_SKIN env var — so an unrecognized name here is
 *  filtered by the browser, which does know, rather than rejected by a daemon guessing. What IS enforced
 *  is the single-segment grammar, because the value ends up in a DOM attribute, plus deduplication and a
 *  bound, so a hand-written config cannot grow an unbounded list. Order is the operator's and is kept:
 *  it is the order the switcher cycles through. */
function sanitizeSkinList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const name = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue;
    seen.add(name);
    if (seen.size >= 32) break;
  }
  return [...seen];
}

function sanitizeStringList(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function canonicalExec(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const ref = parseExecRef(input);
  if (!ref) return null;
  return ref.program === 'elowen' ? execRefSpec(ref) : input;
}

function sanitizeExecList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map(canonicalExec).filter((v): v is string => v !== null);
}

function canonicalizePluginExecConfig(config: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const out = { ...config };
  for (const [name, field] of [['discord', 'visionModel'], ['whatsapp', 'visionModel'], ['image-gen', 'model'], ['image-edit', 'model']] as const) {
    const slice = out[name];
    if (!slice) continue;
    const value = canonicalExec(slice[field]);
    out[name] = value ? { ...slice, [field]: value } : slice;
  }
  return out;
}

/** Keep only well-formed custom-model entries ({ label, exec }, both non-empty strings). A malformed
 *  entry — e.g. a numeric `exec` from a hand-edited row or a loose PUT — is dropped rather than
 *  persisted, since a model picker would otherwise render it as a broken/undefined option. */
function sanitizeCustomModels(input: unknown): { label: string; exec: string }[] {
  if (!Array.isArray(input)) return [];
  const out: { label: string; exec: string }[] = [];
  for (const v of input) {
    if (!v || typeof v !== 'object') continue;
    const { label, exec } = v as Partial<{ label: unknown; exec: unknown }>;
    const canonical = canonicalExec(exec);
    if (typeof label === 'string' && label && canonical) out.push({ label, exec: canonical });
  }
  return out;
}

/** Keep only the string-valued entries of a model-notes map. A non-string value (e.g. a stray number
 *  from a hand-edited row or a loose PUT) would otherwise reach `modelsBlock()`'s `.trim()` and throw,
 *  breaking auto-model planning until the row is repaired by hand (review-api-store-sol, finding 7). */
function sanitizeModelNotes(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[canonicalExec(k) ?? k] = v;
  }
  return out;
}

const TOOL_LOADING_MODES = new Set(['immediate', 'deferred']);
const PLUGIN_SOURCE_ID_RE = /^plugin:[a-z0-9][a-z0-9-]{1,63}$/;

function isToolDeferralSourceId(value: string): boolean {
  return value === 'builtin' || PLUGIN_SOURCE_ID_RE.test(value);
}

/** Keep persisted user overrides owner-qualified and structurally valid. Unknown but well-formed plugin
 *  source ids deliberately survive: an override must outlive a temporarily disabled plugin. */
function sanitizeToolDeferralOverrides(input: unknown): ToolDeferralOverrides {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { sources: {}, tools: {} };
  const raw = input as { sources?: unknown; tools?: unknown };
  const sources: ToolDeferralOverrides['sources'] = {};
  const tools: ToolDeferralOverrides['tools'] = {};
  if (raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)) {
    for (const [sourceId, mode] of Object.entries(raw.sources as Record<string, unknown>)) {
      if (isToolDeferralSourceId(sourceId) && TOOL_LOADING_MODES.has(mode as string)) {
        sources[sourceId] = mode as ToolDeferralOverrides['sources'][string];
      }
    }
  }
  if (raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools)) {
    for (const [sourceId, sourceTools] of Object.entries(raw.tools as Record<string, unknown>)) {
      if (!isToolDeferralSourceId(sourceId) || !sourceTools || typeof sourceTools !== 'object' || Array.isArray(sourceTools)) continue;
      const sanitizedTools: Record<string, ToolDeferralOverrides['sources'][string]> = {};
      for (const [toolName, mode] of Object.entries(sourceTools as Record<string, unknown>)) {
        if (toolName.trim() && TOOL_LOADING_MODES.has(mode as string)) {
          sanitizedTools[toolName] = mode as ToolDeferralOverrides['sources'][string];
        }
      }
      if (Object.keys(sanitizedTools).length > 0) tools[sourceId] = sanitizedTools;
    }
  }
  return { sources, tools };
}

function sanitizeHostedToolSearchCapabilities(input: unknown): HostedToolSearchCapabilities {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: HostedToolSearchCapabilities = {};
  for (const [providerId, providerModels] of Object.entries(input as Record<string, unknown>)) {
    if (!providerId.trim() || !providerModels || typeof providerModels !== 'object' || Array.isArray(providerModels)) continue;
    const models: HostedToolSearchCapabilities[string] = {};
    for (const [modelId, raw] of Object.entries(providerModels as Record<string, unknown>)) {
      if (!modelId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      if ((value.status !== 'supported' && value.status !== 'unsupported')
        || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt)
        || value.protocol !== HOSTED_TOOL_SEARCH_PROTOCOL) continue;
      models[modelId] = {
        status: value.status,
        fingerprint: value.fingerprint,
        checkedAt: Math.max(0, Math.floor(value.checkedAt)),
        protocol: HOSTED_TOOL_SEARCH_PROTOCOL,
      };
    }
    if (Object.keys(models).length > 0) out[providerId] = models;
  }
  return out;
}

const DEFAULT_CONFIG: ElowenConfig = {
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  allowedSkins: [],
  modelNotes: { ...EXEC_NOTES },
  providers: { ...DEFAULT_PROVIDERS },
  defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 2 },
  // trustProxy on by default: the install wizard writes the nginx vhost itself, and that vhost is what
  // sets X-Real-IP. An install that puts the daemon behind something else (or nothing) turns it off, and
  // every recorded origin degrades to "claimed, unverified" instead of silently looking authoritative.
  security: { tokenTtlDays: 30, trustProxy: true },
  // On, at ten days: an idle conversation older than that is history nobody reopens, and left to
  // accumulate it is what turns the message store into the largest table in the database.
  sessionRetention: { enabled: true, days: 10 },
  autoUpdate: false,
  webPush: { publicKey: '', publicKeySet: false },
  webPushContact: '',
  // A fresh install is a BARE ASSISTANT: everything that makes the agent capable without being
  // configured first ships on (read/write files, run commands, search the codebase, ask the user,
  // delegate, schedule, answer questions about Elowen itself), and nothing else. elowen-docs is how it
  // looks a setting up before changing it; codebase and mcp stay inert until an embedding provider
  // resp. a server is configured; lsp degrades to an honest "not installed" per language.
  //
  // What is deliberately NOT here: a plugin that owns a DOMAIN VERTICAL — its own pages in the main
  // navigation, tables and object lifecycle (the editor is the current example). A new install must not
  // open onto someone else's product; the owner installs those from Settings → Plugins when wanted. The
  // fresh-default suite derives that rule from the manifests (`web.nav`), so it cannot rot into a
  // name list nobody updates. Existing editor installs are retained by migrateEditorPlugin.
  //
  // The chat platforms stay OFF because each declares a required credential, and a plugin that ships on
  // may not open by asking for one — also enforced by the fresh-default suite.
  //
  // What is listed here is what ships IN the package. Extensions that carry no daemon dependency now
  // live in the plugin registry and are installed from Settings → Plugins instead, so they cannot be
  // enabled by default: they are not on disk until someone asks for them.
  plugins: {
    enabled: [
      'files', 'sandbox', 'terminal', 'askuser', 'runtime-context', 'subagent', 'elowen-docs',
      'statusline', 'mcp',
    ],
    removed: [],
  },
  brain: { providers: [], agentName: 'Elowen', maxSteps: DEFAULT_MAX_STEPS, modelContextWindows: {}, limits: { ...DEFAULT_BRAIN_LIMITS }, hiddenOauth: [] },
  runtime: { limits: { ...DEFAULT_RUNTIME_LIMITS }, toolDeferralEnabled: DEFAULT_TOOL_DEFERRAL_ENABLED, toolDeferralOverrides: { sources: {}, tools: {} }, hostedToolSearch: {}, subagentRunnerEnabled: DEFAULT_SUBAGENT_RUNNER_ENABLED, subagentRunnerPoolMax: DEFAULT_SUBAGENT_RUNNER_POOL_MAX, remoteCompactionEnabled: DEFAULT_REMOTE_COMPACTION_ENABLED, providerRequestCaptureEnabled: DEFAULT_PROVIDER_REQUEST_CAPTURE_ENABLED, memoryRetention: defaultMemoryRetention() },
  embedding: { providerId: '', model: '', baseUrl: '', dimensions: null },
  categorization: { providerId: '', model: '', baseUrl: '' },
  // Greeting/pills are opt-in: they replace a core surface (the hero) for every account on the
  // instance, so an upgrade must not flip anyone's landing page by itself.
  dashboard: { recapEnabled: true, digestEnabled: true, greetingEnabled: false, pillsEnabled: false, continueEnabled: true, digest: { providerId: '', model: '' } },
};

interface Stored {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  allowedSkins: string[];
  modelNotes: Record<string, string>;
  providers: Providers;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number; trustProxy: boolean };
  sessionRetention: { enabled: boolean; days: number };
  autoUpdate: boolean;
  /** FROZEN: the pre-extraction live-diagnostics toggle. The `lsp` plugin owns the live flag now
   *  (plugins.config.lsp.diagnosticsEnabled); this field is kept, and kept readable, ONLY as the source
   *  migrateLspPlugin() copies from — so a rollback to a build that still reads it finds the setting the
   *  operator had AT MIGRATION TIME (later flips land in the plugin slice and do not travel back here).
   *  Nothing writes it any more: it is absent from the public view, and `configPatchSchema` REJECTS it
   *  rather than accepting a write it would silently drop. */
  lspEnabled: boolean;
  /** Persisted VAPID keypair; null until generated on first boot. Private key stays daemon-side. */
  webPush: { publicKey: string; privateKey: string } | null;
  webPushContact: string;
  /** Enabled plugin names, soft-removed (hidden) bundled plugin names, + each plugin's own config slice
   *  (secrets included, never serialized to API). */
  plugins: { enabled: string[]; removed: string[]; config: Record<string, Record<string, unknown>> };
  /** One-shot upgrade marker: the `lsp` plugin (the extracted, previously-core language-server
   *  subsystem) has been auto-enabled AND the core `lspEnabled` toggle COPIED into
   *  plugins.config.lsp.diagnosticsEnabled for this pre-existing install. See migrateLspPlugin(). */
  lspPluginMigrated: boolean;
  /** One-shot upgrade marker for the extracted project editor plugin. */
  editorPluginMigrated: boolean;
  /** One-shot handoff from Terminal's legacy isolation setting to the bundled Sandbox owner. */
  sandboxPluginMigrated: boolean;
  /** Brain provider entries with plaintext API keys — stripped to `apiKeySet` in the public view. */
  brain: { providers: BrainProviderStored[]; agentName: string; maxSteps: number; modelContextWindows: Record<string, number>; limits: BrainLimits; hiddenOauth: string[] };
  /** Runtime knobs. Holds no secret → surfaced verbatim in the public view. */
  runtime: RuntimeConfigWithRetention;
  /** Embedding provider config. Holds no secret (the key is reused from the brain provider), so this
   *  block is safe to surface verbatim in the public view. */
  embedding: EmbeddingBlock;
  /** Categorization model config. Holds no secret (key reused from the brain provider) → public verbatim. */
  categorization: CategorizationBlock;
  /** Dashboard personalization block. Holds no secret → public verbatim. */
  dashboard: DashboardBlock;
}

/** The plugins block for a settings row that predates the plugin system (or whose plugins block is
 *  malformed): NO plugins enabled. This is a DELIBERATE asymmetry with `defaultStored()`, which enables
 *  `DEFAULT_CONFIG.plugins.enabled` for FRESH installs — an existing install must never have new default
 *  plugins silently turned on by an upgrade. Do NOT "reconcile" this to DEFAULT_CONFIG.plugins.enabled.
 *  A fresh object each call so a caller can never mutate a shared default. */
const legacyEmptyPlugins = (): Stored['plugins'] => ({ enabled: [], removed: [], config: {} });

const RETIRED_DOMAIN_PLUGINS = new Set(['agents', 'work']);

/** Retired domain plugins are removed from every persisted plugin collection at the config boundary.
 *  This also discards their config slices (including legacy credentials) on the next settings write, so
 *  deleting the old migration markers cannot resurrect either plugin on a later boot. */
function sanitizePlugins(input: unknown, fallback: Stored['plugins']): Stored['plugins'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback;
  const raw = input as Partial<Stored['plugins']>;
  const keep = (name: string): boolean => !RETIRED_DOMAIN_PLUGINS.has(name);
  const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
    ? canonicalizePluginExecConfig(Object.fromEntries(Object.entries(raw.config).filter(([name]) => keep(name))) as Record<string, Record<string, unknown>>)
    : {};
  return {
    enabled: (Array.isArray(raw.enabled) ? sanitizeStringList(raw.enabled) : []).filter(keep),
    removed: (Array.isArray(raw.removed) ? sanitizeStringList(raw.removed) : []).filter(keep),
    config,
  };
}

const defaultStored = (): Stored => ({
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  allowedSkins: [],
  modelNotes: { ...EXEC_NOTES },
  providers: { ...DEFAULT_PROVIDERS },
  defaults: { ...DEFAULT_CONFIG.defaults },
  security: { ...DEFAULT_CONFIG.security },
  sessionRetention: { ...DEFAULT_CONFIG.sessionRetention },
  autoUpdate: false,
  lspEnabled: true,
  webPush: null,
  webPushContact: '',
  plugins: { enabled: [...DEFAULT_CONFIG.plugins.enabled], removed: [], config: {} },
  // A fresh row already enables `lsp` and needs no toggle copy: the plugin's own default (on) applies.
  lspPluginMigrated: true,
  editorPluginMigrated: true,
  sandboxPluginMigrated: true,
  brain: { providers: [], agentName: 'Elowen', maxSteps: DEFAULT_MAX_STEPS, modelContextWindows: {}, limits: { ...DEFAULT_BRAIN_LIMITS }, hiddenOauth: [] },
  runtime: { limits: { ...DEFAULT_RUNTIME_LIMITS }, toolDeferralEnabled: DEFAULT_CONFIG.runtime.toolDeferralEnabled, toolDeferralOverrides: { sources: {}, tools: {} }, hostedToolSearch: {}, subagentRunnerEnabled: DEFAULT_CONFIG.runtime.subagentRunnerEnabled, subagentRunnerPoolMax: DEFAULT_CONFIG.runtime.subagentRunnerPoolMax, remoteCompactionEnabled: DEFAULT_CONFIG.runtime.remoteCompactionEnabled, providerRequestCaptureEnabled: DEFAULT_CONFIG.runtime.providerRequestCaptureEnabled, memoryRetention: defaultMemoryRetention() },
  embedding: { ...DEFAULT_CONFIG.embedding },
  categorization: { ...DEFAULT_CONFIG.categorization },
  dashboard: { ...DEFAULT_CONFIG.dashboard, digest: { ...DEFAULT_CONFIG.dashboard.digest } },
});

export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  allowedSkins?: string[];
  modelNotes?: Record<string, string>;
  providers?: Providers;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
  security?: { tokenTtlDays?: number; trustProxy?: boolean };
  sessionRetention?: { enabled?: boolean; days?: number };
  autoUpdate?: boolean;
  webPushContact?: string;
  plugins?: { enabled?: string[]; removed?: string[]; config?: Record<string, Record<string, unknown>> };
  /** Brain providers replace wholesale (the UI edits the full list). A patched entry with an empty/absent
   *  apiKey KEEPS the currently stored key for that id — the UI never sees (or resends) secrets. */
  brain?: { providers?: unknown; agentName?: unknown; maxSteps?: number; modelContextWindows?: Record<string, number>; limits?: Partial<BrainLimits>; hiddenOauth?: string[] };
  /** Runtime knobs merged per-field (like the brain limits): a patch tuning one slider leaves the rest. */
  runtime?: { limits?: Partial<RuntimeLimits>; toolDeferralEnabled?: boolean; toolDeferralOverrides?: ToolDeferralOverrides; subagentRunnerEnabled?: boolean; subagentRunnerPoolMax?: number | null; remoteCompactionEnabled?: boolean; providerRequestCaptureEnabled?: boolean; memoryRetention?: Partial<MemoryRetentionConfig> };
  /** Embedding config is merged per-field; `dimensions: null` clears the width hint. */
  embedding?: { providerId?: string; model?: string; baseUrl?: string; dimensions?: number | null };
  /** Categorization config merged per-field (like embedding). */
  categorization?: { providerId?: string; model?: string; baseUrl?: string };
  /** Dashboard block merged per-field (like categorization). */
  dashboard?: { recapEnabled?: boolean; digestEnabled?: boolean; greetingEnabled?: boolean; pillsEnabled?: boolean; continueEnabled?: boolean; digest?: { providerId?: string; model?: string } };
}

/** The agent display name feeds the same sinks a theme's brand name does — terminals (control chars =
 *  OSC injection) and the `<name>…</name>` slot of the system prompt (`<`/`>` would break its structure)
 *  — so it gets the same cleanup the ThemeStore applies, or the config half of one and the same value
 *  would be the unguarded path. */
function sanitizeAgentName(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const cleaned = stripControlChars(v).replace(/[<>]/g, '').trim();
  return cleaned ? cleaned.slice(0, 40) : fallback;
}

export class ConfigStore {
  constructor(private db: Db) {}

  private read(): Stored {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (!row) return defaultStored();
    try {
      const p = JSON.parse(row.data) as Partial<Stored>;
      const d = defaultStored();
      // `as Partial<Stored>` is only a compile-time hint — a hand-edited or legacy row can hold the
      // wrong runtime shape (e.g. allowedExecs as a string), which would crash callers that .map it.
      // So each typed field is shape-checked; a bad value falls back to its default.
      return {
        // Element-level sanitisers, not just an Array.isArray check: a database written by an older
        // build (or hand-edited) can hold an array whose elements are the wrong runtime type.
        allowedExecs: Array.isArray(p.allowedExecs) ? sanitizeExecList(p.allowedExecs) : d.allowedExecs,
        customModels: sanitizeCustomModels(p.customModels),
        hiddenPresets: Array.isArray(p.hiddenPresets) ? sanitizeExecList(p.hiddenPresets) : [],
        allowedSkins: sanitizeSkinList(p.allowedSkins),
        // Seed built-in notes under any stored notes so known models always carry a description,
        // while user edits (including an explicit '' to clear one) take precedence.
        modelNotes: (p.modelNotes && typeof p.modelNotes === 'object' && !Array.isArray(p.modelNotes)) ? { ...d.modelNotes, ...sanitizeModelNotes(p.modelNotes) } : { ...d.modelNotes },
        providers: { ...d.providers, ...sanitizeProviders(p.providers) },
        defaults: { exec: canonicalExec(p.defaults?.exec) ?? d.defaults.exec, autonomy: p.defaults?.autonomy ?? d.defaults.autonomy, maxSessions: p.defaults?.maxSessions ?? d.defaults.maxSessions },
        security: {
          tokenTtlDays: p.security?.tokenTtlDays ?? d.security.tokenTtlDays,
          trustProxy: typeof p.security?.trustProxy === 'boolean' ? p.security.trustProxy : d.security.trustProxy,
        },
        sessionRetention: {
          enabled: typeof p.sessionRetention?.enabled === 'boolean' ? p.sessionRetention.enabled : d.sessionRetention.enabled,
          days: p.sessionRetention?.days ?? d.sessionRetention.days,
        },
        autoUpdate: typeof p.autoUpdate === 'boolean' ? p.autoUpdate : d.autoUpdate,
        lspEnabled: typeof p.lspEnabled === 'boolean' ? p.lspEnabled : d.lspEnabled,
        webPushContact: typeof p.webPushContact === 'string' ? p.webPushContact.trim() : d.webPushContact,
        // Both halves of the keypair must be non-empty strings, else treat as not-yet-generated.
        webPush: (p.webPush && typeof p.webPush.publicKey === 'string' && p.webPush.publicKey.length > 0
          && typeof p.webPush.privateKey === 'string' && p.webPush.privateKey.length > 0)
          ? { publicKey: p.webPush.publicKey, privateKey: p.webPush.privateKey } : null,
        // Existing row: honour its explicit enabled/removed lists (empty when malformed — the legacy
        // "no plugins" decision, never the fresh-install defaults). Absent block → legacyEmptyPlugins().
        plugins: sanitizePlugins(p.plugins, legacyEmptyPlugins()),
        lspPluginMigrated: p.lspPluginMigrated === true,
        editorPluginMigrated: p.editorPluginMigrated === true,
        sandboxPluginMigrated: p.sandboxPluginMigrated === true,
        brain: {
          providers: sanitizeBrainProviders(p.brain?.providers),
          agentName: sanitizeAgentName(p.brain?.agentName, 'Elowen'),
          maxSteps: clampMaxSteps(p.brain?.maxSteps, d.brain.maxSteps),
          modelContextWindows: sanitizeContextWindows(p.brain?.modelContextWindows),
          limits: clampBrainLimits(p.brain?.limits, d.brain.limits),
          hiddenOauth: sanitizeStringList(p.brain?.hiddenOauth),
        },
        runtime: {
          limits: clampRuntimeLimits(p.runtime?.limits, d.runtime.limits),
          toolDeferralEnabled: typeof p.runtime?.toolDeferralEnabled === 'boolean' ? p.runtime.toolDeferralEnabled : d.runtime.toolDeferralEnabled,
          toolDeferralOverrides: sanitizeToolDeferralOverrides(p.runtime?.toolDeferralOverrides),
          hostedToolSearch: sanitizeHostedToolSearchCapabilities(p.runtime?.hostedToolSearch),
          subagentRunnerEnabled: typeof p.runtime?.subagentRunnerEnabled === 'boolean' ? p.runtime.subagentRunnerEnabled : d.runtime.subagentRunnerEnabled,
          subagentRunnerPoolMax: p.runtime?.subagentRunnerPoolMax !== undefined ? sanitizePoolMax(p.runtime.subagentRunnerPoolMax, d.runtime.subagentRunnerPoolMax) : d.runtime.subagentRunnerPoolMax,
          remoteCompactionEnabled: typeof p.runtime?.remoteCompactionEnabled === 'boolean' ? p.runtime.remoteCompactionEnabled : d.runtime.remoteCompactionEnabled,
          providerRequestCaptureEnabled: typeof p.runtime?.providerRequestCaptureEnabled === 'boolean' ? p.runtime.providerRequestCaptureEnabled : d.runtime.providerRequestCaptureEnabled,
          memoryRetention: clampMemoryRetention(p.runtime?.memoryRetention, d.runtime.memoryRetention),
        },
        embedding: {
          providerId: typeof p.embedding?.providerId === 'string' ? p.embedding.providerId : d.embedding.providerId,
          model: typeof p.embedding?.model === 'string' ? p.embedding.model : d.embedding.model,
          baseUrl: typeof p.embedding?.baseUrl === 'string' ? p.embedding.baseUrl : d.embedding.baseUrl,
          dimensions: typeof p.embedding?.dimensions === 'number' && Number.isFinite(p.embedding.dimensions) ? p.embedding.dimensions : null,
        },
        categorization: {
          providerId: typeof p.categorization?.providerId === 'string' ? p.categorization.providerId : d.categorization.providerId,
          model: typeof p.categorization?.model === 'string' ? p.categorization.model : d.categorization.model,
          baseUrl: typeof p.categorization?.baseUrl === 'string' ? p.categorization.baseUrl : d.categorization.baseUrl,
        },
        dashboard: sanitizeDashboard(p.dashboard, d.dashboard),
      };
    } catch { return defaultStored(); } // corrupt row → defaults, never throw
  }

  private write(s: Stored): void {
    this.db.prepare('INSERT INTO settings (id, data) VALUES (1, @data) ON CONFLICT(id) DO UPDATE SET data = @data')
      .run({ data: JSON.stringify(s) });
  }

  get(): ElowenConfig {
    const s = this.read();
    return {
      allowedExecs: s.allowedExecs,
      customModels: s.customModels,
      hiddenPresets: s.hiddenPresets,
      allowedSkins: s.allowedSkins,
      modelNotes: s.modelNotes,
      providers: s.providers,
      defaults: s.defaults,
      security: s.security,
      sessionRetention: s.sessionRetention,
      autoUpdate: s.autoUpdate,
      // Only the public key is exposed; `publicKeySet` reflects whether a full keypair exists.
      webPush: { publicKey: s.webPush?.publicKey ?? '', publicKeySet: !!s.webPush },
      webPushContact: s.webPushContact,
      // Only the enabled + removed lists surface; per-plugin config (possible secrets) stays daemon-side.
      plugins: { enabled: s.plugins.enabled, removed: s.plugins.removed },
      brain: { providers: s.brain.providers.map(({ apiKey, ...pub }) => ({ ...pub, apiKeySet: !!apiKey })), agentName: s.brain.agentName, maxSteps: s.brain.maxSteps, modelContextWindows: s.brain.modelContextWindows, limits: s.brain.limits, hiddenOauth: s.brain.hiddenOauth },
      // No secret in the runtime block → expose verbatim (the CLI reads its `!` timeout from here).
      runtime: s.runtime,
      // No secret in the embedding block (the key is reused from the brain provider) → expose verbatim.
      embedding: s.embedding,
      // Likewise no secret in the categorization block → expose verbatim.
      categorization: s.categorization,
      dashboard: s.dashboard,
    };
  }

  /** The full VAPID keypair (private included) for the daemon-side push sender — never serialized to
   *  any API response. Null until generated on first boot. */
  webPushKeys(): { publicKey: string; privateKey: string } | null { return this.read().webPush; }

  /** Persist a freshly generated VAPID keypair. */
  setWebPushKeys(keys: { publicKey: string; privateKey: string }): void {
    this.write({ ...this.read(), webPush: { publicKey: keys.publicKey, privateKey: keys.privateKey } });
  }

  /** Persist one server-verified hosted-search capability. Generic config PATCH cannot forge this map. */
  setHostedToolSearchCapability(providerId: string, modelId: string, capability: HostedToolSearchCapability): void {
    const current = this.read();
    const hostedToolSearch = structuredClone(current.runtime.hostedToolSearch);
    hostedToolSearch[providerId] = { ...(hostedToolSearch[providerId] ?? {}), [modelId]: capability };
    this.write({ ...current, runtime: { ...current.runtime, hostedToolSearch } });
  }

  /** Whether a settings row has been persisted (i.e. config has been saved at least once). */
  hasSettings(): boolean {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
  }

  /** One-shot cleanup of retired PR/agents/work settings. It mutates the raw object so unrelated unknown
   * installation keys survive, but it never copies the unowned GitHub token into another namespace. */
  migrateRetiredPluginConfig(): void {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (!row) return;
    let root: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.data) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      root = parsed as Record<string, unknown>;
    } catch { return; }

    let changed = false;
    for (const key of Object.keys(root)) {
      if (key === 'ghToken' || key === 'autopilot' || /^(agents|work).*Migrated\d*$/.test(key)) {
        delete root[key];
        changed = true;
      }
    }
    const plugins = root.plugins;
    if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
      const block = plugins as { enabled?: unknown; removed?: unknown; config?: unknown };
      for (const listKey of ['enabled', 'removed'] as const) {
        if (!Array.isArray(block[listKey])) continue;
        const next = block[listKey].filter((name) => name !== 'agents' && name !== 'work');
        if (next.length !== block[listKey].length) { block[listKey] = next; changed = true; }
      }
      if (block.config && typeof block.config === 'object' && !Array.isArray(block.config)) {
        const slices = block.config as Record<string, unknown>;
        for (const name of ['agents', 'work']) {
          if (Object.hasOwn(slices, name)) { delete slices[name]; changed = true; }
        }
      }
    }
    if (changed) this.db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(root));
  }

  /** One-shot upgrade for the LSP extraction: enable the `lsp` plugin for EXISTING installs and COPY
   *  (never move — `lspEnabled` keeps its value so a rollback finds this choice) the live-diagnostics toggle
   *  into plugins.config.lsp.diagnosticsEnabled, where the plugin reads it.
   *
   *  `lsp` is not a new capability but the extracted, previously-CORE language-server subsystem, so
   *  skipping this would silently take diagnostics away
   *  from an install that already had them. An existing plugins.config.lsp value wins (an admin who
   *  already configured the slice is not overwritten). Runs once per install (the persisted marker), so
   *  an admin who later disables the plugin — or flips the toggle — stays where they put it.
   *  Daemon-only, like its siblings. */
  migrateLspPlugin(): void {
    if (!this.hasSettings()) return;
    const cur = this.read();
    if (cur.lspPluginMigrated) return;
    const enabled = cur.plugins.enabled.includes('lsp') ? cur.plugins.enabled : [...cur.plugins.enabled, 'lsp'];
    const slice: Record<string, unknown> = { ...cur.plugins.config['lsp'] };
    if (slice['diagnosticsEnabled'] === undefined) slice['diagnosticsEnabled'] = cur.lspEnabled;
    this.write({
      ...cur,
      plugins: { ...cur.plugins, enabled, config: { ...cur.plugins.config, lsp: slice } },
      lspPluginMigrated: true,
    });
  }

  /** Preserve the previously-core editor on existing installs once, without undoing a later disable. */
  migrateEditorPlugin(): void {
    if (!this.hasSettings()) return;
    const cur = this.read();
    if (cur.editorPluginMigrated) return;
    const enabled = cur.plugins.enabled.includes('editor') ? cur.plugins.enabled : [...cur.plugins.enabled, 'editor'];
    this.write({ ...cur, plugins: { ...cur.plugins, enabled }, editorPluginMigrated: true });
  }

  /** Transfer Terminal's legacy isolation ownership to Sandbox exactly once. The old Terminal key remains
   * stored for one rollback release, but current Terminal code never reads it. An existing Sandbox value
   * wins, and installations that did not enable Terminal gain no new shell capability. */
  migrateSandboxPlugin(): void {
    if (!this.hasSettings()) return;
    const cur = this.read();
    if (cur.sandboxPluginMigrated) return;
    if (!cur.plugins.enabled.includes('terminal')) {
      this.write({ ...cur, sandboxPluginMigrated: true });
      return;
    }
    const enabledWithoutSandbox = cur.plugins.enabled.filter((name) => name !== 'sandbox');
    const terminalAt = enabledWithoutSandbox.indexOf('terminal');
    const enabled = [...enabledWithoutSandbox];
    enabled.splice(terminalAt < 0 ? enabled.length : terminalAt, 0, 'sandbox');
    const sandboxConfig = { ...cur.plugins.config['sandbox'] };
    const legacy = cur.plugins.config['terminal']?.['sandboxNonAdmins'];
    if (sandboxConfig['confineNonOperators'] === undefined && typeof legacy === 'boolean') {
      sandboxConfig['confineNonOperators'] = legacy;
    }
    this.write({
      ...cur,
      plugins: {
        enabled,
        removed: cur.plugins.removed.filter((name) => name !== 'sandbox'),
        config: { ...cur.plugins.config, sandbox: sandboxConfig },
      },
      sandboxPluginMigrated: true,
    });
  }

  update(patch: ConfigPatch): ElowenConfig {
    const cur = this.read();
    // The default exec must resolve to a real program — mirror the API's allowedExecs guard so an admin
    // cannot persist a bare bogus spec that resolveExecutor would turn into a non-existent CLI model.
    // Element-level sanitised regardless of source: a stored value is already clean (idempotent), while a
    // patched one might not be — the API's Zod schema is the first gate, this is the second.
    const allowed = sanitizeExecList(patch.allowedExecs ?? cur.allowedExecs);
    const defaultExec = this.normalizeExec(patch.defaults?.exec, cur.defaults.exec, allowed, cur.defaults.exec);
    this.write({
      allowedExecs: allowed,
      customModels: sanitizeCustomModels(patch.customModels ?? cur.customModels),
      hiddenPresets: sanitizeExecList(patch.hiddenPresets ?? cur.hiddenPresets),
      allowedSkins: patch.allowedSkins !== undefined ? sanitizeSkinList(patch.allowedSkins) : cur.allowedSkins,
      modelNotes: sanitizeModelNotes(patch.modelNotes ?? cur.modelNotes),
      providers: patch.providers ? { ...cur.providers, ...sanitizeProviders(patch.providers) } : cur.providers,
      defaults: { exec: defaultExec, autonomy: patch.defaults?.autonomy ?? cur.defaults.autonomy, maxSessions: patch.defaults?.maxSessions ?? cur.defaults.maxSessions },
      // Clamp to a sane positive integer — the value is interpolated into a SQL date modifier.
      security: {
        tokenTtlDays: clampTtlDays(patch.security?.tokenTtlDays, cur.security.tokenTtlDays),
        trustProxy: typeof patch.security?.trustProxy === 'boolean' ? patch.security.trustProxy : cur.security.trustProxy,
      },
      // `days` feeds the same kind of SQLite date modifier, so it takes the same positive-integer clamp.
      sessionRetention: {
        enabled: typeof patch.sessionRetention?.enabled === 'boolean' ? patch.sessionRetention.enabled : cur.sessionRetention.enabled,
        days: clampTtlDays(patch.sessionRetention?.days, cur.sessionRetention.days),
      },
      autoUpdate: patch.autoUpdate ?? cur.autoUpdate,
      // Carried, never patched: the live diagnostics flag is the lsp plugin's config slice now, and this
      // frozen copy exists only so migrateLspPlugin() (and a rollback) can still read the old value.
      lspEnabled: cur.lspEnabled,
      webPush: cur.webPush, // VAPID keys are managed via setWebPushKeys, never through the config patch
      webPushContact: typeof patch.webPushContact === 'string' ? patch.webPushContact.trim() : cur.webPushContact,
      // Merge per-plugin config so a patch touching one plugin never wipes another's slice, then sweep
      // retired domain names/slices in one place (including legacy credentials under config.agents).
      plugins: sanitizePlugins({
        enabled: patch.plugins?.enabled ?? cur.plugins.enabled,
        removed: patch.plugins?.removed ?? cur.plugins.removed,
        config: patch.plugins?.config ? { ...cur.plugins.config, ...patch.plugins.config } : cur.plugins.config,
      }, cur.plugins),
      lspPluginMigrated: cur.lspPluginMigrated,
      editorPluginMigrated: cur.editorPluginMigrated,
      sandboxPluginMigrated: cur.sandboxPluginMigrated,
      brain: {
        providers: patch.brain?.providers !== undefined
          ? sanitizeBrainProviders(patch.brain.providers).map((p) => ({
              ...p,
              // An entry arriving without a key keeps the stored one — the public view never carries
              // secrets, so the UI round-trips entries keyless and only sets apiKey when (re)entered.
              apiKey: p.apiKey ?? cur.brain.providers.find((c) => c.id === p.id)?.apiKey ?? null,
            }))
          : cur.brain.providers,
        agentName: sanitizeAgentName(patch.brain?.agentName, cur.brain.agentName),
        maxSteps: clampMaxSteps(patch.brain?.maxSteps, cur.brain.maxSteps),
        // Context-window overrides replace wholesale (the UI edits the full map).
        modelContextWindows: patch.brain?.modelContextWindows !== undefined
          ? sanitizeContextWindows(patch.brain.modelContextWindows)
          : cur.brain.modelContextWindows,
        // Limits merge per-field onto the current values (a partial patch tunes one knob without
        // resetting the rest) and each field is clamped to its bound.
        limits: clampBrainLimits(patch.brain?.limits, cur.brain.limits),
        // Hidden OAuth types replace wholesale (the UI sends the full list); a display filter only, never
        // touching credentials or provider entries.
        hiddenOauth: patch.brain?.hiddenOauth !== undefined ? sanitizeStringList(patch.brain.hiddenOauth) : cur.brain.hiddenOauth,
      },
      // Same per-field merge + clamp as the brain limits above; the kill switch keeps its current value
      // unless the patch carries a real boolean.
      runtime: {
        limits: clampRuntimeLimits(patch.runtime?.limits, cur.runtime.limits),
        toolDeferralEnabled: typeof patch.runtime?.toolDeferralEnabled === 'boolean' ? patch.runtime.toolDeferralEnabled : cur.runtime.toolDeferralEnabled,
        // Overrides replace wholesale: omitting a key is how the UI restores its inherited policy.
        // Overrides replace wholesale: omitting a key is how the UI restores its inherited policy.
        toolDeferralOverrides: patch.runtime?.toolDeferralOverrides !== undefined
          ? sanitizeToolDeferralOverrides(patch.runtime.toolDeferralOverrides)
          : cur.runtime.toolDeferralOverrides,
        // Probe-owned, read-only through the generic config API. Provider/model changes invalidate at
        // route resolution via the endpoint fingerprint rather than accepting a client-spoofed status.
        hostedToolSearch: cur.runtime.hostedToolSearch,
        subagentRunnerEnabled: typeof patch.runtime?.subagentRunnerEnabled === 'boolean' ? patch.runtime.subagentRunnerEnabled : cur.runtime.subagentRunnerEnabled,
        subagentRunnerPoolMax: patch.runtime?.subagentRunnerPoolMax !== undefined ? sanitizePoolMax(patch.runtime.subagentRunnerPoolMax, cur.runtime.subagentRunnerPoolMax) : cur.runtime.subagentRunnerPoolMax,
        remoteCompactionEnabled: typeof patch.runtime?.remoteCompactionEnabled === 'boolean' ? patch.runtime.remoteCompactionEnabled : cur.runtime.remoteCompactionEnabled,
        providerRequestCaptureEnabled: typeof patch.runtime?.providerRequestCaptureEnabled === 'boolean' ? patch.runtime.providerRequestCaptureEnabled : cur.runtime.providerRequestCaptureEnabled,
        memoryRetention: clampMemoryRetention(patch.runtime?.memoryRetention, cur.runtime.memoryRetention),
      },
      embedding: {
        providerId: patch.embedding?.providerId ?? cur.embedding.providerId,
        model: patch.embedding?.model ?? cur.embedding.model,
        baseUrl: patch.embedding?.baseUrl ?? cur.embedding.baseUrl,
        // A patched `dimensions` (including an explicit null to clear it) wins; a non-finite value is
        // normalized to null so a bad hand-edited patch can't persist NaN.
        dimensions: patch.embedding?.dimensions !== undefined
          ? (typeof patch.embedding.dimensions === 'number' && Number.isFinite(patch.embedding.dimensions) ? patch.embedding.dimensions : null)
          : cur.embedding.dimensions,
      },
      categorization: {
        providerId: patch.categorization?.providerId ?? cur.categorization.providerId,
        model: patch.categorization?.model ?? cur.categorization.model,
        baseUrl: patch.categorization?.baseUrl ?? cur.categorization.baseUrl,
      },
      // The same field-by-field helper read() uses; with `cur` as the fallback it IS the merge.
      dashboard: sanitizeDashboard(patch.dashboard, cur.dashboard),
    });
    return this.get();
  }

  /** The persisted embedding block (daemon-side). Empty `providerId`/`model` → embeddings disabled.
   *  Map it to an EmbeddingService config via `toEmbeddingConfig`. */
  embeddingConfig(): EmbeddingBlock { return this.read().embedding; }

  /** The persisted categorization block (daemon-side). Empty `providerId`/`model` → categorization
   *  disabled. The categorizer's inference client is built in bootstrap from the referenced brain
   *  provider (endpoint+key), so no mapper is needed here. */
  categorizationConfig(): CategorizationBlock { return this.read().categorization; }

  /** The persisted dashboard block (daemon-side). The digest inference client is built in bootstrap
   *  from the referenced brain provider, falling back to the categorization model when unset. */
  dashboardConfig(): DashboardBlock { return this.read().dashboard; }

  /** Daemon-side brain provider list including plaintext API keys. Never routed to any client. */
  brainProviders(): { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string[]; api?: BrainProviderApi; compatibility?: BrainProviderCompatibility; apiKey: string | null; temperature?: number }[] {
    return this.read().brain.providers;
  }

  /** A plugin's own config slice (secrets included). Daemon-side only — never routed to any client. */
  pluginConfig(name: string): Record<string, unknown> {
    return this.read().plugins.config[name] ?? {};
  }

  /** Resolve an exec field on update: keep the current value when the patch omits it; accept a
   *  patched value only if it's allow-listed/well-formed (isAllowedExec), otherwise fall back to
   *  `onInvalid` so an invalid spec is never persisted. */
  private normalizeExec(next: string | undefined, current: string, allowed: readonly string[], onInvalid: string): string {
    const value = next === undefined ? current : next;
    const canonical = canonicalExec(value);
    return canonical && isAllowedExec(canonical, allowed) ? canonical : onInvalid;
  }
}
