import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { planFilePath } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';

/** Upper bound on a plan, applied on READ because that is the only chokepoint every consumer shares.
 *  The plan is re-injected VERBATIM into the prompt after a compaction, so an unbounded document would
 *  trade one context problem for another — a 200 KB "plan" would blow the budget the compaction just
 *  reclaimed, and the same string also rides the tool result out to the client.
 *
 *  Capping the WRITE would not hold: the file is written by the model through the clamped Write/Edit
 *  tools, and the user is invited to edit it by hand. Neither goes through this module, so read is the
 *  only place a bound can actually be enforced. Generous enough for a decision-complete plan; anything
 *  past it is being used as something other than a plan. */
export const PLAN_MAX_CHARS = 16_000;

/** Create the plans directory if it is missing, and report whether it is usable.
 *
 *  Called lazily, every time a plan-mode turn mints the path for its prompt, rather than once at
 *  startup. Startup is the wrong moment for two reasons: an existing install that UPDATES into this
 *  feature would not get the directory until the daemon happened to restart, and a directory created
 *  once can be deleted afterwards. `mkdirSync` with `recursive` is idempotent and cheap, so paying it
 *  per plan turn buys a guarantee that holds no matter how the instance got here.
 *
 *  It is what makes the path the model is told to write to usable no matter which tool it reaches for:
 *  `mkdir -p` is denied by the non-destructive shell clamp, and Write is confined to the plan path
 *  itself. Write creates its own parent tree now, so this is belt and braces rather than the only
 *  thing standing between the model and an ENOENT it could not fix — and it still guarantees the
 *  directory exists for readPlan on a turn that never wrote anything. */
export function ensurePlanDir(sessionId: string): boolean {
  try {
    mkdirSync(dirname(planFilePath(process.env, sessionId)), { recursive: true });
    return true;
  } catch (e) {
    logger('continuity').warn('failed to create the plans directory', e);
    return false;
  }
}

/** The conversation's active plan, or undefined when none was written (the common case) or the file is
 *  unreadable. A missing plan must read as "no plan", never as an error: every caller is assembling a
 *  prompt, and a throw there would cost the turn far more than the missing orientation. */
export function readPlan(sessionId: string): string | undefined {
  try {
    const body = readFileSync(planFilePath(process.env, sessionId), 'utf8').trim();
    return body ? body.slice(0, PLAN_MAX_CHARS) : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger('continuity').warn(`failed to read plan for ${sessionId}`, e);
    }
    return undefined;
  }
}
