/**
 * One HTTP client for plugins that talk to an external API — so every integration gets the same
 * timeout, the same concurrency ceiling, the same retry rules and the same shape of failure, instead of
 * each one inventing its own `fetch` wrapper and getting a different subset right.
 *
 * Nothing here logs. Headers carry credentials, so the client never writes them anywhere; a caller that
 * wants visibility gets the safe facts (attempt number, delay, status) through `onRetry`.
 */

/** Methods safe to send again after a failure. A retried POST/PATCH can create a second order or a second
 *  message, so those are never repeated — a caller that knows its own POST is idempotent says so per call
 *  with `retry: true`, which is a decision only the caller can make. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/** Statuses worth trying again: the server said "later" (429), was momentarily unavailable (502/503/504),
 *  or timed the request out itself (408). Every other 4xx is the caller's own fault and repeating it just
 *  spends the rate limit on the same rejection. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** A failed request as DATA: the status when the server answered, the parsed/raw body it answered with,
 *  and a message safe to show a user. `status` is null when the request never got an answer at all
 *  (transport error, timeout, abort) — a distinction the caller needs, because only one of the two says
 *  anything about what the far end thinks. */
export class HttpError extends Error {
  constructor(message, { status = null, data = undefined, body = '', url = '', method = '', cause = undefined, timedOut = false, aborted = false } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
    this.body = body;
    this.url = url;
    this.method = method;
    this.timedOut = timedOut;
    this.aborted = aborted;
  }
}

/** Parse a response body without ever throwing: a broken JSON payload from a misbehaving server must
 *  surface as an error the caller can read, not as an exception from inside the parser that hides both the
 *  status and the text. Returns the decoded value plus the raw text it came from. */
async function readBody(res) {
  let text = '';
  try { text = await res.text(); }
  catch { return { data: undefined, text: '' } }
  if (text === '') return { data: undefined, text };
  const type = res.headers.get('content-type') ?? '';
  if (!/\bjson\b/i.test(type)) return { data: text, text };
  try { return { data: JSON.parse(text), text }; }
  catch { return { data: undefined, text }; }
}

/** How long the server asked us to wait, in ms, or null when it did not say. Reads `Retry-After` (both
 *  forms: delay-seconds and an HTTP date) and the common rate-limit reset headers. A server's own number
 *  always beats our backoff guess — that is the one the far end will actually honour. */
function serverRetryDelayMs(res, nowMs) {
  if (!res) return null;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  // Discord-style: seconds from now.
  const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
  if (Number.isFinite(resetAfter) && resetAfter >= 0) return resetAfter * 1000;
  // GitHub-style: an absolute epoch-second timestamp.
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - nowMs);
  return null;
}

/** Serialize a query object. `undefined`/`null` values are dropped (an absent filter is not the string
 *  "undefined"); an array becomes one repeated key, which is what nearly every API expects. */
function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) { if (v !== undefined && v !== null) params.append(key, String(v)); }
    else params.append(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** True for a value that has to be serialized before it can be sent — i.e. a plain object or array, and
 *  nothing the platform already knows how to put on the wire. */
function isPlainBody(body) {
  if (body === undefined || body === null) return false;
  if (typeof body === 'string') return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false;
  if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return false;
  return typeof body === 'object';
}

function joinUrl(baseUrl, path) {
  if (!baseUrl) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/** A ceiling on requests in flight. An integration that fans out over a list must not open a hundred
 *  sockets at once: the far end rate-limits it, and the daemon shares its event loop with every other
 *  plugin. Queued callers start in the order they arrived. */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max) return;
    const run = waiting.shift();
    if (!run) return;
    active += 1;
    run();
  };
  return async function limit(fn) {
    if (active >= max) await new Promise((resolve) => { waiting.push(resolve); });
    else active += 1;
    try { return await fn(); }
    finally { active -= 1; next(); }
  };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  // Already cancelled: do not park for the full delay first.
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  if (ms <= 0) return resolve();
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Build a client bound to one API.
 *
 *  - `baseUrl` / `headers` — prefix and the headers every call carries (auth, accept). Per-call headers
 *    merge over these.
 *  - `timeoutMs` — per ATTEMPT, not per call: a retried request gets the full budget again, because the
 *    point of the retry is that the previous attempt was the broken one.
 *  - `maxConcurrent` — requests in flight from this client.
 *  - `maxRetries` — extra attempts after the first, for idempotent requests only.
 *  - `maxBackoffMs` — hard ceiling on ONE wait, so a far end asking for an hour cannot park a turn.
 *  - `onRetry({ attempt, delayMs, status, method })` — safe facts only; no headers, no URL credentials.
 *  - `fetchImpl` — injectable for tests.
 */
export function createHttpClient({
  baseUrl = '',
  headers: baseHeaders = {},
  timeoutMs = 15000,
  maxConcurrent = 4,
  maxRetries = 2,
  maxBackoffMs = 30000,
  onRetry,
  fetchImpl = globalThis.fetch,
} = {}) {
  const limit = createLimiter(Math.max(1, maxConcurrent));

  async function request(path, options = {}) {
    const method = (options.method ?? 'GET').toUpperCase();
    const url = joinUrl(baseUrl, path) + queryString(options.query);
    const perAttemptTimeout = options.timeoutMs ?? timeoutMs;
    // Retrying is opt-out for an idempotent method and opt-IN for anything else: only the caller knows
    // whether its own POST can safely happen twice.
    const mayRetry = options.retry ?? IDEMPOTENT_METHODS.has(method);
    const attempts = mayRetry ? Math.max(0, maxRetries) + 1 : 1;
    const outer = options.signal;

    const headers = { ...baseHeaders, ...(options.headers ?? {}) };
    // A plain object is the common case and becomes JSON; anything the platform can already send as a
    // body (multipart form, blob, stream, bytes) is passed through untouched — serializing a FormData
    // would turn a file upload into the string "[object FormData]".
    let body = options.body;
    if (isPlainBody(body)) {
      body = JSON.stringify(body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // The caller's abort and our own deadline are ONE signal, so a tool the user cancelled stops
      // immediately instead of finishing its timeout first.
      const timeout = AbortSignal.timeout(perAttemptTimeout);
      const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
      let res = null;
      try {
        res = await limit(() => fetchImpl(url, { method, headers, body, signal }));
      } catch (e) {
        // An abort the CALLER asked for is final — it is not a failure to retry, it is the answer.
        if (outer?.aborted) throw new HttpError('request aborted', { url, method, cause: e, aborted: true });
        lastError = new HttpError(timeout.aborted ? `request timed out after ${perAttemptTimeout} ms` : `request failed: ${e instanceof Error ? e.message : String(e)}`, {
          url, method, cause: e, timedOut: timeout.aborted,
        });
      }

      if (res) {
        const { data, text } = await readBody(res);
        if (res.ok) return { ok: true, status: res.status, headers: res.headers, data, text };
        lastError = new HttpError(`${method} failed with ${res.status}`, { status: res.status, data, body: text, url, method });
        if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
      }

      if (attempt === attempts) break;
      const serverDelay = serverRetryDelayMs(res, Date.now());
      // Exponential backoff with jitter, but the server's own number wins when it gave one. Both are
      // capped: a far end that asks for an hour must not hold a turn hostage — we fail and say why.
      const backoff = Math.min(maxBackoffMs, 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
      const delayMs = Math.min(maxBackoffMs, serverDelay ?? backoff);
      onRetry?.({ attempt, delayMs, status: res?.status ?? null, method });
      // A cancel that lands while we are WAITING is the same answer as one that lands mid-request, so it
      // has to arrive in the same shape — a caller branching on `err.aborted` must not read it as one
      // more retryable failure.
      try { await sleep(delayMs, outer); }
      catch (e) { throw new HttpError('request aborted', { url, method, cause: e, aborted: true }); }
    }
    throw lastError ?? new HttpError('request failed', { url, method });
  }

  return {
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
  };
}
