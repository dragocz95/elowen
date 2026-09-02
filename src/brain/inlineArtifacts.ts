import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  BrainInlineArtifact,
  BrainInlineArtifactClosed,
  PluginChatArtifact,
  PluginChatArtifactData,
  PluginChatArtifactLiveMedia,
  PluginChatArtifactUpdate,
} from './events.js';
import type { PluginChatArtifactRef } from '../plugins/api.js';

const MAX_ARTIFACT_ID = 128;
const MAX_TOOL_CALL_ID = 128;
const MAX_VIEW = 64;
const MAX_FALLBACK = 2_000;
const MAX_MEDIA_PATH = 512;
const MAX_DATA_DEPTH = 8;
const MAX_DATA_NODES = 1_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_KEY_LENGTH = 128;
const MAX_STRING_LENGTH = 4_096;
const MAX_DATA_BYTES = 32 * 1024;
const MAX_TIMER_DELAY = 2_147_483_647;
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_VIEW = /^[a-z0-9][a-z0-9-]*$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface StoredInlineArtifact {
  artifact: BrainInlineArtifact;
  tokenHash: string;
  expiresAtMs: number;
}

/** The durable artifact seam. BrainStore owns the SQLite implementation; the registry owns validation,
 * reference authorization, expiry and live publication. */
export interface InlineArtifactStore {
  getSession(sessionId: string): unknown;
  insertInlineArtifact(row: StoredInlineArtifact): void;
  updateInlineArtifact(row: StoredInlineArtifact): void;
  getInlineArtifactCandidates(refSessionId: string, plugin: string, artifactId: string): StoredInlineArtifact[];
  getInlineArtifacts(sessionId: string): BrainInlineArtifact[];
  deleteInlineArtifact(sessionId: string, plugin: string, artifactId: string): boolean;
  deleteInlineArtifactsForSession(sessionId: string): BrainInlineArtifact[];
  takeExpiredInlineArtifacts(now: number): BrainInlineArtifact[];
  nextInlineArtifactExpiry(): number | undefined;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const clean = value.trim();
  if (!clean) throw new Error(`${field} cannot be empty`);
  if (clean.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return clean;
}

function artifactId(value: unknown): string {
  const clean = boundedString(value, 'artifact id', MAX_ARTIFACT_ID);
  if (!SAFE_ARTIFACT_ID.test(clean)) throw new Error('artifact id contains unsupported characters');
  return clean;
}

function toolCallId(value: unknown): string {
  return boundedString(value, 'toolCallId', MAX_TOOL_CALL_ID);
}

function viewName(value: unknown): string {
  const clean = boundedString(value, 'artifact view', MAX_VIEW);
  if (!SAFE_VIEW.test(clean)) throw new Error('artifact view must be lowercase kebab-case');
  return clean;
}

function fallbackText(value: unknown): string {
  return boundedString(value, 'artifact fallback', MAX_FALLBACK);
}

function expiry(value: unknown, now: number): { iso: string; ms: number } {
  if (typeof value !== 'string') throw new Error('expiresAt must be an ISO date string');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('expiresAt must be a valid ISO date string');
  if (ms <= now) throw new Error('expiresAt must be in the future');
  return { iso: new Date(ms).toISOString(), ms };
}

function mediaDescriptor(plugin: string, value: unknown): PluginChatArtifactLiveMedia {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('artifact media must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.transport !== 'sse') throw new Error('artifact media transport must be sse');
  const path = boundedString(raw.path, 'artifact media path', MAX_MEDIA_PATH);
  const prefix = `/plugins/${plugin}/api/`;
  if (!path.startsWith(prefix) || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`artifact media path must target ${prefix}`);
  }
  let parsed: URL;
  try { parsed = new URL(path, 'http://elowen.invalid'); }
  catch { throw new Error('artifact media path is invalid'); }
  if (parsed.origin !== 'http://elowen.invalid' || !parsed.pathname.startsWith(prefix)) {
    throw new Error(`artifact media path must target ${prefix}`);
  }
  const decoded = decodeURIComponent(parsed.pathname);
  if (decoded.includes('\\') || decoded.split('/').some((segment) => segment === '..')) {
    throw new Error('artifact media path contains unsafe traversal');
  }
  return { transport: 'sse', path };
}

interface JsonBudget { nodes: number }

function normalizeJson(value: unknown, depth: number, budget: JsonBudget): PluginChatArtifactData {
  budget.nodes += 1;
  if (budget.nodes > MAX_DATA_NODES) throw new Error(`artifact data exceeds ${MAX_DATA_NODES} values`);
  if (depth > MAX_DATA_DEPTH) throw new Error(`artifact data exceeds depth ${MAX_DATA_DEPTH}`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('artifact data contains a non-finite number');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw new Error(`artifact data string exceeds ${MAX_STRING_LENGTH} characters`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new Error(`artifact data array exceeds ${MAX_ARRAY_ITEMS} items`);
    return value.map((item) => normalizeJson(item, depth + 1, budget));
  }
  if (!value || typeof value !== 'object') throw new Error('artifact data must contain only JSON values');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('artifact data contains a non-plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) throw new Error('artifact data contains a symbol key');
  if (keys.length > MAX_OBJECT_KEYS) throw new Error(`artifact data object exceeds ${MAX_OBJECT_KEYS} keys`);
  const output: Record<string, PluginChatArtifactData> = {};
  for (const key of keys as string[]) {
    if (!key || key.length > MAX_KEY_LENGTH) throw new Error(`artifact data key exceeds ${MAX_KEY_LENGTH} characters`);
    if (UNSAFE_KEYS.has(key)) throw new Error(`artifact data contains unsafe key "${key}"`);
    const descriptor = descriptors[key]!;
    if (!('value' in descriptor)) throw new Error('artifact data contains an accessor property');
    output[key] = normalizeJson(descriptor.value, depth + 1, budget);
  }
  return output;
}

function artifactData(value: unknown): PluginChatArtifactData {
  const normalized = normalizeJson(value, 0, { nodes: 0 });
  const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (bytes > MAX_DATA_BYTES) throw new Error(`artifact data exceeds ${MAX_DATA_BYTES} bytes`);
  return normalized;
}

function normalizeOpen(plugin: string, sessionId: string, rawToolCallId: unknown, raw: PluginChatArtifact, now: number): {
  artifact: BrainInlineArtifact;
  expiresAtMs: number;
} {
  if (!raw || typeof raw !== 'object') throw new Error('artifact must be an object');
  const id = artifactId(raw.id);
  const callId = toolCallId(rawToolCallId);
  const expires = expiry(raw.expiresAt, now);
  const createdAt = new Date(now).toISOString();
  const artifact: BrainInlineArtifact = {
    id,
    plugin,
    sessionId,
    toolCallId: callId,
    view: viewName(raw.view),
    fallback: fallbackText(raw.fallback),
    status: 'open',
    expiresAt: expires.iso,
    createdAt,
    updatedAt: createdAt,
    ...(raw.data !== undefined ? { data: artifactData(raw.data) } : {}),
    ...(raw.media !== undefined ? { media: mediaDescriptor(plugin, raw.media) } : {}),
  };
  return { artifact, expiresAtMs: expires.ms };
}

function applyUpdate(plugin: string, current: BrainInlineArtifact, raw: PluginChatArtifactUpdate, now: number): {
  artifact: BrainInlineArtifact;
  expiresAtMs: number;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('artifact update must be an object');
  const keys = Object.keys(raw);
  if (!keys.some((key) => ['view', 'fallback', 'data', 'media', 'expiresAt'].includes(key))) {
    throw new Error('artifact update contains no changes');
  }
  const expires = raw.expiresAt === undefined
    ? { iso: current.expiresAt, ms: Date.parse(current.expiresAt) }
    : expiry(raw.expiresAt, now);
  const artifact: BrainInlineArtifact = {
    ...current,
    ...(raw.view !== undefined ? { view: viewName(raw.view) } : {}),
    ...(raw.fallback !== undefined ? { fallback: fallbackText(raw.fallback) } : {}),
    ...(raw.data !== undefined ? { data: artifactData(raw.data) } : {}),
    ...(raw.media === null ? { media: undefined } : raw.media !== undefined ? { media: mediaDescriptor(plugin, raw.media) } : {}),
    expiresAt: expires.iso,
    updatedAt: new Date(now).toISOString(),
  };
  if (artifact.media === undefined) delete artifact.media;
  return { artifact, expiresAtMs: expires.ms };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token: unknown, expected: string): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const actual = Buffer.from(tokenHash(token), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function closedArtifact(artifact: BrainInlineArtifact, reason: BrainInlineArtifactClosed['reason']): BrainInlineArtifactClosed {
  return {
    id: artifact.id,
    plugin: artifact.plugin,
    sessionId: artifact.sessionId,
    toolCallId: artifact.toolCallId,
    status: 'closed',
    reason,
  };
}

/** Core-owned lifecycle for inline plugin artifacts. Plugins receive only serializable refs; every mutation
 * re-authorizes the ref against the host-stamped plugin, session, artifact id and token hash. */
export class InlineArtifactRegistry {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: () => InlineArtifactStore,
    private readonly publish: (sessionId: string, artifact: BrainInlineArtifact | BrainInlineArtifactClosed) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  reconcile(): void {
    this.sweepAndSchedule();
  }

  open(plugin: string, sessionId: string, callId: string, raw: PluginChatArtifact): PluginChatArtifactRef {
    const store = this.store();
    if (!store.getSession(sessionId)) throw new Error('inline artifacts require an active stored conversation');
    this.expireDue();
    const normalized = normalizeOpen(plugin, sessionId, callId, raw, this.now());
    const token = randomBytes(32).toString('base64url');
    store.insertInlineArtifact({ ...normalized, tokenHash: tokenHash(token) });
    this.publish(sessionId, normalized.artifact);
    this.scheduleNext();
    return { version: 1, sessionId, artifactId: normalized.artifact.id, token };
  }

  update(plugin: string, ref: PluginChatArtifactRef, raw: PluginChatArtifactUpdate): BrainInlineArtifact {
    this.expireDue();
    const row = this.authorize(plugin, ref);
    const normalized = applyUpdate(plugin, row.artifact, raw, this.now());
    this.store().updateInlineArtifact({ ...normalized, tokenHash: row.tokenHash });
    this.publish(row.artifact.sessionId, normalized.artifact);
    this.scheduleNext();
    return normalized.artifact;
  }

  close(plugin: string, ref: PluginChatArtifactRef): void {
    this.expireDue();
    const row = this.authorize(plugin, ref);
    if (!this.store().deleteInlineArtifact(row.artifact.sessionId, plugin, row.artifact.id)) {
      throw new Error('invalid inline artifact reference');
    }
    this.publish(row.artifact.sessionId, closedArtifact(row.artifact, 'closed'));
    this.scheduleNext();
  }

  forSession(sessionId: string): BrainInlineArtifact[] {
    this.expireDue();
    return this.store().getInlineArtifacts(sessionId);
  }

  closeSession(sessionId: string): void {
    this.expireDue();
    for (const artifact of this.store().deleteInlineArtifactsForSession(sessionId)) {
      this.publish(sessionId, closedArtifact(artifact, 'closed'));
    }
    this.scheduleNext();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private authorize(plugin: string, ref: PluginChatArtifactRef): StoredInlineArtifact {
    if (!ref || ref.version !== 1 || typeof ref.sessionId !== 'string' || typeof ref.artifactId !== 'string') {
      throw new Error('invalid inline artifact reference');
    }
    const row = this.store().getInlineArtifactCandidates(ref.sessionId, plugin, ref.artifactId)
      .find((candidate) => tokenMatches(ref.token, candidate.tokenHash));
    if (!row) throw new Error('invalid inline artifact reference');
    return row;
  }

  private expireDue(): void {
    for (const artifact of this.store().takeExpiredInlineArtifacts(this.now())) {
      this.publish(artifact.sessionId, closedArtifact(artifact, 'expired'));
    }
  }

  private sweepAndSchedule(): void {
    this.timer = undefined;
    this.expireDue();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.store().nextInlineArtifactExpiry();
    if (next === undefined) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY, next - this.now()));
    this.timer = setTimeout(() => this.sweepAndSchedule(), delay);
    this.timer.unref?.();
  }
}
