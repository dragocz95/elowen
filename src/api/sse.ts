import { logger } from '../shared/logger.js';
import { PLATFORM_SURFACES } from '../shared/platformIdentity.js';

const log = logger('sse');

/** WHERE a turn came from. The channel platforms are derivable from the session id, but web and CLI
 *  are NOT: both POST /brain/send with the same shape, so the caller has to say which it is. Never
 *  inferred from User-Agent or IP — the client writes both, and the web BFF strips headers anyway.
 *  An unattributable turn stays 'unknown' rather than being guessed into a plausible lie.
 *  The platforms come from the identity descriptors; the rest are surfaces with no platform identity. */
export const ACTIVITY_SURFACES = ['web', 'cli', ...PLATFORM_SURFACES, 'cron', 'internal', 'unknown'] as const;
export type ActivitySurface = (typeof ACTIVITY_SURFACES)[number];

/** What happened, in the vocabulary the team feed renders (each kind owns an icon in web/lib/eventMeta).
 *  The array is the single source of truth: it is what a persisted row is matched against to decide
 *  whether it belongs to the instance-wide feed, so adding a kind here is all it takes.
 *
 *  Deliberately just one kind for now. A kind nobody emits is dead vocabulary that reads like a feature:
 *  daemon restarts and turn failures are worth showing, but neither has a call site that knows the actor
 *  and surface today, and inventing one would put a guess in an attribution feed. */
export const ACTIVITY_KINDS = ['turn'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ElowenEvent =
  // The team activity feed ("Dění"). Carries the actor as an ID ONLY: the display name is resolved by
  // JOIN at read time, so a later rename is reflected throughout the history.
  | { type: 'activity'; kind: ActivityKind; actorUserId: number | null; surface: ActivitySurface; target: string }
  // A recall delivered memories to the model, so their usage counters and vitality just moved. Carries no
  // memory content and no ids — only whose view is now stale.
  | { type: 'memory'; userId: number }
  // Authentication audit events are instance-wide. `subject` is the external identity audit key; `label`
  // names the resolved account when one exists.
  | { type: 'auth'; kind: 'sso.login' | 'sso.provision' | 'sso.link' | 'sso.denied'; subject: string; detail: string; label?: string }
  // Plugin tenancy is explicit: null is admin-only, a project id is project-scoped.
  | { type: 'plugin'; plugin: string; kind: string; projectId: number | null; data: unknown }
  // The live plugin registry was swapped; clients refetch the listings they already read.
  | { type: 'plugins' };

export class EventBus {
  private subs = new Set<(e: ElowenEvent) => void>();
  subscribe(fn: (e: ElowenEvent) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  /** Isolate subscribers: a throwing/closed subscriber (e.g. a torn-down SSE stream) must not abort
   *  the broadcast to the rest — otherwise one dead client silences live events for everyone. */
  publish(e: ElowenEvent): void {
    for (const fn of this.subs) {
      try { fn(e); } catch (err) { log.error('event subscriber threw', err); }
    }
  }
}
