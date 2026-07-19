import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

/** PI's OAuth-config shape for `registerProvider({ oauth })`. PI 0.80.8 stopped exporting the type by
 *  name, so we derive it from the registration API it feeds — the single source of truth. */
type ExtensionOAuthConfig = NonNullable<Parameters<ModelRegistry['registerProvider']>[1]['oauth']>;

/**
 * Kimi Code (Moonshot AI) sign-in: RFC 8628 device authorization.
 *
 * PI owns everything stateful — `AuthStorage` refreshes lazily on read under a file lock and re-checks
 * inside it, so the daemon, CLI and cron can race safely against one `auth.json`. This module is only the
 * three pure-ish operations PI asks a provider for: run a device flow, exchange a refresh token, and say
 * which field is the API key.
 *
 * The client id and the `X-Msh-*` contract are lifted from Kimi's CLI (there is no published OAuth spec);
 * a rotation on their side surfaces as a failed login, never as silent corruption.
 */

/** Kimi Code's OAuth client id. */
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const DEVICE_CODE_URL = 'https://auth.kimi.com/api/oauth/device_authorization';
const TOKEN_URL = 'https://auth.kimi.com/api/oauth/token';

/** Kimi CLI's own identity. Matches the descriptors PI ships for the `kimi-coding` provider, which pin the
 *  same `User-Agent` per model — the endpoint is the coding subscription's, not the generic Moonshot API. */
export const KIMI_CLI_VERSION = '1.5';
const USER_AGENT = `KimiCLI/${KIMI_CLI_VERSION}`;

/** PI compares `Date.now() >= credentials.expires` with no margin of its own, so the margin has to live in
 *  the value we store. Five minutes, the same skew PI's own GitHub Copilot provider bakes in. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Kimi credentials carry the device identity the flow was authorized under. `OAuthCredentials` is an open
 *  record precisely so a provider can round-trip its own fields (Copilot carries `enterpriseUrl` this way).
 *  It matters here: Kimi's CLI keeps one device id across refreshes, so a fresh id on every refresh would
 *  present the same account as an endless stream of new devices. */
interface KimiCredentials extends OAuthCredentials {
  deviceId: string;
}

const deviceModel = (): string => `${process.platform} ${process.arch}`;

/** A header value fetch will accept. Header values are Latin-1, and `fetch` throws a TypeError on anything
 *  outside it — so a machine named e.g. "Filip's-Macbook-Přenosný" would fail every Kimi call before it left
 *  the process. The name is only a label in Kimi's device list, so dropping the odd character is a fair
 *  trade for a login that works; an empty result falls back rather than sending a blank header. */
const headerSafe = (value: string, fallback: string): string => {
  const cleaned = value.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
  return cleaned || fallback;
};

const authHeaders = (deviceId: string): Record<string, string> => ({
  'Accept': 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': USER_AGENT,
  'X-Msh-Platform': 'kimi_cli',
  'X-Msh-Version': KIMI_CLI_VERSION,
  'X-Msh-Device-Id': deviceId,
  'X-Msh-Device-Name': headerSafe(hostname(), 'unknown'),
  'X-Msh-Device-Model': deviceModel(),
});

interface FormResponse {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
}

/**
 * POST a form and parse the JSON body. The status is REPORTED, never enforced: the token endpoint answers
 * `400 {"error":"authorization_pending"}` while it waits for the user, so a caller that rejects on a
 * non-2xx would abort every login the instant it started. Verified live against auth.kimi.com — and note
 * the Go client this was modelled on gets the same result the same way, by ignoring the status on the token
 * call, whatever its comment claims. Each caller decides what its own statuses mean.
 */
async function postForm(url: string, deviceId: string, body: Record<string, string>, signal?: AbortSignal): Promise<FormResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(deviceId),
    body: new URLSearchParams(body),
    signal,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Kimi ${response.status} returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  return { ok: response.ok, status: response.status, statusText: response.statusText, data };
}

/** The OAuth error code in a response body, whatever the status carrying it. */
const errorCode = (data: unknown): string | undefined =>
  isRecord(data) && typeof data.error === 'string' ? data.error : undefined;

const errorText = (r: FormResponse): string => {
  const code = errorCode(r.data);
  const description = isRecord(r.data) && typeof r.data.error_description === 'string' ? r.data.error_description : '';
  if (code) return description ? `${code}: ${description}` : code;
  return `${r.status} ${r.statusText}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds: number;
}

async function startDeviceFlow(deviceId: string, signal?: AbortSignal): Promise<DeviceCode> {
  const response = await postForm(DEVICE_CODE_URL, deviceId, { client_id: CLIENT_ID }, signal);
  // Unlike the token call, there is no pending state here: a non-2xx is a real refusal.
  if (!response.ok) throw new Error(`Kimi refused the device request (${errorText(response)})`);
  const raw = response.data;
  if (!isRecord(raw)) throw new Error('Invalid Kimi device code response');
  const { device_code: deviceCode, user_code: userCode, interval, expires_in: expiresIn } = raw;
  // Kimi returns both; the pre-filled one is what the user actually wants to open.
  const uri = raw.verification_uri_complete ?? raw.verification_uri;
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof uri !== 'string'
    || typeof expiresIn !== 'number' || (interval !== undefined && typeof interval !== 'number')) {
    throw new Error('Invalid Kimi device code response fields');
  }
  // This URI reaches a browser opener, so it must be a real http(s) URL and never anything `open` could
  // execute. Same guard PI applies to Copilot's device response.
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('Untrusted verification_uri in Kimi device code response');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Untrusted verification_uri in Kimi device code response');
  }
  return { deviceCode, userCode, verificationUri: parsed.href, intervalSeconds: interval, expiresInSeconds: expiresIn };
}

/** Shape a token response into PI's credential. Kimi reports `expires_in` seconds from now. */
function toCredentials(raw: unknown, deviceId: string, fallbackRefresh?: string): KimiCredentials {
  if (!isRecord(raw)) throw new Error('Invalid Kimi token response');
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = raw;
  if (typeof access !== 'string' || access === '') throw new Error('Kimi token response carried no access token');
  // A refresh that rotates its own token replaces it; one that does not keeps the token we already hold.
  const refreshToken = typeof refresh === 'string' && refresh !== '' ? refresh : fallbackRefresh;
  if (!refreshToken) throw new Error('Kimi token response carried no refresh token');
  return {
    refresh: refreshToken,
    access,
    expires: typeof expiresIn === 'number' && expiresIn > 0
      ? Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS
      // No expiry told: treat it as already due so the next read revalidates rather than trusting it forever.
      : 0,
    deviceId,
  };
}

/** RFC 8628 §3.2: a client polls at 5s when the server omits `interval`; §3.5: a `slow_down` raises it by
 *  5s. PI clamps to a 1s floor. These drive the token poll below. */
const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5_000;

/** A sleep a login abort can cut short. Uses the same `setTimeout` PI's helper did, so a caller on fake
 *  timers (the login tests) drains it deterministically instead of waiting real seconds. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Kimi login cancelled')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('Kimi login cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Drive the device-authorization token poll to a credential (RFC 8628 §3.4–3.5). Ported from PI's own
 * device-code helper, which its 0.80.8 release dropped from the public surface — inlined here so the login
 * rides our `postForm` and no longer imports a pi-ai internal that can vanish under us.
 *
 * The BODY decides every outcome, never the status: while the user has not approved yet, Kimi answers
 * `400 {"error":"authorization_pending"}`, so treating a non-2xx as failure would kill every login on its
 * first poll. We wait one interval before the first attempt — the code has only just been shown.
 */
async function pollForToken(device: DeviceCode, deviceId: string, signal?: AbortSignal): Promise<KimiCredentials> {
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.floor((device.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000));
  let slowedDown = false;

  const firstWait = Math.min(intervalMs, deadline - Date.now());
  if (firstWait > 0) await abortableSleep(firstWait, signal);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Kimi login cancelled');
    const response = await postForm(TOKEN_URL, deviceId, {
      client_id: CLIENT_ID,
      device_code: device.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, signal);
    const code = errorCode(response.data);
    if (code === 'slow_down') {
      slowedDown = true;
      // Trust a server-named interval when given; otherwise apply the +5s. A client-only bump risks polling
      // early forever under WSL/VM clock drift.
      const named = isRecord(response.data) ? response.data.interval : undefined;
      intervalMs = typeof named === 'number' && Number.isFinite(named) && named > 0
        ? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(named * 1000))
        : Math.max(MIN_POLL_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    } else if (code && code !== 'authorization_pending') {
      throw new Error(`Kimi login failed: ${errorText(response)}`);
    } else if (!code && isRecord(response.data) && typeof response.data.access_token === 'string') {
      return toCredentials(response.data, deviceId);
    } else if (!code) {
      throw new Error(`Invalid Kimi device token response (${errorText(response)})`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await abortableSleep(Math.min(intervalMs, remaining), signal);
  }
  throw new Error(slowedDown
    ? 'Kimi login timed out after a slow_down — often VM/WSL clock drift; sync the clock and retry.'
    : 'Kimi login timed out');
}

/** The device id a refresh must replay, tolerating a credential written before this field existed. */
const credentialDeviceId = (credentials: OAuthCredentials): string =>
  typeof credentials.deviceId === 'string' && credentials.deviceId ? credentials.deviceId : randomUUID();

/**
 * Kimi's OAuth config, attached to the built-in `kimi-coding` provider through
 * `ModelRegistry.registerProvider({ oauth })` — PI ships `kimi-coding` as an API-key provider, so this is
 * what makes it loginable. The provider id is stamped from the name it is registered under.
 */
export const kimiOAuthProvider: ExtensionOAuthConfig = {
  name: 'Kimi',
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const deviceId = randomUUID();
    const device = await startDeviceFlow(deviceId, callbacks.signal);
    callbacks.onDeviceCode({
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: device.expiresInSeconds,
    });
    return pollForToken(device, deviceId, callbacks.signal);
  },
  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const deviceId = credentialDeviceId(credentials);
    const response = await postForm(TOKEN_URL, deviceId, {
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refresh,
    });
    // No pending state on a refresh: a refusal here is final and must surface, so PI stops handing out an
    // access token the endpoint has already rejected and the operator is told to sign in again.
    if (!response.ok || errorCode(response.data)) {
      throw new Error(`Kimi refused the refresh (${errorText(response)})`);
    }
    return toCredentials(response.data, deviceId, credentials.refresh);
  },
  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};
