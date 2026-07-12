import type { BrainEvent } from './events.js';
import {
  turnsFromHistory,
  type ChatTurn,
  type ElowenTurn,
  type HistoryMessage,
  type SubagentState,
  type ToolItem,
} from './transcript.js';

const TRANSCRIPT_CHANGE_JOURNAL_LIMIT = 4_096;

type TranscriptMutation =
  | { kind: 'reset' }
  | { kind: 'append'; index: number }
  | { kind: 'turn'; index: number }
  | { kind: 'none' };

export type TranscriptChange =
  | { kind: 'full'; revision: number }
  | { kind: 'suffix'; from: number; revision: number }
  | { kind: 'turns'; indices: number[]; revision: number }
  | { kind: 'patch'; from: number; indices: number[]; revision: number }
  | { kind: 'none'; revision: number };

export interface TranscriptModelOptions {
  /** Tests/diagnostics can count actual turn reads without relying on wall-clock timing. */
  onTurnVisit?: (index: number) => void;
  /** Tests may lower the production bound to exercise eviction semantics. */
  journalLimit?: number;
}

/** Minimal revisioned transcript contract consumed by virtualized terminal views. */
export interface TranscriptRead {
  readonly revision: number;
  readonly turnCount: number;
  readonly thinking: boolean;
  readonly activity: 'agent' | 'compaction' | null;
  readonly notice: string | undefined;
  turnAt(index: number): ChatTurn | undefined;
  changesSince(revision: number): TranscriptChange;
}

interface ToolLocation {
  turn: number;
  segment: number;
  item: number;
  source: string;
}

/**
 * Mutable indexed transcript state for terminal clients. The model owns one turn array and replaces at
 * most one turn for a steady BrainEvent. Consumers read the live state directly; no parallel immutable
 * view graph or history-sized shell is created. Durable history replacement is the only intentionally
 * O(history) path.
 */
export class TranscriptModel implements TranscriptRead {
  private readonly turns: ChatTurn[] = [];
  private readonly toolLocations = new Map<string, ToolLocation>();
  private lastToolLocation: ToolLocation | null = null;
  private readonly changes = new Map<number, TranscriptMutation>();
  private readonly journalLimit: number;
  private readonly onTurnVisit?: (index: number) => void;
  private subagentProjection: SubagentState[] = [];
  private readonly subagentIndices = new Map<string, number>();
  private readonly subagentSources = new Map<string, Set<string>>();
  private readonly sourceSessions = new Map<string, string>();
  private lastAssistant = '';
  private thinkingState = false;
  private compactionActive = false;
  private noticeState: string | undefined;
  private currentRevision = 0;

  constructor(history: HistoryMessage[] = [], options: TranscriptModelOptions = {}) {
    const journalLimit = options.journalLimit ?? TRANSCRIPT_CHANGE_JOURNAL_LIMIT;
    if (!Number.isSafeInteger(journalLimit) || journalLimit < 1) {
      throw new Error('TranscriptModel journalLimit must be a positive integer');
    }
    this.journalLimit = journalLimit;
    this.onTurnVisit = options.onTurnVisit;
    this.rebuild(history);
  }

  get revision(): number { return this.currentRevision; }
  get turnCount(): number { return this.turns.length; }
  get thinking(): boolean { return this.thinkingState || this.compactionActive; }
  get activity(): 'agent' | 'compaction' | null {
    return this.compactionActive ? 'compaction' : this.thinkingState ? 'agent' : null;
  }
  get notice(): string | undefined { return this.noticeState; }

  turnAt(index: number): ChatTurn | undefined { return this.visit(index); }
  subagents(): readonly SubagentState[] { return this.subagentProjection; }
  lastAssistantText(): string { return this.lastAssistant; }

  replaceHistory(history: HistoryMessage[]): void {
    this.rebuild(history);
    this.publish({ kind: 'reset' });
  }

  /** Append a terminal-local result which has no daemon BrainEvent representation. */
  appendLocalTurn(turn: ElowenTurn): void {
    const index = this.turns.length;
    this.turns.push(turn);
    this.indexTurn(index, turn, true);
    this.lastAssistant = assistantText(turn);
    this.publish({ kind: 'append', index });
  }

  apply(event: BrainEvent): boolean {
    switch (event.type) {
      case 'text': {
        const { turn, index, fresh } = this.ensureAssistant();
        appendSegmentText(turn, 'text', event.delta);
        this.lastAssistant = (fresh ? '' : this.lastAssistant) + event.delta;
        this.thinkingState = true;
        this.noticeState = undefined;
        this.publish(fresh ? { kind: 'append', index } : { kind: 'turn', index });
        return true;
      }
      case 'reasoning': {
        const { turn, index, fresh } = this.ensureAssistant();
        appendSegmentText(turn, 'reasoning', event.delta);
        this.thinkingState = true;
        this.publish(fresh ? { kind: 'append', index } : { kind: 'turn', index });
        return true;
      }
      case 'notice':
        if (event.kind === 'compaction') this.compactionActive = !event.done;
        this.noticeState = event.done ? undefined : event.message;
        this.publish({ kind: 'none' });
        return true;
      case 'tool': {
        const { turn, index, fresh } = this.ensureAssistant();
        const item: ToolItem = {
          name: event.name,
          detail: event.detail,
          icon: event.icon,
          ...(event.id ? { id: event.id } : {}),
          ...(event.command ? { command: event.command } : {}),
        };
        const tailIndex = turn.segments.length - 1;
        const tail = turn.segments[tailIndex];
        let segmentIndex: number;
        let itemIndex: number;
        if (tail?.kind === 'tools') {
          const items = [...tail.items, item];
          turn.segments[tailIndex] = { kind: 'tools', items };
          segmentIndex = tailIndex;
          itemIndex = items.length - 1;
        } else {
          turn.segments.push({ kind: 'tools', items: [item] });
          segmentIndex = turn.segments.length - 1;
          itemIndex = 0;
        }
        const location = { turn: index, segment: segmentIndex, item: itemIndex, source: toolSource(event.id, index, segmentIndex, itemIndex) };
        this.lastToolLocation = location;
        if (event.id) this.toolLocations.set(event.id, location);
        this.thinkingState = true;
        this.publish(fresh ? { kind: 'append', index } : { kind: 'turn', index });
        return true;
      }
      case 'tool_progress':
        return this.patchToolEvent(event.id, (item) => ({ ...item, progress: event.text }));
      case 'diff':
        return this.patchToolEvent(event.id, ({ progress: _drop, ...item }) => ({
          ...item,
          diff: event.diff,
          ...(event.output ? { output: event.output } : {}),
        }));
      case 'tool_output':
        return this.patchToolEvent(event.id, ({ progress: _drop, ...item }) => ({
          ...item,
          output: item.command && !event.output.command ? { ...event.output, command: item.command } : event.output,
        }));
      case 'subagent': {
        const location = this.toolLocations.get(event.id);
        if (!location) return false;
        const sub: SubagentState = {
          sessionId: event.sessionId,
          status: event.status,
          task: event.task,
          detail: event.detail,
          tools: event.tools,
          tokens: event.tokens,
          seconds: event.seconds,
          model: event.model,
          background: event.background,
          autoDeliver: event.autoDeliver,
        };
        if (!this.patchTool(location, (item) => ({ ...item, sub }))) return false;
        this.upsertSubagent(location.source, sub, true);
        this.publish({ kind: 'turn', index: location.turn });
        return true;
      }
      case 'session':
        this.turns.length = 0;
        this.clearDerived();
        this.lastAssistant = '';
        this.thinkingState = false;
        this.compactionActive = false;
        this.noticeState = undefined;
        this.publish({ kind: 'reset' });
        return true;
      case 'user': {
        const index = this.turns.length;
        this.turns.push({ role: 'you', text: event.text });
        this.lastAssistant = '';
        this.thinkingState = true;
        this.publish({ kind: 'append', index });
        return true;
      }
      case 'idle': {
        const index = this.turns.length - 1;
        const last = index >= 0 ? this.visit(index) : undefined;
        if (last?.role === 'elowen') this.turns[index] = { ...last, streaming: false };
        this.thinkingState = false;
        if (!this.compactionActive) this.noticeState = undefined;
        this.publish(last?.role === 'elowen' ? { kind: 'turn', index } : { kind: 'none' });
        return true;
      }
      case 'error': {
        const { turn, index, fresh } = this.ensureAssistant();
        const text = `\n[error: ${event.message}]`;
        appendSegmentText(turn, 'text', text);
        turn.streaming = false;
        this.lastAssistant = (fresh ? '' : this.lastAssistant) + text;
        this.thinkingState = false;
        this.compactionActive = false;
        this.noticeState = undefined;
        this.publish(fresh ? { kind: 'append', index } : { kind: 'turn', index });
        return true;
      }
      default:
        return false;
    }
  }

  changesSince(revision: number): TranscriptChange {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.currentRevision) {
      return { kind: 'full', revision: this.currentRevision };
    }
    if (revision === this.currentRevision) return { kind: 'none', revision: this.currentRevision };
    const first = this.changes.keys().next().value as number | undefined;
    if (first == null || revision < first - 1) return { kind: 'full', revision: this.currentRevision };

    let suffixFrom = Number.POSITIVE_INFINITY;
    const dirty = new Set<number>();
    for (let cursor = revision + 1; cursor <= this.currentRevision; cursor += 1) {
      const change = this.changes.get(cursor);
      if (!change || change.kind === 'reset') return { kind: 'full', revision: this.currentRevision };
      if (change.kind === 'append') suffixFrom = Math.min(suffixFrom, change.index);
      else if (change.kind === 'turn') dirty.add(change.index);
    }
    const indices = [...dirty].filter((index) => index < suffixFrom).sort((a, b) => a - b);
    if (Number.isFinite(suffixFrom)) {
      return indices.length
        ? { kind: 'patch', from: suffixFrom, indices, revision: this.currentRevision }
        : { kind: 'suffix', from: suffixFrom, revision: this.currentRevision };
    }
    return indices.length
      ? { kind: 'turns', indices, revision: this.currentRevision }
      : { kind: 'none', revision: this.currentRevision };
  }

  private rebuild(history: HistoryMessage[]): void {
    this.turns.length = 0;
    for (const turn of turnsFromHistory(history)) this.turns.push(turn);
    this.clearDerived(true);
    for (let index = 0; index < this.turns.length; index += 1) {
      const turn = this.turns[index]!;
      this.indexTurn(index, turn, false);
    }
    this.lastAssistant = tailAssistantText(this.turns);
    this.freezeSubagents();
    this.thinkingState = false;
    this.compactionActive = false;
    this.noticeState = undefined;
  }

  private clearDerived(mutableProjection = false): void {
    this.toolLocations.clear();
    this.lastToolLocation = null;
    this.subagentProjection = [];
    this.subagentIndices.clear();
    this.subagentSources.clear();
    this.sourceSessions.clear();
    if (!mutableProjection) this.freezeSubagents();
  }

  private indexTurn(turnIndex: number, turn: ChatTurn, cloneProjection: boolean): void {
    if (turn.role !== 'elowen') return;
    for (let segmentIndex = 0; segmentIndex < turn.segments.length; segmentIndex += 1) {
      const segment = turn.segments[segmentIndex]!;
      if (segment.kind !== 'tools') continue;
      for (let itemIndex = 0; itemIndex < segment.items.length; itemIndex += 1) {
        const item = segment.items[itemIndex]!;
        const location: ToolLocation = {
          turn: turnIndex,
          segment: segmentIndex,
          item: itemIndex,
          source: toolSource(item.id, turnIndex, segmentIndex, itemIndex),
        };
        this.lastToolLocation = location;
        if (item.id) this.toolLocations.set(item.id, location);
        if (item.sub) this.upsertSubagent(location.source, item.sub, cloneProjection);
      }
    }
  }

  private ensureAssistant(): { turn: ElowenTurn; index: number; fresh: boolean } {
    const index = this.turns.length - 1;
    const last = index >= 0 ? this.visit(index) : undefined;
    if (last?.role === 'elowen' && last.streaming) {
      const turn: ElowenTurn = { role: 'elowen', segments: [...last.segments], streaming: true };
      this.turns[index] = turn;
      return { turn, index, fresh: false };
    }
    const turn: ElowenTurn = { role: 'elowen', segments: [], streaming: true };
    this.turns.push(turn);
    this.lastAssistant = '';
    return { turn, index: this.turns.length - 1, fresh: true };
  }

  private patchToolEvent(id: string | undefined, patch: (item: ToolItem) => ToolItem): boolean {
    const location = id ? this.toolLocations.get(id) : this.lastToolLocation;
    if (location) {
      if (!this.patchTool(location, patch)) return false;
      this.thinkingState = true;
      this.publish({ kind: 'turn', index: location.turn });
      return true;
    }
    // Preserve the old reducer's handling of malformed lifecycle events: a streaming assistant exists,
    // but no unrelated tool row is patched when an explicit id is unknown.
    const { index, fresh } = this.ensureAssistant();
    this.thinkingState = true;
    this.publish(fresh ? { kind: 'append', index } : { kind: 'turn', index });
    return true;
  }

  private patchTool(location: ToolLocation, patch: (item: ToolItem) => ToolItem): boolean {
    const turn = this.visit(location.turn);
    if (turn?.role !== 'elowen') return false;
    const segment = turn.segments[location.segment];
    if (segment?.kind !== 'tools' || !segment.items[location.item]) return false;
    const items = segment.items.slice();
    items[location.item] = patch(items[location.item]!);
    const segments = turn.segments.slice();
    segments[location.segment] = { kind: 'tools', items };
    this.turns[location.turn] = { ...turn, segments };
    return true;
  }

  private upsertSubagent(source: string, sub: SubagentState, clone: boolean): void {
    const oldSession = this.sourceSessions.get(source);
    if (oldSession && oldSession !== sub.sessionId) this.removeSubagentSource(source, oldSession, clone);
    this.sourceSessions.set(source, sub.sessionId);
    const sources = this.subagentSources.get(sub.sessionId) ?? new Set<string>();
    sources.add(source);
    this.subagentSources.set(sub.sessionId, sources);
    const projected = Object.freeze({ ...sub });

    const index = this.subagentIndices.get(sub.sessionId);
    if (clone) this.subagentProjection = this.subagentProjection.slice();
    if (index == null) {
      this.subagentIndices.set(sub.sessionId, this.subagentProjection.length);
      this.subagentProjection.push(projected);
    } else {
      this.subagentProjection[index] = projected;
    }
    if (clone) this.freezeSubagents();
  }

  private removeSubagentSource(source: string, sessionId: string, clone: boolean): void {
    this.sourceSessions.delete(source);
    const sources = this.subagentSources.get(sessionId);
    sources?.delete(source);
    if (sources?.size) return;
    this.subagentSources.delete(sessionId);
    const index = this.subagentIndices.get(sessionId);
    if (index == null) return;
    if (clone) this.subagentProjection = this.subagentProjection.slice();
    this.subagentProjection.splice(index, 1);
    this.subagentIndices.clear();
    for (let i = 0; i < this.subagentProjection.length; i += 1) {
      this.subagentIndices.set(this.subagentProjection[i]!.sessionId, i);
    }
  }

  private visit(index: number): ChatTurn | undefined {
    this.onTurnVisit?.(index);
    return this.turns[index];
  }

  private freezeSubagents(): void {
    Object.freeze(this.subagentProjection);
  }

  private publish(change: TranscriptMutation): void {
    this.currentRevision += 1;
    this.changes.set(this.currentRevision, change);
    while (this.changes.size > this.journalLimit) {
      const oldest = this.changes.keys().next().value as number | undefined;
      if (oldest == null) break;
      this.changes.delete(oldest);
    }
  }
}

function toolSource(id: string | undefined, turn: number, segment: number, item: number): string {
  return id ? `id:${id}` : `at:${turn}:${segment}:${item}`;
}

function assistantText(turn: ElowenTurn): string {
  return turn.segments
    .filter((segment): segment is Extract<typeof segment, { kind: 'text' }> => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('');
}

function tailAssistantText(turns: ChatTurn[]): string {
  const tail = turns[turns.length - 1];
  return tail?.role === 'elowen' ? assistantText(tail) : '';
}

function appendSegmentText(turn: ElowenTurn, kind: 'text' | 'reasoning', delta: string): void {
  const index = turn.segments.length - 1;
  const tail = turn.segments[index];
  if (tail?.kind === kind) turn.segments[index] = { kind, text: tail.text + delta };
  else turn.segments.push({ kind, text: delta });
}
