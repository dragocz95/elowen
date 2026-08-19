import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export const PROVIDER_REQUEST_CANONICALIZATION_VERSION = 1;

export type ProviderRequestKind = 'chat' | 'compaction' | 'remote_compaction';
export type ProviderRequestStatus = 'pending' | 'succeeded' | 'error' | 'interrupted';

export interface ProviderRequestSegmentRef {
  kind: string;
  digest: string;
  canonicalizationVersion: number;
}

export interface ProviderRequestManifest {
  options: ProviderRequestSegmentRef;
  system?: { key: string; segment: ProviderRequestSegmentRef };
  input?: { key: string; segments: ProviderRequestSegmentRef[] };
  tools?: { key: string; segments: ProviderRequestSegmentRef[] };
}

export interface ProviderRequestAttemptInput {
  sessionId: string;
  turnId: string;
  retryOf?: string;
  kind: ProviderRequestKind;
  configuredProvider: string;
  wireProvider: string;
  api: string;
  model: string;
  payload: unknown;
  startedAt?: number;
}

export interface ProviderRequestUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number | { total?: number };
}

export interface ProviderRequestTerminalInput {
  requestId: string;
  status: Exclude<ProviderRequestStatus, 'pending'>;
  response?: unknown;
  assistantMessageId?: string;
  usage?: ProviderRequestUsage;
  errorCode?: string;
  errorMessage?: string;
  finishedAt?: number;
}

interface RequestRow {
  request_id: string;
  session_id: string;
  seq: number;
  status: ProviderRequestStatus;
  started_at: number;
}

function jsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'bigint') throw new Error('provider request capture cannot canonicalize bigint');
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : jsonValue(item, seen));
  if (typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (seen.has(object)) throw new Error('provider request capture cannot canonicalize a cyclic payload');
  seen.add(object);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    const item = jsonValue(object[key], seen);
    if (item !== undefined) out[key] = item;
  }
  seen.delete(object);
  return out;
}

export function canonicalProviderJson(value: unknown): string {
  const normalized = jsonValue(value);
  if (normalized === undefined) throw new Error('provider request capture requires a JSON value');
  return JSON.stringify(normalized);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function costTotal(value: ProviderRequestUsage['cost']): number | null {
  const total = typeof value === 'number' ? value : value?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

export class ProviderRequestStore {
  constructor(private readonly db: Db) {}

  private putSegment(sessionId: string, kind: string, value: unknown): ProviderRequestSegmentRef {
    const version = PROVIDER_REQUEST_CANONICALIZATION_VERSION;
    const payload = canonicalProviderJson(value);
    const digest = createHash('sha256').update(`${version}\0${kind}\0${payload}`).digest('hex');
    const bytes = Buffer.byteLength(payload);
    this.db.prepare(
      `INSERT OR IGNORE INTO brain_request_segments
         (session_id, kind, digest, canonicalization_version, payload, byte_length, estimated_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, kind, digest, version, payload, bytes, Math.ceil(bytes / 4));
    const stored = this.db.prepare(
      `SELECT payload FROM brain_request_segments
        WHERE session_id = ? AND kind = ? AND digest = ? AND canonicalization_version = ?`
    ).get(sessionId, kind, digest, version) as { payload: string } | undefined;
    if (!stored || stored.payload !== payload) {
      throw new Error(`provider request segment digest collision for ${sessionId}/${kind}/${digest}`);
    }
    return { kind, digest, canonicalizationVersion: version };
  }

  private segmentPayload(sessionId: string, ref: ProviderRequestSegmentRef): unknown {
    const row = this.db.prepare(
      `SELECT payload FROM brain_request_segments
        WHERE session_id = ? AND kind = ? AND digest = ? AND canonicalization_version = ?`
    ).get(sessionId, ref.kind, ref.digest, ref.canonicalizationVersion) as { payload: string } | undefined;
    if (!row) throw new Error(`provider request segment missing: ${sessionId}/${ref.kind}/${ref.digest}`);
    return JSON.parse(row.payload) as unknown;
  }

  private splitPayload(sessionId: string, payload: unknown): ProviderRequestManifest {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { options: this.putSegment(sessionId, 'options', payload) };
    }
    const source = payload as Record<string, unknown>;
    const options: Record<string, unknown> = { ...source };
    const manifest: Partial<ProviderRequestManifest> = {};
    const systemKey = Object.hasOwn(source, 'system') ? 'system' : Object.hasOwn(source, 'instructions') ? 'instructions' : undefined;
    if (systemKey) {
      manifest.system = { key: systemKey, segment: this.putSegment(sessionId, 'system', source[systemKey]) };
      delete options[systemKey];
    }
    const inputKey = Array.isArray(source.messages) ? 'messages' : Array.isArray(source.input) ? 'input' : undefined;
    if (inputKey) {
      manifest.input = {
        key: inputKey,
        segments: (source[inputKey] as unknown[]).map((item) => this.putSegment(sessionId, 'input', item)),
      };
      delete options[inputKey];
    }
    if (Array.isArray(source.tools)) {
      manifest.tools = {
        key: 'tools',
        segments: source.tools.map((tool) => this.putSegment(sessionId, 'tool', tool)),
      };
      delete options.tools;
    }
    manifest.options = this.putSegment(sessionId, 'options', options);
    return manifest as ProviderRequestManifest;
  }

  start(input: ProviderRequestAttemptInput): { requestId: string; seq: number } {
    return this.db.transaction(() => {
      const pending = this.db.prepare(
        `SELECT request_id FROM brain_provider_requests WHERE session_id = ? AND status = 'pending' LIMIT 1`
      ).get(input.sessionId) as { request_id: string } | undefined;
      if (pending) throw new Error(`provider request correlation invariant: pending attempt ${pending.request_id} already exists`);
      const seq = (this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM brain_provider_requests WHERE session_id = ?'
      ).get(input.sessionId) as { seq: number }).seq;
      const requestId = randomUUID();
      const startedAt = input.startedAt ?? Date.now();
      const manifest = this.splitPayload(input.sessionId, input.payload);
      this.db.prepare(
        `INSERT INTO brain_provider_requests
           (request_id, session_id, seq, turn_id, retry_of, kind, configured_provider, wire_provider, api,
            model, started_at, status, canonicalization_version, manifest)
         VALUES (@request_id, @session_id, @seq, @turn_id, @retry_of, @kind, @configured_provider,
                 @wire_provider, @api, @model, @started_at, 'pending', @version, @manifest)`
      ).run({
        request_id: requestId, session_id: input.sessionId, seq, turn_id: input.turnId,
        retry_of: input.retryOf ?? null, kind: input.kind, configured_provider: input.configuredProvider,
        wire_provider: input.wireProvider, api: input.api, model: input.model, started_at: startedAt,
        version: PROVIDER_REQUEST_CANONICALIZATION_VERSION, manifest: JSON.stringify(manifest),
      });
      return { requestId, seq };
    })();
  }

  markResponse(requestId: string, status: number, at = Date.now()): void {
    const changed = this.db.prepare(
      `UPDATE brain_provider_requests SET response_at = ?, http_status = ?
        WHERE request_id = ? AND status = 'pending' AND response_at IS NULL`
    ).run(at, status, requestId).changes;
    if (changed !== 1) throw new Error(`provider request correlation invariant: response without one pending attempt (${requestId})`);
  }

  finish(input: ProviderRequestTerminalInput): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT request_id, session_id, seq, status, started_at FROM brain_provider_requests WHERE request_id = ?'
      ).get(input.requestId) as RequestRow | undefined;
      if (!row) throw new Error(`provider request correlation invariant: unknown attempt ${input.requestId}`);
      if (row.status !== 'pending') return false;
      const finishedAt = input.finishedAt ?? Date.now();
      const usage = input.usage;
      const inputTokens = finiteInteger(usage?.input);
      const outputTokens = finiteInteger(usage?.output);
      const reasoningTokens = finiteInteger(usage?.reasoning);
      const cacheReadTokens = finiteInteger(usage?.cacheRead);
      const cacheWriteTokens = finiteInteger(usage?.cacheWrite);
      const totalTokens = finiteInteger(usage?.totalTokens);
      const cost = costTotal(usage?.cost);
      const responseSegment = input.response === undefined
        ? null
        : JSON.stringify(this.putSegment(row.session_id, 'response', input.response));
      const changed = this.db.prepare(
        `UPDATE brain_provider_requests SET
           finished_at = @finished_at, status = @status, error_code = @error_code,
           error_message = @error_message, response_segment = COALESCE(@response_segment, response_segment),
           assistant_message_id = COALESCE(@assistant_message_id, assistant_message_id),
           input_tokens = @input_tokens, output_tokens = @output_tokens, reasoning_tokens = @reasoning_tokens,
           cache_read_tokens = @cache_read_tokens, cache_write_tokens = @cache_write_tokens,
           total_tokens = @total_tokens, cost_usd = @cost_usd, duration_ms = @duration_ms
         WHERE request_id = @request_id AND status = 'pending'`
      ).run({
        request_id: input.requestId, finished_at: finishedAt, status: input.status,
        error_code: input.errorCode ?? null, error_message: input.errorMessage ?? null,
        response_segment: responseSegment, assistant_message_id: input.assistantMessageId ?? null,
        input_tokens: inputTokens, output_tokens: outputTokens, reasoning_tokens: reasoningTokens,
        cache_read_tokens: cacheReadTokens, cache_write_tokens: cacheWriteTokens,
        total_tokens: totalTokens, cost_usd: cost, duration_ms: Math.max(0, finishedAt - row.started_at),
      }).changes;
      if (changed !== 1) throw new Error(`provider request correlation invariant: terminal update lost attempt ${input.requestId}`);
      this.db.prepare(
        `INSERT INTO brain_request_session_summary
           (session_id, capture_started_at, request_count, error_count, first_request_at, last_request_at,
            input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
            total_tokens, cost_usd, costed_request_count)
         VALUES (@session_id, @started_at, 1, @errors, @started_at, @finished_at,
                 @input_tokens, @output_tokens, @reasoning_tokens, @cache_read_tokens, @cache_write_tokens,
                 @total_tokens, @cost, @costed)
         ON CONFLICT(session_id) DO UPDATE SET
           request_count = request_count + 1,
           error_count = error_count + excluded.error_count,
           first_request_at = MIN(first_request_at, excluded.first_request_at),
           last_request_at = MAX(last_request_at, excluded.last_request_at),
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           total_tokens = total_tokens + excluded.total_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           costed_request_count = costed_request_count + excluded.costed_request_count`
      ).run({
        session_id: row.session_id, started_at: row.started_at, finished_at: finishedAt,
        errors: input.status === 'error' || input.status === 'interrupted' ? 1 : 0,
        input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0,
        reasoning_tokens: reasoningTokens ?? 0, cache_read_tokens: cacheReadTokens ?? 0,
        cache_write_tokens: cacheWriteTokens ?? 0, total_tokens: totalTokens ?? 0,
        cost: cost ?? 0, costed: cost === null ? 0 : 1,
      });
      return true;
    })();
  }

  attachResponse(requestId: string, response: unknown, assistantMessageId?: string): void {
    const row = this.db.prepare('SELECT session_id FROM brain_provider_requests WHERE request_id = ?')
      .get(requestId) as { session_id: string } | undefined;
    if (!row) throw new Error(`provider request correlation invariant: unknown attempt ${requestId}`);
    const ref = this.putSegment(row.session_id, 'response', response);
    this.db.prepare(
      `UPDATE brain_provider_requests SET response_segment = ?, assistant_message_id = COALESCE(?, assistant_message_id)
        WHERE request_id = ?`
    ).run(JSON.stringify(ref), assistantMessageId ?? null, requestId);
  }

  reconstruct(requestId: string): unknown {
    const row = this.db.prepare('SELECT session_id, manifest FROM brain_provider_requests WHERE request_id = ?')
      .get(requestId) as { session_id: string; manifest: string } | undefined;
    if (!row) throw new Error(`provider request not found: ${requestId}`);
    const manifest = JSON.parse(row.manifest) as ProviderRequestManifest;
    const options = this.segmentPayload(row.session_id, manifest.options);
    if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
    const payload = { ...(options as Record<string, unknown>) };
    if (manifest.system) payload[manifest.system.key] = this.segmentPayload(row.session_id, manifest.system.segment);
    if (manifest.input) payload[manifest.input.key] = manifest.input.segments.map((ref) => this.segmentPayload(row.session_id, ref));
    if (manifest.tools) payload[manifest.tools.key] = manifest.tools.segments.map((ref) => this.segmentPayload(row.session_id, ref));
    return payload;
  }

  latestPending(sessionId: string): RequestRow | undefined {
    return this.db.prepare(
      `SELECT request_id, session_id, seq, status, started_at FROM brain_provider_requests
        WHERE session_id = ? AND status = 'pending' ORDER BY seq DESC LIMIT 1`
    ).get(sessionId) as RequestRow | undefined;
  }

  row(requestId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM brain_provider_requests WHERE request_id = ?').get(requestId) as Record<string, unknown> | undefined;
  }

  rows(sessionId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM brain_provider_requests WHERE session_id = ? ORDER BY seq').all(sessionId) as Record<string, unknown>[];
  }

  clearSession(sessionId: string): void {
    this.db.prepare('DELETE FROM brain_request_session_summary WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM brain_provider_requests WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM brain_request_segments WHERE session_id = ?').run(sessionId);
  }

  reassignSession(oldId: string, newId: string): void {
    this.db.prepare('UPDATE brain_request_session_summary SET session_id = ? WHERE session_id = ?').run(newId, oldId);
    this.db.prepare('UPDATE brain_provider_requests SET session_id = ? WHERE session_id = ?').run(newId, oldId);
    this.db.prepare('UPDATE brain_request_segments SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  }

  clearUsageForUser(userId: number): void {
    const scope = 'session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)';
    this.db.prepare(
      `UPDATE brain_provider_requests SET input_tokens = NULL, output_tokens = NULL, reasoning_tokens = NULL,
         cache_read_tokens = NULL, cache_write_tokens = NULL, total_tokens = NULL, cost_usd = NULL
       WHERE ${scope}`
    ).run(userId);
    this.db.prepare(
      `UPDATE brain_request_session_summary SET input_tokens = 0, output_tokens = 0, reasoning_tokens = 0,
         cache_read_tokens = 0, cache_write_tokens = 0, total_tokens = 0, cost_usd = 0,
         costed_request_count = 0
       WHERE ${scope}`
    ).run(userId);
  }
}
