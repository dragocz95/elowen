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
  SessionInfo,
  Task,
  Mission,
  Project,
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
  autopilot: {
    model: 'claude-sonnet-4',
    overseerModel: 'claude-sonnet-4',
    apiUrl: '',
    providerId: '',
    apiKeySet: false,
    notes: '',
    prompt: '',
    pilotExec: 'elowen:oauth-anthropic/claude-sonnet-4',
    overseerExec: 'elowen:oauth-anthropic/claude-sonnet-4',
    reviewOnDone: false,
    tddMode: false,
    prEnabled: false,
    prBaseBranch: 'main',
    prAutoOpen: false,
    prVerifyCommand: '',
    ghTokenSet: false,
  },
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
export const sessions: SessionInfo[] = [];
export const tasks: Task[] = [];
export const missions: Mission[] = [];
export const projects: Project[] = [];
