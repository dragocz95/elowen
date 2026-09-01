import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { CHANNEL_PREFIX, SUBAGENT_PLATFORM } from '../brain/sessionId.js';
import type {
  BrainDebugPage, BrainDebugPayloadPage, BrainDebugRawPayload, BrainDebugRequestDetail,
  BrainDebugRequestItem, BrainDebugRequestStatus, BrainDebugSegmentManifestItem, BrainDebugSegmentPayload,
  BrainDebugSessionItem, BrainDebugSessionPage, BrainDebugSurface,
} from '../shared/wireContract.js';

export const PROVIDER_REQUEST_CANONICALIZATION_VERSION = 1;

export type ProviderRequestKind = 'chat' | 'compaction' | 'remote_compaction';
export type ProviderRequestStatus = 'pending' | 'succeeded' | 'error' | 'interrupted';

export interface ProviderRequestSegmentRef {
  kind: string;
  digest: string;
  canonicalizationVersion: number;
  display?: { role?: string; label?: string; preview?: string };
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

export interface ProviderRequestDebugSessionFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  from?: string;
  to?: string;
  userId?: number;
  surface?: BrainDebugSurface;
  provider?: string;
  model?: string;
  status?: BrainDebugRequestStatus | 'captured' | 'legacy';
}

export interface ProviderRequestDebugRequestFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  kind?: ProviderRequestKind;
  provider?: string;
  model?: string;
  status?: BrainDebugRequestStatus;
}

interface SegmentRefEntry {
  section: BrainDebugSegmentManifestItem['section'];
  key: string | null;
  ref: ProviderRequestSegmentRef;
}

interface SegmentEntry extends BrainDebugSegmentManifestItem {
  ref: ProviderRequestSegmentRef;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T; }
  catch { throw new Error('invalid debug cursor'); }
}

function boundedLimit(limit: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(max, Math.floor(limit!))) : fallback;
}

function sessionSurface(id: string): BrainDebugSurface {
  if (id.startsWith(`${CHANNEL_PREFIX}${SUBAGENT_PLATFORM}-`)) return 'subagent';
  if (id.startsWith(CHANNEL_PREFIX)) return 'channel';
  return 'conversation';
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

function displayRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Whether a content block is model reasoning. The viewer keeps reasoning collapsed, so it must not become
 *  the preview of a message that also carries a visible answer — but it is still readable text, so a
 *  message consisting of nothing else falls back to it rather than to raw JSON. */
function isReasoningBlock(value: unknown): boolean {
  const record = displayRecord(value);
  if (!record) return false;
  return typeof record.thinking === 'string' || /reason|thinking/i.test(String(record.type ?? ''));
}

function displayText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > 3) return '';
  if (Array.isArray(value)) {
    const rendered = value
      .map((item) => [displayText(item, depth + 1), isReasoningBlock(item)] as const)
      .filter(([text]) => text);
    const visible = rendered.filter(([, reasoning]) => !reasoning);
    return (visible.length ? visible : rendered).map(([text]) => text).join(' ');
  }
  const record = displayRecord(value);
  if (!record) return '';
  // `thinking` is Anthropic's reasoning field; without it the block serializes to JSON in the preview.
  for (const key of ['text', 'output_text', 'input_text', 'thinking', 'description']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  if (record.content !== undefined) {
    const content = displayText(record.content, depth + 1);
    if (content) return content;
  }
  const fn = displayRecord(record.function);
  const name = typeof record.name === 'string' ? record.name : typeof fn?.name === 'string' ? fn.name : undefined;
  const args = record.input ?? record.arguments ?? fn?.arguments;
  if (name) return args === undefined ? name : `${name} ${JSON.stringify(args)}`;
  try { return JSON.stringify(record); } catch { return ''; }
}

function segmentDisplay(kind: string, value: unknown): ProviderRequestSegmentRef['display'] {
  const record = displayRecord(value);
  const fn = displayRecord(record?.function);
  const rawRole = typeof record?.role === 'string' ? record.role : typeof record?.type === 'string' ? record.type : undefined;
  const role = kind === 'system' ? 'system' : kind === 'tool' ? 'tool' : kind === 'options' ? 'options'
    : kind === 'response' ? rawRole ?? 'assistant' : rawRole;
  const label = typeof record?.name === 'string' ? record.name
    : typeof fn?.name === 'string' ? fn.name
      : typeof record?.type === 'string' ? record.type
        : role ?? kind;
  const preview = displayText(value).replace(/\s+/g, ' ').trim().slice(0, 240);
  return { ...(role ? { role } : {}), ...(label ? { label } : {}), ...(preview ? { preview } : {}) };
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
    return { kind, digest, canonicalizationVersion: version, display: segmentDisplay(kind, value) };
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
        `SELECT r.request_id, r.session_id, r.seq, r.status, r.started_at,
                COALESCE(reset.usage_epoch, 0) AS usage_epoch
           FROM brain_provider_requests r
           JOIN brain_sessions s ON s.id = r.session_id
           LEFT JOIN brain_usage_reset_state reset ON reset.user_id = s.user_id
          WHERE r.request_id = ?`
      ).get(input.requestId) as (RequestRow & { usage_epoch: number }) | undefined;
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
           total_tokens = @total_tokens, cost_usd = @cost_usd, duration_ms = @duration_ms,
           usage_epoch = @usage_epoch
         WHERE request_id = @request_id AND status = 'pending'`
      ).run({
        request_id: input.requestId, finished_at: finishedAt, status: input.status,
        error_code: input.errorCode ?? null, error_message: input.errorMessage ?? null,
        response_segment: responseSegment, assistant_message_id: input.assistantMessageId ?? null,
        input_tokens: inputTokens, output_tokens: outputTokens, reasoning_tokens: reasoningTokens,
        cache_read_tokens: cacheReadTokens, cache_write_tokens: cacheWriteTokens,
        total_tokens: totalTokens, cost_usd: cost, duration_ms: Math.max(0, finishedAt - row.started_at),
        usage_epoch: row.usage_epoch,
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

  private sessionItem(row: Record<string, unknown>): BrainDebugSessionItem {
    return {
      id: String(row.id), userId: Number(row.user_id), username: String(row.username), userName: String(row.name ?? ''),
      title: String(row.title), surface: sessionSurface(String(row.id)), provider: String(row.latest_provider ?? ''),
      model: String(row.latest_model ?? ''), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      captureStartedAt: row.capture_started_at === null || row.capture_started_at === undefined ? null : Number(row.capture_started_at),
      requestCount: Number(row.request_count ?? 0), errorCount: Number(row.error_count ?? 0),
      firstRequestAt: row.first_request_at === null || row.first_request_at === undefined ? null : Number(row.first_request_at),
      lastRequestAt: row.last_request_at === null || row.last_request_at === undefined ? null : Number(row.last_request_at),
      inputTokens: Number(row.input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0),
      reasoningTokens: Number(row.reasoning_tokens ?? 0), cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0), totalTokens: Number(row.total_tokens ?? 0),
      costUsd: Number(row.cost_usd ?? 0), costedRequestCount: Number(row.costed_request_count ?? 0),
      latestRequestStatus: (row.latest_status as BrainDebugRequestStatus | null | undefined) ?? null,
    };
  }

  debugSessions(filters: ProviderRequestDebugSessionFilters = {}): BrainDebugSessionPage {
    const limit = boundedLimit(filters.limit, 50, 100);
    const where: string[] = [];
    const params: unknown[] = [];
    const cursor = decodeCursor<{ updatedAt: string; id: string }>(filters.cursor);
    if (cursor) {
      if (typeof cursor.updatedAt !== 'string' || typeof cursor.id !== 'string') throw new Error('invalid debug cursor');
      where.push('(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))');
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const search = filters.search?.trim().toLowerCase();
    if (search) {
      where.push(`(lower(s.id) LIKE ? OR lower(s.title) LIKE ? OR lower(u.username) LIKE ? OR lower(u.name) LIKE ?)`);
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    if (filters.from) { where.push('s.updated_at >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('s.updated_at <= ?'); params.push(filters.to); }
    if (filters.userId !== undefined) { where.push('s.user_id = ?'); params.push(filters.userId); }
    if (filters.surface) {
      const subagent = `${CHANNEL_PREFIX}${SUBAGENT_PLATFORM}-%`;
      if (filters.surface === 'subagent') { where.push('s.id LIKE ?'); params.push(subagent); }
      else if (filters.surface === 'channel') { where.push('s.id LIKE ? AND s.id NOT LIKE ?'); params.push(`${CHANNEL_PREFIX}%`, subagent); }
      else { where.push('s.id NOT LIKE ?'); params.push(`${CHANNEL_PREFIX}%`); }
    }
    if (filters.provider) {
      where.push(`COALESCE((SELECT r.configured_provider FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1), s.provider) = ?`);
      params.push(filters.provider);
    }
    if (filters.model) {
      where.push(`COALESCE((SELECT r.model FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1), s.model) = ?`);
      params.push(filters.model);
    }
    if (filters.status === 'captured') where.push('EXISTS (SELECT 1 FROM brain_provider_requests r WHERE r.session_id = s.id)');
    else if (filters.status === 'legacy') where.push('NOT EXISTS (SELECT 1 FROM brain_provider_requests r WHERE r.session_id = s.id)');
    else if (filters.status) {
      where.push('EXISTS (SELECT 1 FROM brain_provider_requests r WHERE r.session_id = s.id AND r.status = ?)');
      params.push(filters.status);
    }
    const rows = this.db.prepare(
      `SELECT s.id, s.user_id, s.title, s.provider, s.model, s.created_at, s.updated_at,
              u.username, u.name,
              COALESCE(summary.capture_started_at, (SELECT MIN(r.started_at) FROM brain_provider_requests r WHERE r.session_id = s.id)) capture_started_at,
              summary.request_count, summary.error_count,
              summary.first_request_at, summary.last_request_at, summary.input_tokens,
              summary.output_tokens, summary.reasoning_tokens, summary.cache_read_tokens,
              summary.cache_write_tokens, summary.total_tokens, summary.cost_usd,
              summary.costed_request_count,
              (SELECT r.status FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1) latest_status,
              COALESCE((SELECT r.configured_provider FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1), s.provider) latest_provider,
              COALESCE((SELECT r.model FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1), s.model) latest_model
         FROM brain_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN brain_request_session_summary summary ON summary.session_id = s.id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`
    ).all(...params, limit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((row) => this.sessionItem(row));
    const last = items.at(-1);
    const capture = this.db.prepare('SELECT MIN(capture_started_at) value FROM brain_request_session_summary')
      .get() as { value: number | null };
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
      captureStartedAt: capture.value === null ? null : Number(capture.value),
    };
  }

  debugSession(sessionId: string): BrainDebugSessionItem | undefined {
    const row = this.db.prepare(
      `SELECT s.id, s.user_id, s.title, s.provider, s.model, s.created_at, s.updated_at,
              u.username, u.name,
              COALESCE(summary.capture_started_at, (SELECT MIN(r.started_at) FROM brain_provider_requests r WHERE r.session_id = s.id)) capture_started_at,
              summary.request_count, summary.error_count,
              summary.first_request_at, summary.last_request_at, summary.input_tokens,
              summary.output_tokens, summary.reasoning_tokens, summary.cache_read_tokens,
              summary.cache_write_tokens, summary.total_tokens, summary.cost_usd,
              summary.costed_request_count,
              (SELECT r.status FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1) latest_status,
              COALESCE((SELECT r.configured_provider FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1), s.provider) latest_provider,
              COALESCE((SELECT r.model FROM brain_provider_requests r WHERE r.session_id = s.id ORDER BY r.seq DESC LIMIT 1), s.model) latest_model
         FROM brain_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN brain_request_session_summary summary ON summary.session_id = s.id
        WHERE s.id = ?`
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.sessionItem(row) : undefined;
  }

  private requestItem(row: Record<string, unknown>): BrainDebugRequestItem {
    const visibleUsage = Number(row.usage_epoch ?? 0) === Number(row.current_usage_epoch ?? 0);
    const usage = (value: unknown): number | null => visibleUsage && value !== null ? Number(value) : null;
    return {
      requestId: String(row.request_id), sessionId: String(row.session_id), seq: Number(row.seq), turnId: String(row.turn_id),
      retryOf: row.retry_of === null ? null : String(row.retry_of), kind: row.kind as ProviderRequestKind,
      configuredProvider: String(row.configured_provider), wireProvider: String(row.wire_provider), api: String(row.api), model: String(row.model),
      startedAt: Number(row.started_at), responseAt: row.response_at === null ? null : Number(row.response_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at), status: row.status as BrainDebugRequestStatus,
      httpStatus: row.http_status === null ? null : Number(row.http_status), errorCode: row.error_code === null ? null : String(row.error_code),
      errorMessage: row.error_message === null ? null : String(row.error_message), inputTokens: usage(row.input_tokens),
      outputTokens: usage(row.output_tokens), reasoningTokens: usage(row.reasoning_tokens),
      cacheReadTokens: usage(row.cache_read_tokens), cacheWriteTokens: usage(row.cache_write_tokens),
      totalTokens: usage(row.total_tokens), costUsd: usage(row.cost_usd),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    };
  }

  debugRequests(sessionId: string, filters: ProviderRequestDebugRequestFilters = {}): BrainDebugPage<BrainDebugRequestItem> | undefined {
    if (!this.db.prepare('SELECT 1 FROM brain_sessions WHERE id = ?').get(sessionId)) return undefined;
    const limit = boundedLimit(filters.limit, 50, 100);
    const where = ['r.session_id = ?'];
    const params: unknown[] = [sessionId];
    const cursor = decodeCursor<{ seq: number }>(filters.cursor);
    if (cursor) {
      if (!Number.isInteger(cursor.seq) || cursor.seq < 0) throw new Error('invalid debug cursor');
      where.push('r.seq > ?'); params.push(cursor.seq);
    }
    if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
    if (filters.kind) { where.push('r.kind = ?'); params.push(filters.kind); }
    if (filters.provider) { where.push('(r.configured_provider = ? OR r.wire_provider = ?)'); params.push(filters.provider, filters.provider); }
    if (filters.model) { where.push('r.model = ?'); params.push(filters.model); }
    const search = filters.search?.trim().toLowerCase();
    if (search) {
      where.push(`(lower(r.request_id) LIKE ? OR lower(r.turn_id) LIKE ? OR lower(COALESCE(r.error_code, '')) LIKE ? OR lower(COALESCE(r.error_message, '')) LIKE ?)`);
      const pattern = `%${search}%`; params.push(pattern, pattern, pattern, pattern);
    }
    const rows = this.db.prepare(
      `SELECT r.request_id, r.session_id, r.seq, r.turn_id, r.retry_of, r.kind, r.configured_provider, r.wire_provider,
              r.api, r.model, r.started_at, r.response_at, r.finished_at, r.status, r.http_status, r.error_code,
              r.error_message, r.input_tokens, r.output_tokens, r.reasoning_tokens, r.cache_read_tokens,
              r.cache_write_tokens, r.total_tokens, r.cost_usd, r.duration_ms, r.usage_epoch,
              COALESCE(reset.usage_epoch, 0) AS current_usage_epoch
         FROM brain_provider_requests r
         JOIN brain_sessions s ON s.id = r.session_id
         LEFT JOIN brain_usage_reset_state reset ON reset.user_id = s.user_id
        WHERE ${where.join(' AND ')} ORDER BY r.seq ASC LIMIT ?`
    ).all(...params, limit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.requestItem(row));
    return { items, nextCursor: hasMore ? encodeCursor({ seq: items.at(-1)!.seq }) : null };
  }

  private segmentRefs(row: { manifest: string; response_segment: string | null }): SegmentRefEntry[] {
    const manifest = JSON.parse(row.manifest) as ProviderRequestManifest;
    const refs: SegmentRefEntry[] = [];
    if (manifest.system) refs.push({ section: 'system', key: manifest.system.key, ref: manifest.system.segment });
    for (const ref of manifest.input?.segments ?? []) refs.push({ section: 'input', key: manifest.input!.key, ref });
    for (const ref of manifest.tools?.segments ?? []) refs.push({ section: 'tool', key: manifest.tools!.key, ref });
    refs.push({ section: 'options', key: null, ref: manifest.options });
    if (row.response_segment) refs.push({ section: 'response', key: null, ref: JSON.parse(row.response_segment) as ProviderRequestSegmentRef });
    return refs;
  }

  private segmentEntries(sessionId: string, refs: SegmentRefEntry[], start = 0, count = refs.length - start): SegmentEntry[] {
    const selected = refs.slice(start, start + count);
    const metadata = new Map<string, { byte_length: number; estimated_tokens: number }>();
    for (let offset = 0; offset < selected.length; offset += 100) {
      const chunk = selected.slice(offset, offset + 100);
      const clauses = chunk.map(() => '(kind = ? AND digest = ? AND canonicalization_version = ?)').join(' OR ');
      const params = chunk.flatMap((entry) => [entry.ref.kind, entry.ref.digest, entry.ref.canonicalizationVersion]);
      const rows = this.db.prepare(
        `SELECT kind, digest, canonicalization_version, byte_length, estimated_tokens
           FROM brain_request_segments WHERE session_id = ? AND (${clauses})`
      ).all(sessionId, ...params) as { kind: string; digest: string; canonicalization_version: number; byte_length: number; estimated_tokens: number }[];
      for (const row of rows) metadata.set(`${row.kind}\0${row.digest}\0${row.canonicalization_version}`, row);
    }
    return selected.map((entry, relativeIndex) => {
      const key = `${entry.ref.kind}\0${entry.ref.digest}\0${entry.ref.canonicalizationVersion}`;
      const segment = metadata.get(key);
      if (!segment) throw new Error(`provider request segment missing: ${sessionId}/${entry.ref.kind}/${entry.ref.digest}`);
      return {
        index: start + relativeIndex, section: entry.section, key: entry.key, kind: entry.ref.kind, digest: entry.ref.digest,
        canonicalizationVersion: entry.ref.canonicalizationVersion, byteLength: segment.byte_length,
        estimatedTokens: segment.estimated_tokens, ...entry.ref.display, ref: entry.ref,
      };
    });
  }

  debugRequest(sessionId: string, requestId: string): BrainDebugRequestDetail | undefined {
    const row = this.db.prepare(
      `SELECT r.*, COALESCE(reset.usage_epoch, 0) AS current_usage_epoch
         FROM brain_provider_requests r
         JOIN brain_sessions s ON s.id = r.session_id
         LEFT JOIN brain_usage_reset_state reset ON reset.user_id = s.user_id
        WHERE r.session_id = ? AND r.request_id = ?`,
    ).get(sessionId, requestId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const refs = this.segmentRefs({ manifest: String(row.manifest), response_segment: row.response_segment as string | null });
    const entries = this.segmentEntries(sessionId, refs);
    return {
      ...this.requestItem(row), canonicalizationVersion: Number(row.canonicalization_version),
      assistantMessageId: row.assistant_message_id === null ? null : String(row.assistant_message_id),
      segments: entries.map(({ ref: _ref, ...entry }) => entry),
      segmentBytes: entries.filter((entry) => entry.section !== 'response').reduce((sum, entry) => sum + entry.byteLength, 0),
    };
  }

  debugSegmentPayloads(sessionId: string, requestId: string, opts: { cursor?: string; limit?: number; maxBytes?: number } = {}): BrainDebugPayloadPage | undefined {
    const row = this.db.prepare('SELECT session_id, manifest, response_segment FROM brain_provider_requests WHERE session_id = ? AND request_id = ?')
      .get(sessionId, requestId) as { session_id: string; manifest: string; response_segment: string | null } | undefined;
    if (!row) return undefined;
    const refs = this.segmentRefs(row);
    const cursor = decodeCursor<{ index: number }>(opts.cursor);
    const start = cursor?.index ?? 0;
    if (!Number.isInteger(start) || start < 0) throw new Error('invalid debug cursor');
    const limit = boundedLimit(opts.limit, 20, 100);
    const maxBytes = boundedLimit(opts.maxBytes, 256 * 1024, 4 * 1024 * 1024);
    const items: BrainDebugPayloadPage['items'] = [];
    let loadedBytes = 0;
    let index = start;
    const entries = this.segmentEntries(sessionId, refs, start, limit);
    for (const entry of entries) {
      if (entry.byteLength > maxBytes - loadedBytes) {
        if (items.length === 0) throw new Error(`debug payload exceeds byte limit:${entry.byteLength}`);
        break;
      }
      const payload = this.segmentPayload(sessionId, entry.ref);
      const { ref: _ref, ...manifestItem } = entry;
      items.push({ ...manifestItem, payload });
      loadedBytes += entry.byteLength;
      index = entry.index + 1;
    }
    return { items, nextCursor: index < refs.length ? encodeCursor({ index }) : null, loadedBytes };
  }

  debugSegmentPayload(sessionId: string, requestId: string, index: number, maxBytes?: number): BrainDebugSegmentPayload | undefined {
    if (!Number.isInteger(index) || index < 0) throw new Error('invalid debug cursor');
    const row = this.db.prepare('SELECT session_id, manifest, response_segment FROM brain_provider_requests WHERE session_id = ? AND request_id = ?')
      .get(sessionId, requestId) as { session_id: string; manifest: string; response_segment: string | null } | undefined;
    if (!row) return undefined;
    const refs = this.segmentRefs(row);
    if (index >= refs.length) return undefined;
    const [entry] = this.segmentEntries(sessionId, refs, index, 1);
    if (!entry) return undefined;
    const cap = boundedLimit(maxBytes, 256 * 1024, 4 * 1024 * 1024);
    if (entry.byteLength > cap) throw new Error(`debug payload exceeds byte limit:${entry.byteLength}`);
    const payload = this.segmentPayload(sessionId, entry.ref);
    const { ref: _ref, ...manifestItem } = entry;
    return { ...manifestItem, payload };
  }

  debugRawPayload(sessionId: string, requestId: string, maxBytes?: number): BrainDebugRawPayload | undefined {
    const row = this.db.prepare('SELECT manifest FROM brain_provider_requests WHERE session_id = ? AND request_id = ?')
      .get(sessionId, requestId) as { manifest: string } | undefined;
    if (!row) return undefined;
    const cap = boundedLimit(maxBytes, 256 * 1024, 4 * 1024 * 1024);
    const refs = this.segmentRefs({ manifest: row.manifest, response_segment: null });
    let segmentBytes = 0;
    for (let start = 0; start < refs.length; start += 100) {
      for (const entry of this.segmentEntries(sessionId, refs, start, 100)) segmentBytes += entry.byteLength;
      if (segmentBytes > cap) throw new Error(`debug payload exceeds byte limit:${segmentBytes}`);
    }
    const payload = this.reconstruct(requestId);
    const byteLength = Buffer.byteLength(canonicalProviderJson(payload));
    if (byteLength > cap) throw new Error(`debug payload exceeds byte limit:${byteLength}`);
    return { payload, byteLength };
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

  resetUsageSummariesForUser(userId: number): void {
    const scope = 'session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)';
    this.db.prepare(
      `UPDATE brain_request_session_summary SET input_tokens = 0, output_tokens = 0, reasoning_tokens = 0,
         cache_read_tokens = 0, cache_write_tokens = 0, total_tokens = 0, cost_usd = 0,
         costed_request_count = 0
       WHERE ${scope}`
    ).run(userId);
  }
}
