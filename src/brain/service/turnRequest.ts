import type { ClientOrigin } from '../../api/clientIp.js';
import type { BrainWorkMode } from '../../shared/wireContract.js';

/** One image attached to an owner-chat turn. The bytes are transient PI input; durable history stores
 * only a human-readable attachment marker. */
export interface TurnImage {
  data: string;
  mimeType: string;
}

/** The daemon's name for the wire contract's {@link BrainWorkMode}: the mode now rides back to clients on
 *  the brain status, so the union is defined once instead of once per side. */
export type TurnMode = BrainWorkMode;

/** The three internal turn kinds: a goal-loop kickoff, a goal-loop continuation, or a system nudge. */
type InternalTurnKind = 'goalKickoff' | 'goalContinue' | 'systemNudge';

/** Internal turns reuse the normal PI pipeline but do not render an authoritative user echo. A single
 *  discriminated `kind` replaces three independent booleans — the three kinds are mutually exclusive, so an
 *  illegal `{ goalKickoff: true, systemNudge: true }` is now unrepresentable. */
export interface InternalTurn {
  kind: InternalTurnKind;
}

/** Stable identity carried by generation-bound CLI requests. Web/channel/internal sends omit it. */
export interface BoundClientRequest {
  id: string;
  generation: number;
}

/** Complete input for one owner-chat turn. Keeping addressing, model-facing text and display text in
 * one object prevents positional argument drift between HTTP, goal, platform and daemon callers. */
export interface TurnRequest {
  userId: number;
  text: string;
  images?: TurnImage[];
  mode?: TurnMode;
  internal?: InternalTurn;
  clientCwd?: string;
  session?: string;
  display?: string;
  client?: BoundClientRequest;
  /** Internal owner-chat seam: the first prompt admitted by interruptQueued while its parent-abort fence
   * is still closed. Never accepted from REST input. */
  interruptResume?: boolean;
  /** Internal admission seam used by BrainService.startSend; never part of REST/SSE payloads. */
  onAdmitted?: (sessionId: string) => void;
  /** Where the request that ordered this turn came from, resolved by the HTTP layer — the only layer
   *  that can see it. Absent means nothing ordered the turn (a goal continuation, a cron wake-up, a
   *  boot-recovered delegation), which settles honestly as `internal` rather than inheriting the last
   *  human address that spoke into the conversation. */
  origin?: ClientOrigin;
  /** Which chat surface the turn was typed on, for the team activity feed. Owner chat is the one place
   *  this cannot be derived — web and CLI post an identical body — so it stays the client's own claim
   *  there and is validated against the known surfaces by the daemon; an internal turn states itself. */
  surface?: string;
}
