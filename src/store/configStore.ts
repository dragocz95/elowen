import type { Db } from './db.js';
import { defaultPromptTemplate } from '../overseer/planner.js';

interface ProviderConfig { bin: string; args: string }
export type Providers = Record<string, ProviderConfig>;

export interface OrcaConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  autopilot: { model: string; overseerModel: string; apiUrl: string; apiKeySet: boolean; notes: string; prompt: string };
  providers: Providers;
  defaults: { exec: string; autonomy: string; maxSessions: number };
}

// Default executable name per agent program (resolveExecutor program ids).
const DEFAULT_PROVIDERS: Providers = {
  'claude-code': { bin: 'claude', args: '' },
  'opencode': { bin: 'opencode', args: '' },
  'codex': { bin: 'codex', args: '' },
};

const KNOWN_EXECS = ['sonnet', 'deepseek/deepseek-v4-flash', 'kimi-for-coding/k2p7', 'ollama/minimax-m2.7:cloud', 'codex:gpt-5.4'];

const DEFAULT_CONFIG: OrcaConfig = {
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  autopilot: { model: 'gpt-4o-mini', overseerModel: '', apiUrl: 'https://api.openai.com/v1', apiKeySet: false, notes: '', prompt: defaultPromptTemplate() },
  providers: { ...DEFAULT_PROVIDERS },
  defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 },
};

interface Stored {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  autopilot: { model: string; overseerModel: string; apiUrl: string; notes: string; prompt: string };
  providers: Providers;
  apiKey: string | null;
  defaults: { exec: string; autonomy: string; maxSessions: number };
}

const defaultStored = (): Stored => ({
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  autopilot: { model: DEFAULT_CONFIG.autopilot.model, overseerModel: '', apiUrl: DEFAULT_CONFIG.autopilot.apiUrl, notes: '', prompt: DEFAULT_CONFIG.autopilot.prompt },
  providers: { ...DEFAULT_PROVIDERS },
  apiKey: null,
  defaults: { ...DEFAULT_CONFIG.defaults },
});

export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  autopilot?: { model?: string; overseerModel?: string; apiUrl?: string; apiKey?: string; notes?: string; prompt?: string };
  providers?: Providers;
  defaults?: { exec?: string; autonomy?: string; maxSessions?: number };
}

export class ConfigStore {
  constructor(private db: Db) {}

  private read(): Stored {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (!row) return defaultStored();
    try {
      const p = JSON.parse(row.data) as Partial<Stored>;
      const d = defaultStored();
      return {
        allowedExecs: p.allowedExecs ?? d.allowedExecs,
        customModels: p.customModels ?? [],
        hiddenPresets: p.hiddenPresets ?? [],
        autopilot: { model: p.autopilot?.model ?? d.autopilot.model, overseerModel: p.autopilot?.overseerModel ?? d.autopilot.overseerModel, apiUrl: p.autopilot?.apiUrl ?? d.autopilot.apiUrl, notes: p.autopilot?.notes ?? d.autopilot.notes, prompt: p.autopilot?.prompt ?? d.autopilot.prompt },
        providers: { ...d.providers, ...(p.providers ?? {}) },
        apiKey: p.apiKey ?? null,
        defaults: { exec: p.defaults?.exec ?? d.defaults.exec, autonomy: p.defaults?.autonomy ?? d.defaults.autonomy, maxSessions: p.defaults?.maxSessions ?? d.defaults.maxSessions },
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
      autopilot: { model: s.autopilot.model, overseerModel: s.autopilot.overseerModel, apiUrl: s.autopilot.apiUrl, apiKeySet: !!s.apiKey, notes: s.autopilot.notes, prompt: s.autopilot.prompt },
      providers: s.providers,
      defaults: s.defaults,
    };
  }

  providers(): Providers { return this.read().providers; }

  apiKey(): string | null { return this.read().apiKey; }

  /** Whether a settings row has been persisted (i.e. config has been saved at least once). */
  hasSettings(): boolean {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
  }

  update(patch: ConfigPatch): OrcaConfig {
    const cur = this.read();
    const newKey = patch.autopilot?.apiKey;
    this.write({
      allowedExecs: patch.allowedExecs ?? cur.allowedExecs,
      customModels: patch.customModels ?? cur.customModels,
      hiddenPresets: patch.hiddenPresets ?? cur.hiddenPresets,
      autopilot: { model: patch.autopilot?.model ?? cur.autopilot.model, overseerModel: patch.autopilot?.overseerModel ?? cur.autopilot.overseerModel, apiUrl: patch.autopilot?.apiUrl ?? cur.autopilot.apiUrl, notes: patch.autopilot?.notes ?? cur.autopilot.notes, prompt: patch.autopilot?.prompt ?? cur.autopilot.prompt },
      providers: patch.providers ? { ...cur.providers, ...patch.providers } : cur.providers,
      apiKey: (typeof newKey === 'string' && newKey.length > 0) ? newKey : cur.apiKey,
      defaults: { exec: patch.defaults?.exec ?? cur.defaults.exec, autonomy: patch.defaults?.autonomy ?? cur.defaults.autonomy, maxSessions: patch.defaults?.maxSessions ?? cur.defaults.maxSessions },
    });
    return this.get();
  }
}
