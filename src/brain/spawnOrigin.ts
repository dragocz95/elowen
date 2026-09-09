import type { ClientOrigin } from '../api/clientIp.js';

/** The origin of the request that ORDERED a delegation, carried to the child so its own turns are billed
 *  to the person and address that asked for the work.
 *
 *  A delegated child has no request of its own: nobody types into it, and `settleTurn` therefore reads it
 *  as `internal` — which is how sub-agent spend came to sit in the "internal" bucket instead of under the
 *  colleague whose question spawned it. The parent's pin is the answer, and it has to travel, because a
 *  child may run in the forked sub-agent runner (a second process with its own, empty pin map) and may
 *  take further turns after a daemon restart. So it goes two ways: with the delegated turn request over
 *  IPC (the child's FIRST turn, before its session row exists), and on the child's session row
 *  (`spawn_origin`) for every later turn — a continuation, a drain, a boot-recovery respawn.
 *
 *  It is NOT part of `DelegatedExecutionScope`: that scope is the security boundary and is re-validated
 *  on every respawn. This value grants nothing; it only says who to bill. */
export interface SpawnOrigin {
  value: string;
  kind: ClientOrigin['kind'];
  trusted: boolean;
  /** The ACCOUNT that ordered the delegation. In a shared room that is the writer, not the row owner. */
  userId: number;
}

const KINDS = new Set<ClientOrigin['kind']>(['ip', 'local', 'internal', 'platform']);

/** Validate a spawn origin that arrived over IPC or came back out of SQLite. Anything malformed is
 *  `undefined`, i.e. the child settles as `internal` — the same honest answer a turn nobody ordered gets.
 *  Attribution must never be the reason a delegated turn is refused. */
export function parseSpawnOrigin(raw: unknown): SpawnOrigin | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.value !== 'string' || !v.value) return undefined;
  if (typeof v.kind !== 'string' || !KINDS.has(v.kind as ClientOrigin['kind'])) return undefined;
  if (typeof v.trusted !== 'boolean') return undefined;
  if (!Number.isSafeInteger(v.userId) || (v.userId as number) <= 0) return undefined;
  return { value: v.value, kind: v.kind as ClientOrigin['kind'], trusted: v.trusted, userId: v.userId as number };
}

/** The pin a spawn origin turns back into for `openTurn`. */
export function clientOriginOf(origin: SpawnOrigin): ClientOrigin {
  return { value: origin.value, kind: origin.kind, trusted: origin.trusted };
}

/** The origin of the turn currently running in `sessionId`, as a delegation can carry it. Undefined when
 *  that turn holds no pin — a cron wake-up, a boot-recovered conversation, anything with no request
 *  behind it — and the child then settles as `internal` exactly like its parent does. */
export function spawnOriginOfTurn(
  pin: { pinnedFor(sessionId: string): { origin: ClientOrigin; userId: number } | null },
  sessionId: string,
): SpawnOrigin | undefined {
  const pinned = pin.pinnedFor(sessionId);
  if (!pinned) return undefined;
  return { value: pinned.origin.value, kind: pinned.origin.kind, trusted: pinned.origin.trusted, userId: pinned.userId };
}
