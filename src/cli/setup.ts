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

/** Default autopilot exec spec for a detected agent CLI — a well-formed `<prefix>:<model>` spec that
 *  resolveExecutor routes to the right program (so it passes the daemon's allow-list guard without
 *  needing a custom model entry). opencode/kilo/pi/omp are provider-agnostic, so their model comes
 *  from the caller (the same default applies to all of them). */
export function defaultExecForCli(cli: string, agnosticModel = 'anthropic/claude-sonnet-4-5'): string {
  switch (cli) {
    case 'claude': return 'claude:sonnet';
    case 'codex': return 'codex:gpt-5.5';
    case 'opencode': return `opencode:${agnosticModel}`;
    case 'kilo': return `kilo:${agnosticModel}`;
    case 'pi': return `pi:${agnosticModel}`;
    case 'omp': return `omp:${agnosticModel}`;
    default: return '';
  }
}

/** Daemon autopilot config patch (subset of the daemon's ConfigPatch): the hosted-API engine's relay
 *  credentials. The CLI-engine keys (pilotExec/overseerExec) are agents-plugin config since the
 *  wave-2 config split and travel in SetupConfigPatch.agents instead. */
interface AutopilotPatch {
  model?: string;
  apiUrl?: string;
  apiKey?: string;
}

interface SetupConfigPatch {
  autopilot?: AutopilotPatch;
  /** plugins.config.agents values (the CLI autopilot engine) — saved via PATCH /plugins/agents/config. */
  agents?: Record<string, unknown>;
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
 *  agent CLI (same exec for pilot and overseer; saved into the agents plugin's config slice) and no
 *  API key is sent; otherwise a blank apiKey is omitted so we never overwrite an existing key with
 *  an empty string. */
export function buildSetupPlan(a: SetupAnswers): SetupPlan {
  if (a.pilotExec) {
    return { user: { username: a.username, password: a.password }, config: { agents: { pilotExec: a.pilotExec, overseerExec: a.pilotExec } } };
  }
  const autopilot: AutopilotPatch = { model: a.model, apiUrl: a.apiUrl };
  if (a.apiKey) autopilot.apiKey = a.apiKey;
  return { user: { username: a.username, password: a.password }, config: { autopilot } };
}

/** Log in with existing credentials and return a full-scope bearer token. Shared by createAdmin and the
 *  onboarding wizard's "an admin already exists → sign in" branch. */
export async function login(fetchFn: typeof fetch, base: string, creds: { username: string; password: string }): Promise<string> {
  const r = await fetchFn(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds),
  });
  if (!r.ok) throw new Error(`setup: login failed (${r.status})`);
  const { token } = await r.json() as { token?: string };
  if (!token) throw new Error('setup: login returned no token');
  return token;
}

/** Create the admin (open during setup) and log in for a bearer token. The first user created is
 *  automatically the admin (userStore.create), so subsequent authenticated calls succeed. */
export async function createAdmin(fetchFn: typeof fetch, base: string, user: { username: string; password: string }): Promise<string> {
  const created = await fetchFn(`${base}/users`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user),
  });
  if (!created.ok) throw new Error(`setup: creating the admin failed (${created.status})`);
  return login(fetchFn, base, user);
}

/** Persist the config patch with an admin bearer token: the relay credentials over PUT /config, the
 *  agents-plugin values (CLI autopilot engine) over PATCH /plugins/agents/config. */
async function saveConfig(fetchFn: typeof fetch, base: string, token: string, config: SetupConfigPatch): Promise<void> {
  if (config.autopilot) {
    const r = await fetchFn(`${base}/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ autopilot: config.autopilot }),
    });
    if (!r.ok) throw new Error(`setup: saving config failed (${r.status})`);
  }
  if (config.agents) {
    const r = await fetchFn(`${base}/plugins/agents/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ values: config.agents }),
    });
    if (!r.ok) throw new Error(`setup: saving the agents plugin config failed (${r.status})`);
  }
}

/** Create the admin, log in for a bearer token, then save the config. Kept for the non-interactive
 *  (unattended) install path; the interactive wizard creates the admin earlier so it can probe the
 *  daemon for installed CLIs before choosing the autopilot engine. */
export async function applySetup(fetchFn: typeof fetch, base: string, plan: SetupPlan): Promise<void> {
  const token = await createAdmin(fetchFn, base, plan.user);
  await saveConfig(fetchFn, base, token, plan.config);
}
