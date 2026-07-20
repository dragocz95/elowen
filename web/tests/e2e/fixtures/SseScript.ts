// A scripted live-stream driver: pushes specific `BrainEvent` frames into the chat's OPEN
// `GET /brain/stream` connection via the fake daemon's out-of-band control channel
// (`POST /__test/emit` + `POST /__test/idle`). Every method maps 1:1 to a variant of the
// `src/brain/events.ts` union, and its payload type is DERIVED from that union — so a renamed or
// reshaped event breaks this file's typecheck, never a stale copy. This is the ONLY faked piece: the
// frame still crosses the real EventSource → BFF → transcript-reducer pipeline in the browser.
import type { APIRequestContext } from '@playwright/test';
import type { BrainEvent } from '../../../../src/brain/events.ts';
import { DEFAULT_SESSION_ID } from '../seed/fixtures.ts';
import { DAEMON_URL } from './env.ts';

/** One variant of the wire union, minus its `type` tag — the shape a helper takes as its options. */
type EventOf<T extends BrainEvent['type']> = Extract<BrainEvent, { type: T }>;
type PayloadOf<T extends BrainEvent['type']> = Omit<EventOf<T>, 'type'>;

/** Which open stream(s) a frame targets. The chat opens its EventSource with the bound session + a
 *  per-tab random `client` uuid the test cannot know ahead of time — so addressing defaults to the
 *  session (the single open chat stream). Omit both to broadcast to every open stream. */
export interface StreamTarget {
  session?: string;
  client?: string;
  /** The EventSource `generation` the frame is minted for. When set, the fake daemon delivers it ONLY to
   *  streams opened at that generation — modeling the daemon's stale-frame fence (a superseded run's late
   *  output never reaches a client attached at a newer generation). */
  generation?: string;
}

export class SseScript {
  constructor(
    private readonly request: APIRequestContext,
    /** Default addressing for every emit; a spec can override per call. Defaults to the chat's session. */
    private readonly target: StreamTarget = { session: DEFAULT_SESSION_ID },
  ) {}

  /** Re-address a follow-up script (e.g. after a session rollover) without a new fixture. */
  to(target: StreamTarget): SseScript {
    return new SseScript(this.request, target);
  }

  /** Push one arbitrary event into the matching stream(s); resolves to how many connections got it. */
  async emit(event: BrainEvent, target: StreamTarget = this.target): Promise<number> {
    const res = await this.request.post(`${DAEMON_URL}/__test/emit`, { data: { ...target, event } });
    const body = (await res.json()) as { delivered: number };
    return body.delivered;
  }

  // --- One method per turn-affecting variant, payloads derived from the union. ---

  /** A single streamed answer-text delta. */
  text(delta: string): Promise<number> {
    return this.emit({ type: 'text', delta });
  }

  /** Stream a whole answer as a realistic run of `text` deltas (word-by-word), in order. */
  async deltas(full: string): Promise<void> {
    for (const chunk of full.match(/\S+\s*|\s+/g) ?? []) await this.text(chunk);
  }

  /** A reasoning/thinking delta (extended-thinking models). */
  reasoning(delta: string): Promise<number> {
    return this.emit({ type: 'reasoning', delta });
  }

  /** A tool call starting — renders the tool pill (`name`, optional `detail`/`icon`/`id`/`command`). */
  tool(payload: PayloadOf<'tool'>): Promise<number> {
    return this.emit({ type: 'tool', ...payload });
  }

  /** A tool's live rolling output tail (the `Bash` progress stream), attached to its pill by `id`. */
  toolProgress(id: string, text: string): Promise<number> {
    return this.emit({ type: 'tool_progress', id, text });
  }

  /** A tool's completed output block, attached to its pill by `id`. */
  toolOutput(output: EventOf<'tool_output'>['output'], id?: string): Promise<number> {
    return this.emit({ type: 'tool_output', output, ...(id !== undefined ? { id } : {}) });
  }

  /** A tool finished with no displayable block (closes status-only renderers). */
  toolEnd(opts: PayloadOf<'tool_end'> = {}): Promise<number> {
    return this.emit({ type: 'tool_end', ...opts });
  }

  /** An edit's unified diff, attached to its pill by `id`; `output` carries optional hook notes. */
  diff(diff: string, opts: Omit<PayloadOf<'diff'>, 'diff'> = {}): Promise<number> {
    return this.emit({ type: 'diff', diff, ...opts });
  }

  /** A transient runtime notice (retry / compaction); `done` clears it. */
  notice(kind: EventOf<'notice'>['kind'], message: string, done?: boolean): Promise<number> {
    return this.emit({ type: 'notice', kind, message, ...(done !== undefined ? { done } : {}) });
  }

  /** A display-only session-state marker (model / mode / rename / reasoning / cwd change). */
  sessionEvent(
    kind: EventOf<'session-event'>['kind'],
    detail: string,
    opts: { id?: string; at?: string } = {},
  ): Promise<number> {
    return this.emit({
      type: 'session-event',
      id: opts.id ?? `se-${Date.now()}`,
      kind,
      detail,
      at: opts.at ?? new Date().toISOString(),
    });
  }

  /** A server-rendered user echo (the daemon's authority for the 'you' turn). */
  user(text: string): Promise<number> {
    return this.emit({ type: 'user', text });
  }

  /** A brain error frame (the server closes the stream after it, like the real daemon). */
  error(message: string): Promise<number> {
    return this.emit({ type: 'error', message });
  }

  /** End the turn with the terminal `idle` frame (optionally refreshing usage / model). Routed through
   *  the dedicated `/__test/idle` control endpoint. Resolves to how many streams received it. */
  async idle(opts: { usage?: EventOf<'idle'>['usage']; model?: string } = {}, target: StreamTarget = this.target): Promise<number> {
    const res = await this.request.post(`${DAEMON_URL}/__test/idle`, { data: { ...target, ...opts } });
    const body = (await res.json()) as { delivered: number };
    return body.delivered;
  }
}
