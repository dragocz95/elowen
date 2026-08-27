// Canned daemon data for the E2E fake daemon. Every constant is typed against the web's own wire
// shapes (web/lib/types.ts) so a field the daemon renames/removes fails THIS file's typecheck instead
// of silently drifting from what the UI folds. Import-type only — these are erased at runtime, so the
// fake daemon never bundles the web types.
import type {
  User,
  ElowenConfig,
  BrainStatus,
  BrainSessionInfo,
  BrainModelOption,
  SlashCommandDef,
  BrainMessage,
  Project,
  Memory,
  MemoryCategory,
} from '../../../lib/types.ts';

/** The single admin account the fake daemon accepts. Global setup logs in with exactly these creds
 *  through the real app, so keep them in lockstep with global-setup.ts. */
export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'e2e-admin-password';
/** Opaque bearer the fake daemon issues on login; the web BFF stores it in the httpOnly cookie and
 *  echoes it back as `Authorization: Bearer …`. The fake daemon does not validate it (the web proxy is
 *  the auth boundary in this harness) — it only needs to be a stable non-empty string. */
export const ADMIN_TOKEN = 'e2e-fake-daemon-token';
/** The daemon reports this as the token TTL so the web mints a long-lived cookie (not a session one). */
export const TOKEN_TTL_DAYS = 30;

/** The default active conversation `POST /brain/start` binds to when no explicit session is requested. */
export const DEFAULT_SESSION_ID = 'brain-1';

export const adminUser: User = {
  id: 1,
  username: ADMIN_USERNAME,
  created_at: '2026-01-01T00:00:00.000Z',
  is_admin: true,
  allowed_execs: [],
  disabled_tools: [],
  name: 'E2E Admin',
  email: 'admin@example.test',
  avatar: '',
  default_exec: 'elowen:oauth-anthropic/claude-sonnet-4',
  advisor_exec: 'elowen:oauth-anthropic/claude-sonnet-4',
  advisor_autostart: false,
};

export const config: ElowenConfig = {
  allowedExecs: ['elowen:oauth-anthropic/claude-sonnet-4'],
  customModels: [],
  hiddenPresets: [],
  modelNotes: {},
  providers: {},
  defaults: { exec: 'elowen:oauth-anthropic/claude-sonnet-4', autonomy: 'L1', maxSessions: 3 },
  security: { tokenTtlDays: TOKEN_TTL_DAYS },
  sessionRetention: { enabled: false, days: 30 },
  autoUpdate: false,
  plugins: { enabled: [] },
  brain: { providers: [], agentName: 'Elowen', maxSteps: 0 },
};

const usage: BrainStatus['usage'] = {
  tokens: 1200,
  contextWindow: 200000,
  percent: 0.6,
  totalTokens: 4200,
  cost: 0.0123,
};

export const brainStatus: BrainStatus = {
  running: false,
  sessionId: DEFAULT_SESSION_ID,
  model: 'claude-sonnet-4',
  usage,
  statusline: { showModel: true, showContext: true, showTokens: true, showCost: true },
  pendingAsk: null,
  cards: [],
  queued: [],
  yolo: false,
};

export const brainSessions: BrainSessionInfo[] = [
  { id: DEFAULT_SESSION_ID, title: 'First conversation', model: 'claude-sonnet-4', updated_at: '2026-07-15T10:00:00.000Z', running: false, active: true },
  { id: 'brain-2', title: 'Second conversation', model: 'claude-sonnet-4', updated_at: '2026-07-14T09:00:00.000Z', running: false, active: false },
];

export const brainModels: BrainModelOption[] = [
  {
    provider: 'oauth-anthropic',
    providerLabel: 'Anthropic (OAuth)',
    model: 'claude-sonnet-4',
    exec: 'elowen:oauth-anthropic/claude-sonnet-4',
    source: 'oauth',
    contextWindow: 200000,
    contextWindowSet: true,
    reasoningLevels: ['none', 'low', 'medium', 'high'],
    reasoningLabels: { none: 'Off', low: 'Low', medium: 'Medium', high: 'High' },
    fastAvailable: false,
    default: true,
  },
  {
    provider: 'oauth-anthropic',
    providerLabel: 'Anthropic (OAuth)',
    model: 'claude-opus-4',
    exec: 'elowen:oauth-anthropic/claude-opus-4',
    source: 'oauth',
    contextWindow: 200000,
    contextWindowSet: true,
    reasoningLevels: ['none', 'low', 'medium', 'high'],
    reasoningLabels: { none: 'Off', low: 'Low', medium: 'Medium', high: 'High' },
    fastAvailable: false,
  },
];

export const brainCommands: SlashCommandDef[] = [
  { name: 'new', description: 'Start a fresh conversation', kind: 'action' },
  { name: 'compact', description: 'Compact the conversation context', kind: 'action' },
  { name: 'model', description: 'Switch the model', kind: 'picker' },
  { name: 'help', description: 'Show available commands', kind: 'info' },
];

/** Seed transcript for the default conversation, oldest-first (the order the UI renders). The message
 *  history endpoint serves these; the paginated variant walks BACKWARDS through them by index cursor. */
export const brainMessages: BrainMessage[] = [
  { id: 'm1', role: 'user', text: 'Hello there' },
  { id: 'm2', role: 'assistant', text: 'Hi! How can I help you today?', segments: [{ kind: 'text', text: 'Hi! How can I help you today?' }] },
  { id: 'm3', role: 'user', text: 'What is 2 + 2?' },
  { id: 'm4', role: 'assistant', text: 'It is 4.', segments: [{ kind: 'text', text: 'It is 4.' }] },
];

// The ambient shell polls these too; empty lists are valid and keep the sidebars quiet.
export const projects: Project[] = [];

export const memoryCategories: MemoryCategory[] = [
  { id: 1, user_id: 1, name: 'Architecture', description: 'Decisions and constraints', color: '#7c9cff', icon: 'Layers', is_builtin: 1, projectId: null, created_at: '2026-01-01T00:00:00.000Z' },
  { id: 2, user_id: 1, name: 'Preferences', description: 'Standing user preferences', color: '#ffb570', icon: 'Sparkles', is_builtin: 1, projectId: null, created_at: '2026-01-01T00:00:00.000Z' },
];

/** 47 rows: more than two pages at the module's PAGE_SIZE of 20, so the pager renders with a reachable
 *  "next" on every page but the last. Bodies deliberately vary in length — a register truncates a cell to
 *  one line, and a fixture whose bodies were all short would never put that to the test. */
export const memories: Memory[] = Array.from({ length: 47 }, (_, i) => {
  const n = i + 1;
  const long = n % 3 === 0;
  return {
    id: n,
    user_id: 1,
    body: long
      ? `Memory ${n}: a deliberately long body that runs well past the width of any register cell so the one-line truncation rule has something to truncate, and keeps going for good measure.`
      : `Memory ${n}: a short note.`,
    kind: n % 2 === 0 ? 'fact' : 'preference',
    importance: (n % 5) + 1,
    confidence: 0.5 + (n % 5) / 10,
    source: 'e2e',
    status: 'active' as const,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: `2026-07-${String((n % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
    last_used_at: n % 4 === 0 ? '2026-07-20T10:00:00.000Z' : null,
    use_count: n % 7,
    category_id: n % 3 === 0 ? 1 : n % 3 === 1 ? 2 : null,
    vitality: (n % 10) / 10,
  };
});
