import type { Db } from './db.js';
import { defaultPromptTemplate } from '../overseer/planner.js';
import { DEFAULT_BINS, EXEC_NOTES, KNOWN_EXECS, isAllowedExec } from '../shared/execs.js';
import type { EmbeddingConfig } from '../embeddings/embeddingService.js';

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

interface ProviderConfig { bin: string; args: string; skipPermissions: boolean; resume: boolean }
export type Providers = Record<string, ProviderConfig>;

export interface ElowenConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  modelNotes: Record<string, string>;
  autopilot: { model: string; overseerModel: string; apiUrl: string; providerId: string; apiKeySet: boolean; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean; tddMode: boolean; prEnabled: boolean; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string; ghTokenSet: boolean };
  providers: Providers;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number };
  /** When on, the hourly systemd timer (`elowen update --auto`) upgrades to the latest npm release and
   *  restarts the services — but only while no mission is running. Off by default (opt-in). */
  autoUpdate: boolean;
  /** Live language diagnostics (LSP) after edits. Persisted so the `/lsp` toggle survives a daemon
   *  restart; the daemon seeds the runtime LspManager from this at boot. On by default. */
  lspEnabled: boolean;
  /** Web Push VAPID public key (safe to expose) + whether a keypair has been generated. The private
   *  key NEVER leaves the daemon — read it only via `webPushKeys()`. */
  webPush: { publicKey: string; publicKeySet: boolean };
  /** Which plugins the admin has enabled, and which bundled ones were soft-removed (hidden from the
   *  installed list without deleting npm-owned files — restorable). Per-plugin config (which may hold
   *  secrets) is NOT exposed here — read it daemon-side via `pluginConfig(name)`. */
  plugins: { enabled: string[]; removed: string[] };
  /** The brain's dedicated model providers (public view: API keys stripped to `apiKeySet`). Empty →
   *  the brain falls back to the autopilot relay endpoint. `agentName` is the assistant's display
   *  identity ("Elowen" by default) — it feeds the persona prompts everywhere the brain speaks.
   *  `maxSteps` caps the agent's per-run model round-trips; `modelContextWindows` lets the operator pin a
   *  max context window per Elowen AI model (`providerId/model`) for endpoints that don't report one. */
  brain: { providers: BrainProviderPublic[]; agentName: string; maxSteps: number; modelContextWindows: Record<string, number>; limits: BrainLimits };
  /** Memory embedding provider config (no secret — the API key comes from the referenced brain provider). */
  embedding: EmbeddingBlock;
  /** Memory categorization model (workspace-level; no secret — key reused from the brain provider). */
  categorization: CategorizationBlock;
}

/** How a brain provider authenticates/talks upstream. `openai` = any OpenAI-compatible endpoint;
 *  `anthropic` = the Anthropic Messages API; `oauth-*` = a pi-ai OAuth account (no API key stored here —
 *  tokens live in the brain's AuthStorage file). */
export type BrainProviderType = 'openai' | 'anthropic' | 'oauth-anthropic' | 'oauth-github-copilot' | 'oauth-openai-codex';

/** Which wire API an `openai`-type entry speaks. Absent → auto: the official OpenAI endpoint gets the
 *  Responses API (richer: server-side prompt caching, reasoning summaries), everything else the
 *  ubiquitous Chat Completions. */
export type BrainProviderApi = 'openai-completions' | 'openai-responses';

interface BrainProviderPublic {
  id: string;
  label: string;
  type: BrainProviderType;
  baseUrl: string;
  /** Models offered in the picker. For `openai` providers an empty list means "auto-fetch /models". */
  models: string[];
  api?: BrainProviderApi;
  apiKeySet: boolean;
}

interface BrainProviderStored {
  id: string; label: string; type: BrainProviderType; baseUrl: string; models: string[];
  api?: BrainProviderApi;
  apiKey: string | null;
}

/** Keep only well-formed brain provider entries; drop anything with a missing id/type so a loose PUT
 *  can't persist a row the registry would choke on. */
function sanitizeBrainProviders(input: unknown): BrainProviderStored[] {
  if (!Array.isArray(input)) return [];
  const out: BrainProviderStored[] = [];
  const seen = new Set<string>();
  const TYPES: BrainProviderType[] = ['openai', 'anthropic', 'oauth-anthropic', 'oauth-github-copilot', 'oauth-openai-codex'];
  for (const v of input) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Partial<BrainProviderStored>;
    if (typeof p.id !== 'string' || !p.id || seen.has(p.id)) continue;
    if (!TYPES.includes(p.type as BrainProviderType)) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      label: typeof p.label === 'string' && p.label ? p.label : p.id,
      type: p.type as BrainProviderType,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string' && !!m) : [],
      // Wire-API override is only meaningful for openai-type entries; anything else drops to auto.
      ...(p.type === 'openai' && (p.api === 'openai-responses' || p.api === 'openai-completions') ? { api: p.api } : {}),
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
const DEFAULT_MAX_STEPS = 20;
const clampMaxSteps = (next: number | undefined, fallback: number): number =>
  typeof next === 'number' && Number.isFinite(next) ? Math.min(200, Math.max(1, Math.floor(next))) : fallback;

/** Operator-tunable brain limits — the constants that used to be hardcoded across the brain runtime,
 *  surfaced so the instance owner can trade cost/verbosity/latency to taste. Each is a whole number,
 *  clamped to a sane range; an unset/invalid field falls back to the current value (so a partial patch
 *  never wipes a sibling). Consumed at: messageView (tool-output preview), ElicitationRegistry
 *  (ask_user_question wait), MemoryService.retrieve (recall size), the goal loop (turn budget + YOLO
 *  safety ceiling), and Channels (live-session LRU cap). */
export interface BrainLimits {
  toolOutputMaxLines: number;
  toolOutputMaxChars: number;
  elicitationTimeoutMs: number;
  memoryRecallCount: number;
  memoryRecallChars: number;
  goalTurnBudget: number;
  goalMaxTurns: number;
  channelSessionCap: number;
}
export const DEFAULT_BRAIN_LIMITS: BrainLimits = {
  toolOutputMaxLines: 80,
  toolOutputMaxChars: 12000,
  elicitationTimeoutMs: 300_000,
  memoryRecallCount: 6,
  memoryRecallChars: 1500,
  goalTurnBudget: 8,
  goalMaxTurns: 64,
  channelSessionCap: 32,
};
const BRAIN_LIMIT_BOUNDS: Record<keyof BrainLimits, [min: number, max: number]> = {
  toolOutputMaxLines: [20, 400],
  toolOutputMaxChars: [2000, 50_000],
  elicitationTimeoutMs: [30_000, 1_800_000],
  memoryRecallCount: [1, 20],
  memoryRecallChars: [300, 8000],
  goalTurnBudget: [1, 50],
  goalMaxTurns: [8, 500],
  channelSessionCap: [4, 256],
};
/** Merge a (possibly partial, possibly malformed) limits patch onto `fallback`, clamping each field to
 *  its bound and rounding to a whole number; a missing/invalid field keeps the fallback value. */
function clampBrainLimits(next: Partial<BrainLimits> | undefined, fallback: BrainLimits): BrainLimits {
  const out = { ...fallback };
  for (const key of Object.keys(BRAIN_LIMIT_BOUNDS) as (keyof BrainLimits)[]) {
    const v = next?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const [min, max] = BRAIN_LIMIT_BOUNDS[key];
      out[key] = Math.min(max, Math.max(min, Math.round(v)));
    }
  }
  return out;
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

const DEFAULT_CONFIG: ElowenConfig = {
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  modelNotes: { ...EXEC_NOTES },
  autopilot: { model: 'gpt-4o-mini', overseerModel: '', apiUrl: 'https://api.openai.com/v1', providerId: '', apiKeySet: false, notes: '', prompt: defaultPromptTemplate(), pilotExec: '', overseerExec: '', reviewOnDone: false, tddMode: false, prEnabled: false, prBaseBranch: '', prAutoOpen: false, prVerifyCommand: '', ghTokenSet: false },
  providers: { ...DEFAULT_PROVIDERS },
  defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 },
  security: { tokenTtlDays: 30 },
  autoUpdate: false,
  lspEnabled: true,
  webPush: { publicKey: '', publicKeySet: false },
  plugins: { enabled: ['files', 'terminal', 'askuser', 'runtime-context', 'skills', 'subagent'], removed: [] },
  brain: { providers: [], agentName: 'Elowen', maxSteps: DEFAULT_MAX_STEPS, modelContextWindows: {}, limits: { ...DEFAULT_BRAIN_LIMITS } },
  embedding: { providerId: '', model: '', baseUrl: '', dimensions: null },
  categorization: { providerId: '', model: '', baseUrl: '' },
};

interface Stored {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  modelNotes: Record<string, string>;
  autopilot: { model: string; overseerModel: string; apiUrl: string; providerId: string; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean; tddMode: boolean; prEnabled: boolean; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string };
  providers: Providers;
  apiKey: string | null;
  ghToken: string | null;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number };
  autoUpdate: boolean;
  lspEnabled: boolean;
  /** Persisted VAPID keypair; null until generated on first boot. Private key stays daemon-side. */
  webPush: { publicKey: string; privateKey: string } | null;
  /** Enabled plugin names, soft-removed (hidden) bundled plugin names, + each plugin's own config slice
   *  (secrets included, never serialized to API). */
  plugins: { enabled: string[]; removed: string[]; config: Record<string, Record<string, unknown>> };
  /** Brain provider entries with plaintext API keys — stripped to `apiKeySet` in the public view. */
  brain: { providers: BrainProviderStored[]; agentName: string; maxSteps: number; modelContextWindows: Record<string, number>; limits: BrainLimits };
  /** Embedding provider config. Holds no secret (the key is reused from the brain provider), so this
   *  block is safe to surface verbatim in the public view. */
  embedding: EmbeddingBlock;
  /** Categorization model config. Holds no secret (key reused from the brain provider) → public verbatim. */
  categorization: CategorizationBlock;
}

/** The plugins block for a settings row that predates the plugin system (or whose plugins block is
 *  malformed): NO plugins enabled. This is a DELIBERATE asymmetry with `defaultStored()`, which enables
 *  `DEFAULT_CONFIG.plugins.enabled` for FRESH installs — an existing install must never have new default
 *  plugins silently turned on by an upgrade. Do NOT "reconcile" this to DEFAULT_CONFIG.plugins.enabled.
 *  A fresh object each call so a caller can never mutate a shared default. */
const legacyEmptyPlugins = (): Stored['plugins'] => ({ enabled: [], removed: [], config: {} });

const defaultStored = (): Stored => ({
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  modelNotes: { ...EXEC_NOTES },
  autopilot: { model: DEFAULT_CONFIG.autopilot.model, overseerModel: '', apiUrl: DEFAULT_CONFIG.autopilot.apiUrl, providerId: '', notes: '', prompt: DEFAULT_CONFIG.autopilot.prompt, pilotExec: '', overseerExec: '', reviewOnDone: false, tddMode: false, prEnabled: false, prBaseBranch: '', prAutoOpen: false, prVerifyCommand: '' },
  providers: { ...DEFAULT_PROVIDERS },
  apiKey: null,
  ghToken: null,
  defaults: { ...DEFAULT_CONFIG.defaults },
  security: { ...DEFAULT_CONFIG.security },
  autoUpdate: false,
  lspEnabled: true,
  webPush: null,
  plugins: { enabled: [...DEFAULT_CONFIG.plugins.enabled], removed: [], config: {} },
  brain: { providers: [], agentName: 'Elowen', maxSteps: DEFAULT_MAX_STEPS, modelContextWindows: {}, limits: { ...DEFAULT_BRAIN_LIMITS } },
  embedding: { providerId: '', model: '', baseUrl: '', dimensions: null },
  categorization: { providerId: '', model: '', baseUrl: '' },
});

export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  modelNotes?: Record<string, string>;
  autopilot?: { model?: string; overseerModel?: string; apiUrl?: string; providerId?: string; apiKey?: string; notes?: string; prompt?: string; pilotExec?: string; overseerExec?: string; reviewOnDone?: boolean; tddMode?: boolean; prEnabled?: boolean; prBaseBranch?: string; prAutoOpen?: boolean; prVerifyCommand?: string; ghToken?: string };
  providers?: Providers;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
  security?: { tokenTtlDays?: number };
  autoUpdate?: boolean;
  lspEnabled?: boolean;
  plugins?: { enabled?: string[]; removed?: string[]; config?: Record<string, Record<string, unknown>> };
  /** Brain providers replace wholesale (the UI edits the full list). A patched entry with an empty/absent
   *  apiKey KEEPS the currently stored key for that id — the UI never sees (or resends) secrets. */
  brain?: { providers?: unknown; agentName?: unknown; maxSteps?: number; modelContextWindows?: Record<string, number>; limits?: Partial<BrainLimits> };
  /** Embedding config is merged per-field (like autopilot); `dimensions: null` clears the width hint. */
  embedding?: { providerId?: string; model?: string; baseUrl?: string; dimensions?: number | null };
  /** Categorization config merged per-field (like embedding). */
  categorization?: { providerId?: string; model?: string; baseUrl?: string };
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
        allowedExecs: Array.isArray(p.allowedExecs) ? p.allowedExecs : d.allowedExecs,
        customModels: Array.isArray(p.customModels) ? p.customModels : [],
        hiddenPresets: Array.isArray(p.hiddenPresets) ? p.hiddenPresets : [],
        // Seed built-in notes under any stored notes so known models always carry a description,
        // while user edits (including an explicit '' to clear one) take precedence.
        modelNotes: (p.modelNotes && typeof p.modelNotes === 'object' && !Array.isArray(p.modelNotes)) ? { ...d.modelNotes, ...(p.modelNotes as Record<string, string>) } : { ...d.modelNotes },
        autopilot: { model: p.autopilot?.model ?? d.autopilot.model, overseerModel: p.autopilot?.overseerModel ?? d.autopilot.overseerModel, apiUrl: p.autopilot?.apiUrl ?? d.autopilot.apiUrl, providerId: p.autopilot?.providerId ?? d.autopilot.providerId, notes: p.autopilot?.notes ?? d.autopilot.notes, prompt: p.autopilot?.prompt ?? d.autopilot.prompt, pilotExec: p.autopilot?.pilotExec ?? d.autopilot.pilotExec, overseerExec: p.autopilot?.overseerExec ?? d.autopilot.overseerExec, reviewOnDone: p.autopilot?.reviewOnDone ?? d.autopilot.reviewOnDone, tddMode: p.autopilot?.tddMode ?? d.autopilot.tddMode, prEnabled: p.autopilot?.prEnabled ?? d.autopilot.prEnabled, prBaseBranch: p.autopilot?.prBaseBranch ?? d.autopilot.prBaseBranch, prAutoOpen: p.autopilot?.prAutoOpen ?? d.autopilot.prAutoOpen, prVerifyCommand: p.autopilot?.prVerifyCommand ?? d.autopilot.prVerifyCommand },
        providers: { ...d.providers, ...sanitizeProviders(p.providers) },
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : null,
        ghToken: typeof p.ghToken === 'string' ? p.ghToken : null,
        defaults: { exec: p.defaults?.exec ?? d.defaults.exec, autonomy: p.defaults?.autonomy ?? d.defaults.autonomy, maxSessions: p.defaults?.maxSessions ?? d.defaults.maxSessions },
        security: { tokenTtlDays: p.security?.tokenTtlDays ?? d.security.tokenTtlDays },
        autoUpdate: typeof p.autoUpdate === 'boolean' ? p.autoUpdate : d.autoUpdate,
        lspEnabled: typeof p.lspEnabled === 'boolean' ? p.lspEnabled : d.lspEnabled,
        // Both halves of the keypair must be non-empty strings, else treat as not-yet-generated.
        webPush: (p.webPush && typeof p.webPush.publicKey === 'string' && p.webPush.publicKey.length > 0
          && typeof p.webPush.privateKey === 'string' && p.webPush.privateKey.length > 0)
          ? { publicKey: p.webPush.publicKey, privateKey: p.webPush.privateKey } : null,
        // Existing row: honour its explicit enabled/removed lists (empty when malformed — the legacy
        // "no plugins" decision, never the fresh-install defaults). Absent block → legacyEmptyPlugins().
        plugins: (p.plugins && typeof p.plugins === 'object' && !Array.isArray(p.plugins))
          ? {
              enabled: Array.isArray(p.plugins.enabled) ? p.plugins.enabled : [],
              removed: Array.isArray(p.plugins.removed) ? p.plugins.removed : [],
              config: (p.plugins.config && typeof p.plugins.config === 'object' && !Array.isArray(p.plugins.config))
                ? (p.plugins.config as Record<string, Record<string, unknown>>) : {},
            }
          : legacyEmptyPlugins(),
        brain: {
          providers: sanitizeBrainProviders(p.brain?.providers),
          agentName: typeof p.brain?.agentName === 'string' && p.brain.agentName.trim() ? p.brain.agentName.trim().slice(0, 40) : 'Elowen',
          maxSteps: clampMaxSteps(p.brain?.maxSteps, d.brain.maxSteps),
          modelContextWindows: sanitizeContextWindows(p.brain?.modelContextWindows),
          limits: clampBrainLimits(p.brain?.limits, d.brain.limits),
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
      modelNotes: s.modelNotes,
      autopilot: { model: s.autopilot.model, overseerModel: s.autopilot.overseerModel, apiUrl: s.autopilot.apiUrl, providerId: s.autopilot.providerId, apiKeySet: !!s.apiKey, notes: s.autopilot.notes, prompt: s.autopilot.prompt, pilotExec: s.autopilot.pilotExec, overseerExec: s.autopilot.overseerExec, reviewOnDone: s.autopilot.reviewOnDone, tddMode: s.autopilot.tddMode, prEnabled: s.autopilot.prEnabled, prBaseBranch: s.autopilot.prBaseBranch, prAutoOpen: s.autopilot.prAutoOpen, prVerifyCommand: s.autopilot.prVerifyCommand, ghTokenSet: !!s.ghToken },
      providers: s.providers,
      defaults: s.defaults,
      security: s.security,
      autoUpdate: s.autoUpdate,
      lspEnabled: s.lspEnabled,
      // Only the public key is exposed; `publicKeySet` reflects whether a full keypair exists.
      webPush: { publicKey: s.webPush?.publicKey ?? '', publicKeySet: !!s.webPush },
      // Only the enabled + removed lists surface; per-plugin config (possible secrets) stays daemon-side.
      plugins: { enabled: s.plugins.enabled, removed: s.plugins.removed },
      brain: { providers: s.brain.providers.map(({ apiKey, ...pub }) => ({ ...pub, apiKeySet: !!apiKey })), agentName: s.brain.agentName, maxSteps: s.brain.maxSteps, modelContextWindows: s.brain.modelContextWindows, limits: s.brain.limits },
      // No secret in the embedding block (the key is reused from the brain provider) → expose verbatim.
      embedding: s.embedding,
      // Likewise no secret in the categorization block → expose verbatim.
      categorization: s.categorization,
    };
  }

  providers(): Providers { return this.read().providers; }

  apiKey(): string | null { return this.read().apiKey; }

  /** Resolve the relay credentials the planner / overseer / curator use. When `autopilot.providerId`
   *  references a brain provider, ITS endpoint + key are reused — so an operator picks an existing
   *  provider instead of entering a second key. Otherwise the legacy top-level `apiKey` +
   *  `autopilot.apiUrl` are the fallback (keeps pre-existing installs working). Null when no usable key
   *  resolves → callers keep their pre-relay behaviour. */
  autopilotRelay(): { baseUrl: string; apiKey: string } | null {
    const s = this.read();
    const pid = s.autopilot.providerId;
    if (pid) {
      const p = s.brain.providers.find((x) => x.id === pid);
      return p && p.apiKey ? { baseUrl: p.baseUrl, apiKey: p.apiKey } : null;
    }
    return s.apiKey ? { baseUrl: s.autopilot.apiUrl, apiKey: s.apiKey } : null;
  }

  ghToken(): string | null { return this.read().ghToken; }

  /** The full VAPID keypair (private included) for the daemon-side push sender — never serialized to
   *  any API response. Null until generated on first boot. */
  webPushKeys(): { publicKey: string; privateKey: string } | null { return this.read().webPush; }

  /** Persist a freshly generated VAPID keypair. */
  setWebPushKeys(keys: { publicKey: string; privateKey: string }): void {
    this.write({ ...this.read(), webPush: { publicKey: keys.publicKey, privateKey: keys.privateKey } });
  }

  /** Whether a settings row has been persisted (i.e. config has been saved at least once). */
  hasSettings(): boolean {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
  }

  update(patch: ConfigPatch): ElowenConfig {
    const cur = this.read();
    const newKey = patch.autopilot?.apiKey;
    const newGhToken = patch.autopilot?.ghToken;
    // The pilot/overseer/default exec must resolve to a real program — mirror the API's
    // allowedExecs guard so an admin can't persist a bare bogus spec (e.g. 'foo') that
    // resolveExecutor would silently turn into a non-existent claude-code model (audit O22).
    const allowed = patch.allowedExecs ?? cur.allowedExecs;
    const pilotExec = this.normalizeExec(patch.autopilot?.pilotExec, cur.autopilot.pilotExec, allowed, '');
    const overseerExec = this.normalizeExec(patch.autopilot?.overseerExec, cur.autopilot.overseerExec, allowed, '');
    const defaultExec = this.normalizeExec(patch.defaults?.exec, cur.defaults.exec, allowed, cur.defaults.exec);
    this.write({
      allowedExecs: allowed,
      customModels: patch.customModels ?? cur.customModels,
      hiddenPresets: patch.hiddenPresets ?? cur.hiddenPresets,
      modelNotes: patch.modelNotes ?? cur.modelNotes,
      autopilot: { model: patch.autopilot?.model ?? cur.autopilot.model, overseerModel: patch.autopilot?.overseerModel ?? cur.autopilot.overseerModel, apiUrl: patch.autopilot?.apiUrl ?? cur.autopilot.apiUrl, providerId: patch.autopilot?.providerId ?? cur.autopilot.providerId, notes: patch.autopilot?.notes ?? cur.autopilot.notes, prompt: patch.autopilot?.prompt ?? cur.autopilot.prompt, pilotExec, overseerExec, reviewOnDone: patch.autopilot?.reviewOnDone ?? cur.autopilot.reviewOnDone, tddMode: patch.autopilot?.tddMode ?? cur.autopilot.tddMode, prEnabled: patch.autopilot?.prEnabled ?? cur.autopilot.prEnabled, prBaseBranch: patch.autopilot?.prBaseBranch ?? cur.autopilot.prBaseBranch, prAutoOpen: patch.autopilot?.prAutoOpen ?? cur.autopilot.prAutoOpen, prVerifyCommand: patch.autopilot?.prVerifyCommand ?? cur.autopilot.prVerifyCommand },
      providers: patch.providers ? { ...cur.providers, ...sanitizeProviders(patch.providers) } : cur.providers,
      apiKey: (typeof newKey === 'string' && newKey.length > 0) ? newKey : cur.apiKey,
      ghToken: (typeof newGhToken === 'string' && newGhToken.length > 0) ? newGhToken : cur.ghToken,
      defaults: { exec: defaultExec, autonomy: patch.defaults?.autonomy ?? cur.defaults.autonomy, maxSessions: patch.defaults?.maxSessions ?? cur.defaults.maxSessions },
      // Clamp to a sane positive integer — the value is interpolated into a SQL date modifier.
      security: { tokenTtlDays: clampTtlDays(patch.security?.tokenTtlDays, cur.security.tokenTtlDays) },
      autoUpdate: patch.autoUpdate ?? cur.autoUpdate,
      lspEnabled: typeof patch.lspEnabled === 'boolean' ? patch.lspEnabled : cur.lspEnabled,
      webPush: cur.webPush, // VAPID keys are managed via setWebPushKeys, never through the config patch
      plugins: {
        enabled: patch.plugins?.enabled ?? cur.plugins.enabled,
        removed: patch.plugins?.removed ?? cur.plugins.removed,
        // Merge per-plugin config so a patch touching one plugin never wipes another's slice.
        config: patch.plugins?.config ? { ...cur.plugins.config, ...patch.plugins.config } : cur.plugins.config,
      },
      brain: {
        providers: patch.brain?.providers !== undefined
          ? sanitizeBrainProviders(patch.brain.providers).map((p) => ({
              ...p,
              // An entry arriving without a key keeps the stored one — the public view never carries
              // secrets, so the UI round-trips entries keyless and only sets apiKey when (re)entered.
              apiKey: p.apiKey ?? cur.brain.providers.find((c) => c.id === p.id)?.apiKey ?? null,
            }))
          : cur.brain.providers,
        agentName: typeof patch.brain?.agentName === 'string' && patch.brain.agentName.trim()
          ? patch.brain.agentName.trim().slice(0, 40)
          : cur.brain.agentName,
        maxSteps: clampMaxSteps(patch.brain?.maxSteps, cur.brain.maxSteps),
        // Context-window overrides replace wholesale (the UI edits the full map).
        modelContextWindows: patch.brain?.modelContextWindows !== undefined
          ? sanitizeContextWindows(patch.brain.modelContextWindows)
          : cur.brain.modelContextWindows,
        // Limits merge per-field onto the current values (a partial patch tunes one knob without
        // resetting the rest) and each field is clamped to its bound.
        limits: clampBrainLimits(patch.brain?.limits, cur.brain.limits),
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

  /** Daemon-side brain provider list including plaintext API keys. Never routed to any client. */
  brainProviders(): { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string[]; api?: BrainProviderApi; apiKey: string | null }[] {
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
    if (next === undefined) return current;
    return isAllowedExec(next, allowed) ? next : onInvalid;
  }
}
