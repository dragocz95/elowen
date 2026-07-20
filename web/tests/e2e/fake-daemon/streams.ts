// Registry of the currently-open `GET /brain/stream` SSE connections, so the out-of-band control
// channel (`POST /__test/emit` etc.) can push scripted BrainEvent frames into a specific open stream.
// A stream is keyed by the `client` + `session` query params the web sends when it opens its EventSource.
import type { BrainEvent } from './emitters.ts';

export interface OpenStream {
  readonly id: number;
  readonly client?: string;
  readonly session?: string;
  /** The `generation` query param the web opened its EventSource with — the daemon delivers a client only
   *  the frames of the generation it is attached at. Modeled so a spec can prove a STALE-generation frame
   *  (a superseded run's late output) is dropped server-side and never reaches the live client. */
  readonly generation?: string;
  /** Serialize a BrainEvent as an SSE frame (`event: <type>`, `data: <json>`) into this connection. */
  write(event: BrainEvent): Promise<void>;
}

const open = new Set<OpenStream>();
let seq = 0;

/** How the control channel addresses streams: match on whichever of client/session/generation is provided.
 *  When ALL are omitted every open stream matches (broadcast) — handy for a single-stream test. Supplying
 *  `generation` scopes delivery to streams opened at that generation (the daemon's stale-frame fence). */
export interface StreamTarget {
  client?: string;
  session?: string;
  generation?: string;
}

export function registerStream(s: Omit<OpenStream, 'id'>): OpenStream {
  const stream: OpenStream = { id: ++seq, ...s };
  open.add(stream);
  return stream;
}

export function unregisterStream(stream: OpenStream): void {
  open.delete(stream);
}

/** Snapshot of the currently-open streams — lets the control channel report readiness so a spec can wait
 *  for the browser's EventSource to actually register before it emits (the emit is fire-and-forget: a
 *  frame pushed before the stream connects is lost). */
export function openStreams(): OpenStream[] {
  return [...open];
}

export function matchStreams(target: StreamTarget): OpenStream[] {
  const streams = [...open];
  if (target.client === undefined && target.session === undefined && target.generation === undefined) return streams;
  return streams.filter(
    (s) =>
      (target.client === undefined || s.client === target.client) &&
      (target.session === undefined || s.session === target.session) &&
      (target.generation === undefined || s.generation === target.generation),
  );
}

/** Push one event to every stream matching the target; returns how many connections received it. */
export async function emitToStreams(target: StreamTarget, event: BrainEvent): Promise<number> {
  const matched = matchStreams(target);
  await Promise.all(matched.map((s) => s.write(event)));
  return matched.length;
}
