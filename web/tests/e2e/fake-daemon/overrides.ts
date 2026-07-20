// Per-test override layer for the fake daemon. The handlers serve canned data from `seed/fixtures.ts`
// by default; a spec can REPLACE any polled GET body (or the seed transcript) BEFORE it navigates, via
// the `seed` fixture → `POST /__test/seed`. Overrides are process-global and MUST be cleared between
// tests (`POST /__test/reset`) so state never leaks across specs. The web is never mocked in the
// browser — the override still travels the real cookie / BFF / fetch pipeline; only the daemon's answer
// changes.
import type { BrainMessage } from '../../../lib/types.ts';

/** Keys a spec may override, mirroring the GET path (no leading slash). Constrained so a typo in a spec
 *  fails the fixture's typecheck instead of silently doing nothing. */
export type OverrideKey =
  | 'config'
  | 'sessions'
  | 'tasks'
  | 'tasks/ready'
  | 'missions'
  | 'projects'
  | 'brain/status'
  | 'brain/sessions'
  | 'brain/models'
  | 'brain/commands';

const responses = new Map<OverrideKey, unknown>();
/** `undefined` = no override (serve the seed transcript); an array (incl. empty) = replace it wholesale. */
let messages: BrainMessage[] | undefined;

export function setResponseOverride(key: OverrideKey, value: unknown): void {
  responses.set(key, value);
}

/** The override for `key` if a spec set one, else `fallback`. The stored value is spec-supplied and
 *  typed against the wire shape on the fixture side, so casting to the fallback's type here is safe. */
export function getResponse<T>(key: OverrideKey, fallback: T): T {
  return responses.has(key) ? (responses.get(key) as T) : fallback;
}

export function setMessagesOverride(items: BrainMessage[] | undefined): void {
  messages = items;
}

export function getMessages(fallback: readonly BrainMessage[]): readonly BrainMessage[] {
  return messages ?? fallback;
}

/** Clear every override — called from `POST /__test/reset` so each test starts from the seed defaults. */
export function resetOverrides(): void {
  responses.clear();
  messages = undefined;
}
