import type { Db } from './db.js';

export interface OrcaConfig {
  allowedExecs: string[];
  autopilot: { model: string; apiUrl: string; apiKeySet: boolean };
}

const KNOWN_EXECS = ['sonnet', 'ollama/deepseek-v4-flash', 'ollama/kimi-k2.7-code', 'ollama/minimax-m2.7', 'codex:gpt-5.4'];

export const DEFAULT_CONFIG: OrcaConfig = {
  allowedExecs: [...KNOWN_EXECS],
  autopilot: { model: 'mimo-v2.5', apiUrl: 'https://ai.coresynth.io/v1', apiKeySet: false },
};

interface Stored {
  allowedExecs: string[];
  autopilot: { model: string; apiUrl: string };
  apiKey: string | null;
}

const defaultStored = (): Stored => ({
  allowedExecs: [...KNOWN_EXECS],
  autopilot: { model: DEFAULT_CONFIG.autopilot.model, apiUrl: DEFAULT_CONFIG.autopilot.apiUrl },
  apiKey: null,
});

export interface ConfigPatch {
  allowedExecs?: string[];
  autopilot?: { model?: string; apiUrl?: string; apiKey?: string };
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
        autopilot: { model: p.autopilot?.model ?? d.autopilot.model, apiUrl: p.autopilot?.apiUrl ?? d.autopilot.apiUrl },
        apiKey: p.apiKey ?? null,
      };
    } catch { return defaultStored(); } // corrupt row → defaults, never throw
  }

  private write(s: Stored): void {
    this.db.prepare('INSERT INTO settings (id, data) VALUES (1, @data) ON CONFLICT(id) DO UPDATE SET data = @data')
      .run({ data: JSON.stringify(s) });
  }

  get(): OrcaConfig {
    const s = this.read();
    return { allowedExecs: s.allowedExecs, autopilot: { model: s.autopilot.model, apiUrl: s.autopilot.apiUrl, apiKeySet: !!s.apiKey } };
  }

  apiKey(): string | null { return this.read().apiKey; }

  update(patch: ConfigPatch): OrcaConfig {
    const cur = this.read();
    const newKey = patch.autopilot?.apiKey;
    this.write({
      allowedExecs: patch.allowedExecs ?? cur.allowedExecs,
      autopilot: { model: patch.autopilot?.model ?? cur.autopilot.model, apiUrl: patch.autopilot?.apiUrl ?? cur.autopilot.apiUrl },
      apiKey: (typeof newKey === 'string' && newKey.length > 0) ? newKey : cur.apiKey,
    });
    return this.get();
  }
}
