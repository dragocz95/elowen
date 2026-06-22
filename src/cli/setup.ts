/** First-run wizard logic, kept pure/injectable so the menu shell stays thin. All persistence goes
 *  through the daemon's own HTTP API (POST /users, POST /auth/login, PUT /config) — the single source
 *  of truth — rather than writing the DB directly, so there is no parallel config path. */

export interface SetupAnswers {
  username: string;
  password: string;
  /** Autopilot engine. When set, autopilot plans & oversees missions through an installed agent CLI
   *  (claude-code / opencode / codex) — no API key needed. When empty, the apiUrl/apiKey/model below
   *  drive the hosted-API (relay) engine instead. */
  pilotExec?: string;
  apiUrl: string;
  apiKey: string;
  model: string;
}

/** Autopilot CLIs that can drive missions without an API key, in recommended order. Mirrors the agent
 *  programs the daemon knows about (src/shared/execs.ts). */
const AUTOPILOT_CLIS = ['claude', 'opencode', 'codex'] as const;

/** Default autopilot exec spec for a detected agent CLI — a well-formed `<prefix>:<model>` spec that
 *  resolveExecutor routes to the right program (so it passes the daemon's allow-list guard without
 *  needing a custom model entry). opencode is provider-agnostic, so its model comes from the caller. */
export function defaultExecForCli(cli: string, opencodeModel = 'anthropic/claude-sonnet-4-5'): string {
  switch (cli) {
    case 'claude': return 'claude:sonnet';
    case 'codex': return 'codex:gpt-5.5';
    case 'opencode': return `opencode:${opencodeModel}`;
    default: return '';
  }
}

/** Daemon autopilot config patch (subset of the daemon's ConfigPatch): either the CLI engine
 *  (pilotExec/overseerExec) or the hosted-API engine (model/apiUrl/apiKey). */
interface AutopilotPatch {
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  pilotExec?: string;
  overseerExec?: string;
}

interface SetupConfigPatch {
  autopilot: AutopilotPatch;
}

export interface SetupPlan {
  user: { username: string; password: string };
  config: SetupConfigPatch;
}

/** True when the daemon has no users yet — the open setup window during which the wizard may create
 *  the first admin and save the provider/key. */
export async function isFirstRun(fetchFn: typeof fetch, base: string): Promise<boolean> {
  const r = await fetchFn(`${base}/setup`);
  const body = await r.json() as { needsSetup?: boolean };
  return body.needsSetup === true;
}

/** Pure mapper: wizard answers → the API payloads. With a pilotExec the autopilot runs through an
 *  agent CLI (same exec for pilot and overseer) and no API key is sent; otherwise a blank apiKey is
 *  omitted so we never overwrite an existing key with an empty string. */
export function buildSetupPlan(a: SetupAnswers): SetupPlan {
  const autopilot: AutopilotPatch = a.pilotExec
    ? { pilotExec: a.pilotExec, overseerExec: a.pilotExec }
    : { model: a.model, apiUrl: a.apiUrl };
  if (!a.pilotExec && a.apiKey) autopilot.apiKey = a.apiKey;
  return { user: { username: a.username, password: a.password }, config: { autopilot } };
}

/** Create the admin (open during setup) and log in for a bearer token. The first user created is
 *  automatically the admin (userStore.create), so subsequent authenticated calls succeed. */
export async function createAdmin(fetchFn: typeof fetch, base: string, user: { username: string; password: string }): Promise<string> {
  const post = (path: string, body: unknown) => fetchFn(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const created = await post('/users', user);
  if (!created.ok) throw new Error(`setup: creating the admin failed (${created.status})`);
  const login = await post('/auth/login', user);
  if (!login.ok) throw new Error(`setup: login failed (${login.status})`);
  const { token } = await login.json() as { token?: string };
  if (!token) throw new Error('setup: login returned no token');
  return token;
}

/** Persist the config patch with an admin bearer token. */
export async function saveConfig(fetchFn: typeof fetch, base: string, token: string, config: SetupConfigPatch): Promise<void> {
  const r = await fetchFn(`${base}/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(config),
  });
  if (!r.ok) throw new Error(`setup: saving config failed (${r.status})`);
}

/** Ask the daemon which autopilot-capable agent CLIs are installed & functional for the SERVICE USER
 *  (the daemon detects on its own PATH, which is who actually runs the agents), returned in
 *  recommended order. Requires an admin bearer token. Returns [] on any failure — callers fall back
 *  to the API-key engine. */
export async function fetchAvailableClis(fetchFn: typeof fetch, base: string, token: string): Promise<string[]> {
  const r = await fetchFn(`${base}/integrations/cli-status`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const body = await r.json() as { tools?: { name: string; functional?: boolean }[] };
  const functional = new Set((body.tools ?? []).filter((t) => t.functional).map((t) => t.name));
  return AUTOPILOT_CLIS.filter((c) => functional.has(c));
}

/** Create the admin, log in for a bearer token, then save the config. Kept for the non-interactive
 *  (unattended) install path; the interactive wizard creates the admin earlier so it can probe the
 *  daemon for installed CLIs before choosing the autopilot engine. */
export async function applySetup(fetchFn: typeof fetch, base: string, plan: SetupPlan): Promise<void> {
  const token = await createAdmin(fetchFn, base, plan.user);
  await saveConfig(fetchFn, base, token, plan.config);
}
