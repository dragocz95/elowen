/** One image attached to an owner-chat turn. The bytes are transient PI input; durable history stores
 * only a human-readable attachment marker. */
export interface TurnImage {
  data: string;
  mimeType: string;
}

export type TurnMode = 'build' | 'plan';

/** Internal turns reuse the normal PI pipeline but do not render an authoritative user echo. */
interface InternalTurn {
  goalKickoff?: boolean;
  goalContinue?: boolean;
  systemNudge?: boolean;
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
  /** Internal admission seam used by BrainService.startSend; never part of REST/SSE payloads. */
  onAdmitted?: (sessionId: string) => void;
}
