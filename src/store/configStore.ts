import type { Db } from './db.js';
import { defaultPromptTemplate } from '../overseer/planner.js';
import { DEFAULT_BINS, EXEC_NOTES, KNOWN_EXECS, isAllowedExec } from '../shared/execs.js';

interface ProviderConfig { bin: string; args: string; skipPermissions: boolean }
export type Providers = Record<string, ProviderConfig>;

export interface OrcaConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  modelNotes: Record<string, string>;
  autopilot: { model: string; overseerModel: string; apiUrl: string; apiKeySet: boolean; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean; prEnabled: boolean; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string; ghTokenSet: boolean };
  providers: Providers;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number };
}

// Default executable name per agent program (resolveExecutor program ids). Derived from the shared
// executor table so program ids + their bins stay in one place (audit #43/S21).
const DEFAULT_PROVIDERS: Providers = Object.fromEntries(
  Object.entries(DEFAULT_BINS).map(([program, bin]) => [program, { bin, args: '', skipPermissions: true }]),
);

/** Keep only well-formed provider entries ({ bin: string, args: string, skipPermissions: boolean }). A
 *  malformed value (e.g. bin as a number from a hand-edited row or a loose PUT) is dropped, never
 *  persisted/returned — it would otherwise reach spawn() as an invalid executable. `skipPermissions`
 *  defaults to true when absent (older configs, or a partial PUT) so unattended agents keep bypassing
 *  permission prompts unless the operator explicitly turns it off. */
function sanitizeProviders(input: unknown): Providers {
  if (!input || typeof input !== 'object') return {};
  const out: Providers = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as ProviderConfig).bin === 'string' && typeof (v as ProviderConfig).args === 'string') {
      const skip = (v as ProviderConfig).skipPermissions;
      out[k] = { bin: (v as ProviderConfig).bin, args: (v as ProviderConfig).args, skipPermissions: typeof skip === 'boolean' ? skip : true };
    }
  }
  return out;
}

/** Token TTL must be a whole number of days ≥ 1 (it feeds a SQLite date modifier). Anything
 *  invalid falls back to the current value. */
const clampTtlDays = (next: number | undefined, fallback: number): number =>
  typeof next === 'number' && Number.isFinite(next) && next >= 1 ? Math.floor(next) : fallback;

const DEFAULT_CONFIG: OrcaConfig = {
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  modelNotes: { ...EXEC_NOTES },
  autopilot: { model: 'gpt-4o-mini', overseerModel: '', apiUrl: 'https://api.openai.com/v1', apiKeySet: false, notes: '', prompt: defaultPromptTemplate(), pilotExec: '', overseerExec: '', reviewOnDone: false, prEnabled: false, prBaseBranch: '', prAutoOpen: false, prVerifyCommand: '', ghTokenSet: false },
  providers: { ...DEFAULT_PROVIDERS },
  defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 },
  security: { tokenTtlDays: 30 },
};

interface Stored {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  modelNotes: Record<string, string>;
  autopilot: { model: string; overseerModel: string; apiUrl: string; notes: string; prompt: string; pilotExec: string; overseerExec: string; reviewOnDone: boolean; prEnabled: boolean; prBaseBranch: string; prAutoOpen: boolean; prVerifyCommand: string };
  providers: Providers;
  apiKey: string | null;
  ghToken: string | null;
  defaults: { exec: string; autonomy: string; maxSessions: number };
  security: { tokenTtlDays: number };
}

const defaultStored = (): Stored => ({
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  modelNotes: { ...EXEC_NOTES },
  autopilot: { model: DEFAULT_CONFIG.autopilot.model, overseerModel: '', apiUrl: DEFAULT_CONFIG.autopilot.apiUrl, notes: '', prompt: DEFAULT_CONFIG.autopilot.prompt, pilotExec: '', overseerExec: '', reviewOnDone: false, prEnabled: false, prBaseBranch: '', prAutoOpen: false, prVerifyCommand: '' },
  providers: { ...DEFAULT_PROVIDERS },
  apiKey: null,
  ghToken: null,
  defaults: { ...DEFAULT_CONFIG.defaults },
  security: { ...DEFAULT_CONFIG.security },
});

export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  modelNotes?: Record<string, string>;
  autopilot?: { model?: string; overseerModel?: string; apiUrl?: string; apiKey?: string; notes?: string; prompt?: string; pilotExec?: string; overseerExec?: string; reviewOnDone?: boolean; prEnabled?: boolean; prBaseBranch?: string; prAutoOpen?: boolean; prVerifyCommand?: string; ghToken?: string };
  providers?: Providers;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
  security?: { tokenTtlDays?: number };
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
        autopilot: { model: p.autopilot?.model ?? d.autopilot.model, overseerModel: p.autopilot?.overseerModel ?? d.autopilot.overseerModel, apiUrl: p.autopilot?.apiUrl ?? d.autopilot.apiUrl, notes: p.autopilot?.notes ?? d.autopilot.notes, prompt: p.autopilot?.prompt ?? d.autopilot.prompt, pilotExec: p.autopilot?.pilotExec ?? d.autopilot.pilotExec, overseerExec: p.autopilot?.overseerExec ?? d.autopilot.overseerExec, reviewOnDone: p.autopilot?.reviewOnDone ?? d.autopilot.reviewOnDone, prEnabled: p.autopilot?.prEnabled ?? d.autopilot.prEnabled, prBaseBranch: p.autopilot?.prBaseBranch ?? d.autopilot.prBaseBranch, prAutoOpen: p.autopilot?.prAutoOpen ?? d.autopilot.prAutoOpen, prVerifyCommand: p.autopilot?.prVerifyCommand ?? d.autopilot.prVerifyCommand },
        providers: { ...d.providers, ...sanitizeProviders(p.providers) },
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : null,
        ghToken: typeof p.ghToken === 'string' ? p.ghToken : null,
        defaults: { exec: p.defaults?.exec ?? d.defaults.exec, autonomy: p.defaults?.autonomy ?? d.defaults.autonomy, maxSessions: p.defaults?.maxSessions ?? d.defaults.maxSessions },
        security: { tokenTtlDays: p.security?.tokenTtlDays ?? d.security.tokenTtlDays },
      };
    } catch { return defaultStored(); } // corrupt row → defaults, never throw
  }

  private write(s: Stored): void {
    this.db.prepare('INSERT INTO settings (id, data) VALUES (1, @data) ON CONFLICT(id) DO UPDATE SET data = @data')
      .run({ data: JSON.stringify(s) });
  }

  get(): OrcaConfig {
    const s = this.read();
    return {
      allowedExecs: s.allowedExecs,
      customModels: s.customModels,
      hiddenPresets: s.hiddenPresets,
      modelNotes: s.modelNotes,
      autopilot: { model: s.autopilot.model, overseerModel: s.autopilot.overseerModel, apiUrl: s.autopilot.apiUrl, apiKeySet: !!s.apiKey, notes: s.autopilot.notes, prompt: s.autopilot.prompt, pilotExec: s.autopilot.pilotExec, overseerExec: s.autopilot.overseerExec, reviewOnDone: s.autopilot.reviewOnDone, prEnabled: s.autopilot.prEnabled, prBaseBranch: s.autopilot.prBaseBranch, prAutoOpen: s.autopilot.prAutoOpen, prVerifyCommand: s.autopilot.prVerifyCommand, ghTokenSet: !!s.ghToken },
      providers: s.providers,
      defaults: s.defaults,
      security: s.security,
    };
  }

  providers(): Providers { return this.read().providers; }

  apiKey(): string | null { return this.read().apiKey; }

  ghToken(): string | null { return this.read().ghToken; }

  /** Whether a settings row has been persisted (i.e. config has been saved at least once). */
  hasSettings(): boolean {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
  }

  update(patch: ConfigPatch): OrcaConfig {
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
      autopilot: { model: patch.autopilot?.model ?? cur.autopilot.model, overseerModel: patch.autopilot?.overseerModel ?? cur.autopilot.overseerModel, apiUrl: patch.autopilot?.apiUrl ?? cur.autopilot.apiUrl, notes: patch.autopilot?.notes ?? cur.autopilot.notes, prompt: patch.autopilot?.prompt ?? cur.autopilot.prompt, pilotExec, overseerExec, reviewOnDone: patch.autopilot?.reviewOnDone ?? cur.autopilot.reviewOnDone, prEnabled: patch.autopilot?.prEnabled ?? cur.autopilot.prEnabled, prBaseBranch: patch.autopilot?.prBaseBranch ?? cur.autopilot.prBaseBranch, prAutoOpen: patch.autopilot?.prAutoOpen ?? cur.autopilot.prAutoOpen, prVerifyCommand: patch.autopilot?.prVerifyCommand ?? cur.autopilot.prVerifyCommand },
      providers: patch.providers ? { ...cur.providers, ...sanitizeProviders(patch.providers) } : cur.providers,
      apiKey: (typeof newKey === 'string' && newKey.length > 0) ? newKey : cur.apiKey,
      ghToken: (typeof newGhToken === 'string' && newGhToken.length > 0) ? newGhToken : cur.ghToken,
      defaults: { exec: defaultExec, autonomy: patch.defaults?.autonomy ?? cur.defaults.autonomy, maxSessions: patch.defaults?.maxSessions ?? cur.defaults.maxSessions },
      // Clamp to a sane positive integer — the value is interpolated into a SQL date modifier.
      security: { tokenTtlDays: clampTtlDays(patch.security?.tokenTtlDays, cur.security.tokenTtlDays) },
    });
    return this.get();
  }

  /** Resolve an exec field on update: keep the current value when the patch omits it; accept a
   *  patched value only if it's allow-listed/well-formed (isAllowedExec), otherwise fall back to
   *  `onInvalid` so an invalid spec is never persisted. */
  private normalizeExec(next: string | undefined, current: string, allowed: readonly string[], onInvalid: string): string {
    if (next === undefined) return current;
    return isAllowedExec(next, allowed) ? next : onInvalid;
  }
}
