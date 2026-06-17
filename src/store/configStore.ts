import type { Db } from './db.js';

export interface OrcaConfig {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  autopilot: { model: string; apiUrl: string; apiKeySet: boolean; notes: string };
  defaults: { exec: string; autonomy: string; maxSessions: number };
}

const KNOWN_EXECS = ['sonnet', 'ollama/deepseek-v4-flash', 'ollama/kimi-k2.7-code', 'ollama/minimax-m2.7', 'codex:gpt-5.4'];

export const DEFAULT_CONFIG: OrcaConfig = {
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  autopilot: { model: 'mimo-v2.5', apiUrl: 'https://ai.coresynth.io/v1', apiKeySet: false, notes: '' },
  defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 },
};

interface Stored {
  allowedExecs: string[];
  customModels: { label: string; exec: string }[];
  hiddenPresets: string[];
  autopilot: { model: string; apiUrl: string; notes: string };
  apiKey: string | null;
  defaults: { exec: string; autonomy: string; maxSessions: number };
}

const defaultStored = (): Stored => ({
  allowedExecs: [...KNOWN_EXECS],
  customModels: [],
  hiddenPresets: [],
  autopilot: { model: DEFAULT_CONFIG.autopilot.model, apiUrl: DEFAULT_CONFIG.autopilot.apiUrl, notes: '' },
  apiKey: null,
  defaults: { ...DEFAULT_CONFIG.defaults },
});

export interface ConfigPatch {
  allowedExecs?: string[];
  customModels?: { label: string; exec: string }[];
  hiddenPresets?: string[];
  autopilot?: { model?: string; apiUrl?: string; apiKey?: string; notes?: string };
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
        autopilot: { model: p.autopilot?.model ?? d.autopilot.model, apiUrl: p.autopilot?.apiUrl ?? d.autopilot.apiUrl, notes: p.autopilot?.notes ?? d.autopilot.notes },
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
      autopilot: { model: s.autopilot.model, apiUrl: s.autopilot.apiUrl, apiKeySet: !!s.apiKey, notes: s.autopilot.notes },
      defaults: s.defaults,
    };
  }

  apiKey(): string | null { return this.read().apiKey; }

  update(patch: ConfigPatch): OrcaConfig {
    const cur = this.read();
    const newKey = patch.autopilot?.apiKey;
    this.write({
      allowedExecs: patch.allowedExecs ?? cur.allowedExecs,
      customModels: patch.customModels ?? cur.customModels,
      hiddenPresets: patch.hiddenPresets ?? cur.hiddenPresets,
      autopilot: { model: patch.autopilot?.model ?? cur.autopilot.model, apiUrl: patch.autopilot?.apiUrl ?? cur.autopilot.apiUrl, notes: patch.autopilot?.notes ?? cur.autopilot.notes },
      apiKey: (typeof newKey === 'string' && newKey.length > 0) ? newKey : cur.apiKey,
      defaults: { exec: patch.defaults?.exec ?? cur.defaults.exec, autonomy: patch.defaults?.autonomy ?? cur.defaults.autonomy, maxSessions: patch.defaults?.maxSessions ?? cur.defaults.maxSessions },
    });
    return this.get();
  }
}
