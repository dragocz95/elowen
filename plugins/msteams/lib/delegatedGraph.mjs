const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_LIMIT = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function graphMessage(data, fallback) {
  const message = data?.error?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

function requestIdOf(headers, data) {
  return headers?.get?.('request-id') || headers?.get?.('client-request-id') || data?.error?.innerError?.['request-id'] || undefined;
}

export class DelegatedGraphError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DelegatedGraphError';
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    this.permission = options.permission;
  }
}

export function htmlToText(value) {
  return String(value ?? '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function bounded(value, max = DEFAULT_OUTPUT_LIMIT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

function relativeGraphPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith('/')) throw new TypeError('Microsoft Graph path must be relative.');
  if (raw.includes('://')) throw new TypeError('Microsoft Graph path must be relative.');
  const parsed = new URL(`${GRAPH_BASE}${raw}`);
  if (parsed.origin !== GRAPH_ORIGIN || !parsed.pathname.startsWith('/v1.0/')) {
    throw new TypeError('Microsoft Graph path escaped the v1.0 API.');
  }
  return `${parsed.pathname}${parsed.search}`.slice('/v1.0'.length);
}

export function encodeCursor(nextLink) {
  if (!nextLink) return undefined;
  const parsed = new URL(String(nextLink));
  if (parsed.origin !== GRAPH_ORIGIN || !parsed.pathname.startsWith('/v1.0/')) {
    throw new DelegatedGraphError('Microsoft Graph returned an unsafe pagination link.');
  }
  return Buffer.from(`${parsed.pathname}${parsed.search}`.slice('/v1.0'.length)).toString('base64url');
}

export function decodeCursor(cursor, expectedPrefix = '/') {
  let raw;
  try { raw = Buffer.from(String(cursor ?? ''), 'base64url').toString('utf8'); } catch { raw = ''; }
  const path = relativeGraphPath(raw);
  if (!path.startsWith(expectedPrefix)) throw new TypeError('Pagination cursor belongs to a different Microsoft resource.');
  return path;
}

export class DelegatedGraphClient {
  constructor(token, options = {}) {
    if (!token) throw new TypeError('Delegated Microsoft token is required.');
    this.token = token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  }

  async request(method, path, options = {}) {
    const verb = String(method).toUpperCase();
    const relative = relativeGraphPath(path);
    const attempts = verb === 'GET' || verb === 'HEAD' ? 3 : 1;
    let last;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response;
      try {
        response = await this.fetch(`${GRAPH_BASE}${relative}`, {
          method: verb,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: options.accept ?? 'application/json',
            ...(options.body !== undefined ? { 'content-type': options.contentType ?? 'application/json' } : {}),
            ...(options.ifMatch ? { 'if-match': String(options.ifMatch) } : {}),
            ...(options.headers ?? {}),
          },
          ...(options.body !== undefined
            ? { body: options.contentType && options.contentType !== 'application/json' ? options.body : JSON.stringify(options.body) }
            : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        last = new DelegatedGraphError('Microsoft Graph is temporarily unavailable.', { permission: options.permission });
        if (attempt < attempts) { await sleep(150 * attempt); continue; }
        throw last;
      }

      if (response.ok) return response;
      const retryAfter = Number(response.headers?.get?.('retry-after')) || undefined;
      let data = null;
      try { data = await response.clone().json(); } catch {}
      const error = new DelegatedGraphError(
        graphMessage(data, `Microsoft Graph refused this operation (${response.status}).`),
        {
          status: response.status,
          code: data?.error?.code,
          requestId: requestIdOf(response.headers, data),
          retryAfter,
          permission: options.permission,
        },
      );
      if (attempt < attempts && (response.status === 429 || response.status >= 500)) {
        await sleep(Math.min(2_000, retryAfter ? retryAfter * 1_000 : 200 * attempt));
        last = error;
        continue;
      }
      throw error;
    }
    throw last ?? new DelegatedGraphError('Microsoft Graph request failed.', { permission: options.permission });
  }

  async json(method, path, options = {}) {
    const response = await this.request(method, path, options);
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch {
      throw new DelegatedGraphError('Microsoft Graph returned invalid JSON.', { status: response.status, permission: options.permission });
    }
  }

  async binary(path, options = {}) {
    const response = await this.request('GET', path, { ...options, accept: '*/*' });
    const declared = Number(response.headers?.get?.('content-length')) || 0;
    const maxBytes = Number(options.maxBytes) || 20 * 1024 * 1024;
    if (declared > maxBytes) throw new DelegatedGraphError(`Microsoft file exceeds the ${maxBytes} byte transfer limit.`);
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) throw new DelegatedGraphError(`Microsoft file exceeds the ${maxBytes} byte transfer limit.`);
    return { body, contentType: response.headers?.get?.('content-type') || 'application/octet-stream' };
  }

  async page(path, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
    const actualPath = options.cursor ? decodeCursor(options.cursor, options.cursorPrefix ?? '/') : withTop(path, limit);
    const data = await this.json('GET', actualPath, { permission: options.permission });
    const items = Array.isArray(data?.value) ? data.value : [];
    return { items, nextCursor: encodeCursor(data?.['@odata.nextLink']) };
  }
}

function withTop(path, limit) {
  const parsed = new URL(`${GRAPH_BASE}${relativeGraphPath(path)}`);
  if (!parsed.searchParams.has('$top')) parsed.searchParams.set('$top', String(limit));
  return `${parsed.pathname}${parsed.search}`.slice('/v1.0'.length);
}
