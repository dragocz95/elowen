/** First-run wizard logic, kept pure/injectable so the menu shell stays thin. All persistence goes
 *  through the daemon's own HTTP API (POST /users, POST /auth/login, PUT /config) — the single source
 *  of truth — rather than writing the DB directly, so there is no parallel config path. */

export interface SetupAnswers {
  username: string;
  password: string;
  apiUrl: string;
  apiKey: string;
  model: string;
}

/** Daemon config patch shape (subset of the daemon's ConfigPatch) — the LLM endpoint + key + model. */
interface SetupConfigPatch {
  autopilot: { model: string; apiUrl: string; apiKey?: string };
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

/** Pure mapper: wizard answers → the API payloads. A blank apiKey is omitted so we never overwrite an
 *  existing key with an empty string. */
export function buildSetupPlan(a: SetupAnswers): SetupPlan {
  const autopilot: SetupConfigPatch['autopilot'] = { model: a.model, apiUrl: a.apiUrl };
  if (a.apiKey) autopilot.apiKey = a.apiKey;
  return { user: { username: a.username, password: a.password }, config: { autopilot } };
}

/** Create the admin (open during setup), log in for a bearer token, then save the config. The first
 *  user created is automatically the admin (userStore.create), so the authenticated PUT /config
 *  succeeds once users exist. */
export async function applySetup(fetchFn: typeof fetch, base: string, plan: SetupPlan): Promise<void> {
  const post = (path: string, body: unknown, token?: string) => fetchFn(`${base}${path}`, {
    method: path === '/config' ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  const created = await post('/users', plan.user);
  if (!created.ok) throw new Error(`setup: creating the admin failed (${created.status})`);

  const login = await post('/auth/login', plan.user);
  if (!login.ok) throw new Error(`setup: login failed (${login.status})`);
  const { token } = await login.json() as { token?: string };
  if (!token) throw new Error('setup: login returned no token');

  const cfg = await post('/config', plan.config, token);
  if (!cfg.ok) throw new Error(`setup: saving config failed (${cfg.status})`);
}
