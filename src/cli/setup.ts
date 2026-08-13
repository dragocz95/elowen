/** First-run wizard logic, kept pure/injectable so the menu shell stays thin. All persistence goes
 *  through the daemon's own HTTP API (POST /users, POST /auth/login, PUT /config) — the single source
 *  of truth — rather than writing the DB directly, so there is no parallel config path. */

export interface SetupAnswers {
  username: string;
  password: string;
  /** Model access for the assistant itself: an OpenAI-compatible endpoint, its key (optional — a local
   *  runtime like Ollama needs none) and the default model. Absent → the account is created and the
   *  provider is connected later (`elowen setup`, or Settings → Elowen AI). */
  llm?: { apiUrl: string; apiKey: string; model: string };
}

/** The brain provider entry an unattended install saves. `openai` covers every OpenAI-compatible
 *  endpoint, which is what `--llm-url` accepts; anything else is connected interactively later. */
interface BrainProviderPatch {
  id: string;
  label: string;
  type: 'openai';
  baseUrl: string;
  models: string[];
  apiKey?: string;
}

interface SetupConfigPatch {
  brain?: { providers: BrainProviderPatch[] };
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

/** Pure mapper: wizard answers → the API payloads. The config half configures the ASSISTANT's own model
 *  access (a brain provider) — the one thing an unattended install cannot leave for later without
 *  handing over a box that cannot answer. It used to write the `autopilot` relay block instead, which
 *  is read only by the mission subsystem: on an install that does not ship it, `--llm-key` configured a
 *  subsystem that was not there and left the assistant itself with no provider at all.
 *  A blank apiKey is omitted rather than sent, so a keyless local endpoint stays keyless and an existing
 *  stored key is never overwritten with an empty string. */
export function buildSetupPlan(a: SetupAnswers): SetupPlan {
  const user = { username: a.username, password: a.password };
  if (!a.llm) return { user, config: {} };
  const provider: BrainProviderPatch = {
    id: 'default', label: 'Default', type: 'openai',
    baseUrl: a.llm.apiUrl, models: a.llm.model ? [a.llm.model] : [],
    ...(a.llm.apiKey ? { apiKey: a.llm.apiKey } : {}),
  };
  return { user, config: { brain: { providers: [provider] } } };
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

/** Persist the config patch with an admin bearer token. Nothing to save is a no-op, not an empty PUT. */
async function saveConfig(fetchFn: typeof fetch, base: string, token: string, config: SetupConfigPatch): Promise<void> {
  if (!config.brain) return;
  const r = await fetchFn(`${base}/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ brain: config.brain }),
  });
  if (!r.ok) throw new Error(`setup: saving config failed (${r.status})`);
}

/** Create the admin, log in for a bearer token, then save the config. Kept for the non-interactive
 *  (unattended) install path; the interactive wizard creates the admin earlier so it can talk to the
 *  daemon while the operator picks a provider. */
export async function applySetup(fetchFn: typeof fetch, base: string, plan: SetupPlan): Promise<void> {
  const token = await createAdmin(fetchFn, base, plan.user);
  await saveConfig(fetchFn, base, token, plan.config);
}
