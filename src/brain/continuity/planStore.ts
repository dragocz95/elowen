import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { planFilePath } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';
import {
  guestPlanPath,
  isManagedProjectTurn,
  readGuestFileBounded,
  resolveManagedArtifactTurn,
  statGuestFile,
  writeGuestFile,
  type ResolvedManagedTurn,
  type SandboxResolver,
} from '../managedArtifacts.js';

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
 *  prompt, and a throw there would cost the turn far more than the missing orientation.
 *
 *  Reads the CENTRAL plans directory only. It is sync on purpose: every host-project caller — and the
 *  store's blanking sweep — wants a pure file read, and the managed-project read-back (which needs the
 *  async provider) goes through {@link readPlanForTurn} instead. */
export function readPlan(sessionId: string): string | undefined {
  return readPlanBounded(sessionId);
}

/** Hard allocation cap for one central plan read. A plan is bounded to {@link PLAN_MAX_CHARS}
 *  CHARACTERS afterwards, and 16 000 UTF-8 characters occupy at most four times that many BYTES, so
 *  reading the first quarter megabyte with a stop-at-enough-chars loop produces the same string the
 *  historical whole-file read produced — without ever allocating the file's full size. The only input
 *  that can walk past the cap is megabytes of leading whitespace, which stays bounded (a truncated
 *  whitespace run is indistinguishable after the trim) rather than becoming an unbounded allocation. */
const PLAN_READ_BOUND_BYTES = 256 * 1024;
const PLAN_READ_CHUNK = 64 * 1024;

function readPlanBounded(sessionId: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(planFilePath(process.env, sessionId), 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger('continuity').warn(`failed to read plan for ${sessionId}`, e);
    }
    return undefined;
  }
  try {
    const decoder = new TextDecoder('utf8', { fatal: false });
    const buffer = Buffer.allocUnsafe(PLAN_READ_CHUNK);
    let consumed = 0;
    let text = '';
    for (;;) {
      const want = Math.min(PLAN_READ_CHUNK, PLAN_READ_BOUND_BYTES - consumed);
      if (want <= 0) break;
      const read = readSync(fd, buffer, 0, want, consumed);
      if (read <= 0) break;
      consumed += read;
      text += decoder.decode(buffer.subarray(0, read), { stream: true });
      // The first 16000 trimmed characters sit within the first 4×16000 bytes of non-whitespace
      // content; once the decoded text already trims past that, more bytes cannot change the slice.
      if (text.trim().length >= PLAN_MAX_CHARS) break;
    }
    text += decoder.decode();
    const body = text.trim();
    return body ? body.slice(0, PLAN_MAX_CHARS) : undefined;
  } catch (e) {
    logger('continuity').warn(`failed to read plan for ${sessionId}`, e);
    return undefined;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Persist a plan into the CENTRAL plans directory — the write-back the managed flow earns at
 *  `ExitPlanMode`: the model authored the document in the guest (the only writable path a managed
 *  planning turn has), and the central file is the durable store every non-managed continuation, the
 *  user's own editor and the lifecycle sweeps read. Host-side, bounded by the same read bound the plan
 *  was read with, and idempotent like every other write of the same document. */
export function writePlan(sessionId: string, body: string): boolean {
  if (typeof body !== 'string' || !body.trim()) return false;
  ensurePlanDir(sessionId);
  try {
    writeFileSync(planFilePath(process.env, sessionId), body.slice(0, PLAN_MAX_CHARS), 'utf8');
    return true;
  } catch (e) {
    logger('continuity').warn(`failed to write plan for ${sessionId}`, e);
    return false;
  }
}

/** The plan the CURRENT turn should present, read through the branch the turn's execution target
 *  decides:
 *  - a managed-project turn reads the GUEST copy through the provider — that is where a managed session
 *    authors and revises the document — and `plan` is undefined when it does not exist yet;
 *  - every other turn reads the central file, unchanged.
 *  Both branches apply the same trim and the same {@link PLAN_MAX_CHARS} bound: one plan, one size
 *  semantics, whichever copy it came from. `{ error }` is returned only when the managed provider is
 *  unreachable (no fallback to a possibly-stale central copy — "no plan" would be a lie there too), so
 *  callers can refuse honestly instead of silently dropping a plan that exists. */
export type PlanRead = { plan?: string } | { error: string };

export async function readPlanForTurn(
  resolver: SandboxResolver | undefined,
  sessionId: string,
): Promise<PlanRead> {
  // Explicit branch on the execution target: only a NON-managed turn may read the central file. A
  // managed turn whose context is incomplete (no linked account, legacy workspace scope) or whose
  // provider is unreachable surfaces the error — it never quietly degrades to the central copy.
  if (!isManagedProjectTurn()) return { plan: readPlan(sessionId) };
  const resolved = await resolveManagedArtifactTurn(resolver);
  if (typeof resolved === 'string') return { error: resolved };
  return await readGuestPlan(resolved, sessionId);
}

async function readGuestPlan(
  resolved: ResolvedManagedTurn,
  sessionId: string,
): Promise<{ plan?: string } | { error: string }> {
  const guest = {
    sandbox: resolved.sandbox,
    projectRef: resolved.turn.projectRef,
    accountUserId: resolved.turn.accountUserId,
  };
  const path = guestPlanPath(sessionId);
  // Stat first, so "the model has not written a plan yet" (stat → null) stays distinguishable from
  // "the provider could not be reached" — the second must never read as the first.
  const entry = await statGuestFile(guest, path);
  if (typeof entry === 'string') return { error: entry };
  if (!entry) return { plan: undefined };
  // Bounded well past PLAN_MAX_CHARS because a 16k-character plan can be 4× that in UTF-8 bytes; the
  // character bound is applied after, exactly as the central read applies it.
  const bytes = await readGuestFileBounded(guest, path, 256 * 1024);
  if (typeof bytes === 'string') return { error: bytes };
  const body = bytes.toString('utf8').trim();
  return { plan: body ? body.slice(0, PLAN_MAX_CHARS) : undefined };
}

/** Export the CENTRAL plan into the managed project when the session has one centrally and the guest
 *  does not yet — the one direction the central source feeds a managed turn. A guest file that EXISTS
 *  is left alone on purpose: the guest copy is the one the model edits, and re-exporting central
 *  content over it would clobber newer plan edits with a stale central file.
 *
 *  Fail-closed: an unreachable provider, a failed guest stat (NOT the same as "absent"), a refused
 *  write (read-only turn) or a failed read is an explicit `{ ok: false, error }` — no central read and
 *  no guest write happen past the failure, and the caller must never answer "no plan" from it. */
export type GuestPlanExport =
  | { ok: true; exported: boolean; plan: string | undefined }
  | { ok: false; error: string };

export async function ensureGuestPlanExported(
  resolver: SandboxResolver | undefined,
  sessionId: string,
): Promise<GuestPlanExport> {
  const resolved = await resolveManagedArtifactTurn(resolver);
  if (typeof resolved === 'string') return { ok: false, error: resolved };
  const guest = {
    sandbox: resolved.sandbox,
    projectRef: resolved.turn.projectRef,
    accountUserId: resolved.turn.accountUserId,
  };
  const path = guestPlanPath(sessionId);
  const entry = await statGuestFile(guest, path);
  // A stat ERROR is not "the file does not exist" — refuse before any central read or guest write.
  if (typeof entry === 'string') return { ok: false, error: entry };
  if (!entry) {
    const central = readPlan(sessionId);
    if (central === undefined) return { ok: true, exported: false, plan: undefined };
    const written = await writeGuestFile(guest, path, Buffer.from(central, 'utf8'));
    if (typeof written === 'string') {
      // A read-only (planning) turn makes the environment refuse every artifact write, including this
      // mirror: the runtime has no session-derived plan grant yet. The export is deferred to a later
      // build-mode turn of the same session; the gap is named, not hidden.
      if (/read_only/.test(written)) {
        logger('continuity').warn(`plan mirror for ${sessionId} deferred: the environment refuses artifact writes on a read-only turn (needs the trusted session-derived plan grant)`);
      } else {
        logger('continuity').warn(`failed to export the plan into the managed project for ${sessionId}: ${written}`);
      }
      return { ok: false, error: written };
    }
    return { ok: true, exported: true, plan: central };
  }
  const guestPlan = await readGuestPlan(resolved, sessionId);
  if ('error' in guestPlan) {
    logger('continuity').warn(`failed to read the guest plan for ${sessionId}: ${guestPlan.error}`);
    return { ok: false, error: guestPlan.error };
  }
  return { ok: true, exported: false, plan: guestPlan.plan };
}

/** What the plan-mode directive tells the model about its plan file: the path to write, and whether the
 *  document already exists. THE seam the plan artifact transfer hangs off — a managed-project turn gets
 *  the GUEST path (the model sees guest paths; the central plan is exported into the guest when the
 *  guest copy does not exist yet), every other turn gets the central host path exactly as before. */
export async function planTurnContext(
  resolver: SandboxResolver | undefined,
  sessionId: string,
): Promise<{ planFile: string; planState: string }> {
  // Explicit branch on the execution target — only a NON-managed turn takes the central host route.
  if (!isManagedProjectTurn()) {
    ensurePlanDir(sessionId);
    return { planFile: planFilePath(process.env, sessionId), planState: planStateLine(readPlan(sessionId)) };
  }
  const outcome = await ensureGuestPlanExported(resolver, sessionId);
  if (!outcome.ok) {
    // A failed mirror is never "no plan": the state stays unknown, with the reason stated.
    return {
      planFile: guestPlanPath(sessionId),
      planState: 'Its current state is UNKNOWN — the managed project filesystem could not be reached '
        + `(${outcome.error}). Read it before writing; do not assume it does not exist.`,
    };
  }
  return { planFile: guestPlanPath(sessionId), planState: planStateLine(outcome.plan) };
}

/** What the plan-mode directive says about the plan file's current state.
 *
 *  Worth a whole line of prompt because of the file tools' read guard: overwriting a file this session
 *  has not READ is refused. That guard is right, and the model walks into it in two ordinary cases — the
 *  daemon restarted (the read marks are in memory), or the user edited the plan by hand, which the
 *  directive openly invites. Both leave a model that believes it is resuming its own document and gets a
 *  refusal it has no reason to expect. Telling it the file already exists costs one sentence and turns
 *  that into a Read it would have done anyway. */
export function planStateLine(plan: string | undefined): string {
  return plan === undefined
    ? 'It does not exist yet — your first `Write` creates it.'
    : 'It ALREADY EXISTS from earlier in this conversation (or from the user editing it). Read it before'
      + ' you change it: revise what is there rather than starting over, and the file tools refuse an'
      + ' overwrite of a file this session has not read.';
}
