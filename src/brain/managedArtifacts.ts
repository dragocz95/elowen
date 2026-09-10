import { posix } from 'node:path';
import type { GuestFileOperation, GuestFileResult, GuestFileStat, ProjectEnvironmentControl } from '../plugins/environmentTypes.js';
import type { ManagedProjectRef } from '../shared/projectExecution.js';
import { currentAccountUserId, currentPathView, currentProjectRef, currentSessionId } from '../plugins/policyContext.js';
import { fsSafeSegment } from '../shared/paths.js';
import { planSlug } from '../shared/planSlug.js';

/** The `projectFiles` seam the guest artifact consumers call — the canonical contract, narrowed with a
 *  Pick rather than a hand-maintained parallel. environmentTypes is cycle-free (it reaches only
 *  shared/projectExecution), so this keeps plugins/api's type graph out of here without duplicating a
 *  public field. */
export type GuestFileSandbox = Pick<ProjectEnvironmentControl, 'projectFiles'>;

/** Central guest artifact consumers — the one place a core consumer (ShareFile, ShareImage, the plan
 *  store, tool-result spilling) resolves the managed project and reads/writes one bounded file through
 *  the Sandbox `projectFiles` contract. Guest bytes are reachable ONLY through the provider, which
 *  authorizes the account and project per operation; nothing here touches the host path guard or host
 *  fs, and there is no host fallback — a provider that cannot serve a managed turn is a refusal.
 *
 *  Bounds from the runtime contract (guestFiles.py): one read or write op carries at most 512 KiB; the
 *  contract has no append and no chunked CAS, so a write larger than one op is refused, never truncated
 *  (reported gap: version-chained or appended writes would lift it). */

/** Where CENTRAL writes (the plan mirror, tool-result spills) live inside the guest. The project itself
 *  is mounted under its own name (`/kolin`), which differs per project and is the person's own working
 *  tree; Elowen's own artifacts sit on the environment's data volume instead, so their path is the same
 *  in every environment and a cold pass that has no turn scope can still name them. */
export const GUEST_ARTIFACT_ROOT = '/data/.elowen';
const GUEST_PLAN_DIR = `${GUEST_ARTIFACT_ROOT}/plans`;
const GUEST_SPILL_DIR = `${GUEST_ARTIFACT_ROOT}/tool-results`;

/** Per read operation. 128 KiB keeps one provider round trip (and its in-memory copy) small while a
 *  bounded consumer — 25 MiB ShareFile, a 16k-char plan — stays a bounded number of chunks. */
export const GUEST_READ_CHUNK_BYTES = 128 * 1024;
/** Per write operation, straight from the guest transport contract (MAX_BYTES in guestFiles.py). */
export const GUEST_WRITE_OP_BYTES = 512 * 1024;

/** The ambient managed-project state a tool or turn hook reads from the policy context. */
export interface ManagedArtifactTurn {
  projectRef: ManagedProjectRef;
  accountUserId: number;
  sessionId: string;
}

/** Whether the ambient turn selected a MANAGED project — the explicit branch predicate every consumer
 *  checks FIRST. A refusal reason is never a branch signal; only this decides host vs managed route. */
export function isManagedProjectTurn(): boolean {
  return currentProjectRef()?.kind === 'managed';
}

/** Ambient check only — no provider I/O and no host path handling. Returns a refusal reason when the
 *  current turn may not use managed artifacts at all:
 *  - not a managed project turn (the whole feature is behind the selected execution target);
 *  - a legacy EXACT workspace scope is present (`currentPathView`): a workspace-scoped delegated child
 *    must never widen into the managed project — the same rule Sandbox's `prepareExecution` enforces
 *    (`workspace_pinned`), restated here because file consumers resolve BEFORE any execution is prepared;
 *  - no linked account: the provider validates membership per account, and a caller with no account has
 *    none to validate;
 *  - no conversation: the plan/spill paths are per-session artifacts. */
export function managedArtifactTurn(): ManagedArtifactTurn | string {
  const projectRef = currentProjectRef();
  if (projectRef?.kind !== 'managed') return 'managed project artifacts require a managed project turn';
  if (currentPathView()) return 'a legacy exact workspace cannot widen into a managed project';
  const accountUserId = currentAccountUserId();
  if (accountUserId === null || !Number.isSafeInteger(accountUserId) || accountUserId < 1) {
    return 'managed project artifacts require a linked account';
  }
  const sessionId = currentSessionId();
  if (!sessionId) return 'managed project artifacts require a conversation';
  return { projectRef, accountUserId, sessionId };
}

/** The sandbox resolver every consumer takes. Core wires it live at the composition/bootstrap site
 *  (`plugins.peek().control('sandbox')`) — retaining a SandboxControl across plugin reloads is invalid,
 *  so the consumer calls it fresh for every operation. Sync accessors (the brain deps' `sandbox()`)
 *  satisfy the type too; the consumer awaits whichever it gets. */
export type SandboxResolver = () => GuestFileSandbox | undefined | Promise<GuestFileSandbox | undefined>;

export interface ResolvedManagedTurn {
  turn: ManagedArtifactTurn;
  sandbox: GuestFileSandbox;
}

/** Ambient check + live provider resolution. `undefined`/non-functional provider → refusal, never a
 *  host fallback. */
export async function resolveManagedArtifactTurn(
  resolver: SandboxResolver | undefined,
): Promise<ResolvedManagedTurn | string> {
  const turn = managedArtifactTurn();
  if (typeof turn === 'string') return turn;
  return await resolveFor(resolver, turn);
}

/** Shared tail: resolve the live provider for an ALREADY-VALIDATED turn request — the share tools call
 *  it after their own ambient branch decision. Not for arbitrary callers: the tenancy check is the
 *  caller's here. */
export async function resolveFor(
  resolver: SandboxResolver | undefined,
  turn: ManagedArtifactTurn,
): Promise<ResolvedManagedTurn | string> {
  if (!resolver) return 'managed project filesystem is unavailable because the Sandbox plugin is not wired';
  let sandbox: GuestFileSandbox | undefined;
  try {
    sandbox = await resolver();
  } catch {
    sandbox = undefined; // a throwing seam is the same as an absent one: refuse rather than half-work
  }
  if (!sandbox || typeof sandbox.projectFiles !== 'function') {
    return 'managed project filesystem is unavailable because it requires the Sandbox plugin';
  }
  return { turn, sandbox };
}

/** Explicit-identity variant for the central consumers that run OUTSIDE a prompt turn's scope — the
 *  cold turn-start pass reads no ambient context at all. Same pattern as Sandbox's
 *  `workspacesFor`/`prepareExecution` options: the CALLER owns the tenancy rule for the identity it
 *  names (here: the session's stored execution kind and its owner account), and this validates the
 *  request shape plus the live provider, nothing else. */
export async function resolveManagedArtifactsFor(
  resolver: SandboxResolver | undefined,
  request: ManagedArtifactTurn,
): Promise<ResolvedManagedTurn | string> {
  if (request.projectRef?.kind !== 'managed' || !Number.isSafeInteger(request.projectRef.projectId) || request.projectRef.projectId < 1) {
    return 'managed project artifacts require a managed project ref';
  }
  if (!Number.isSafeInteger(request.accountUserId) || request.accountUserId < 1) {
    return 'managed project artifacts require a linked account';
  }
  if (!request.sessionId) return 'managed project artifacts require a conversation';
  return await resolveFor(resolver, request);
}

/** One resolved turn plus the provider, as the read/write primitives want it. */
export interface GuestAccess {
  sandbox: GuestFileSandbox;
  projectRef: ManagedProjectRef;
  accountUserId: number;
}

/** Validate a model-supplied guest path for READING. The managed guest is a whole filesystem: the model
 *  may share an artifact from anywhere in it (`/tmp/build.pdf`, `/etc/os-release`, `/kolin/a.png`).
 *  Confinement is not the read boundary — the provider authorizes the account's environment per op —
 *  only the SHAPE is checked here: absolute, normalized, no NUL, bounded length. `null` = not an
 *  absolute guest path; the caller refuses, it never falls through to the host branch. */
export function guestAbsolutePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0') || rawPath.length > 4096) return null;
  if (!posix.isAbsolute(rawPath)) return null;
  return posix.resolve(rawPath);
}

/** Validate a path CENTRAL consumers WRITE to: the plan mirror and the tool-result spills, all
 *  centrally minted, so they stay under the hidden artifact prefix and nowhere else. */
export function guestArtifactDestinationPath(path: string): string | null {
  const resolved = guestAbsolutePath(path);
  if (!resolved) return null;
  if (resolved === GUEST_ARTIFACT_ROOT || !resolved.startsWith(`${GUEST_ARTIFACT_ROOT}/`)) return null;
  return resolved;
}

async function runOperation(guest: GuestAccess, operation: GuestFileOperation): Promise<GuestFileResult> {
  return guest.sandbox.projectFiles({
    project: guest.projectRef,
    accountUserId: guest.accountUserId,
    operation,
  });
}

/** `stat` one guest path. `null` = does not exist (the same answer a host stat's ENOENT carries). */
export async function statGuestFile(guest: GuestAccess, path: string): Promise<GuestFileStat | null | string> {
  try {
    const result = await runOperation(guest, { kind: 'stat', path });
    if (result.kind !== 'stat') return `unexpected ${result.kind} response for a stat of ${path}`;
    return result.entry;
  } catch (error) {
    return `cannot inspect ${posix.basename(path)}: ${(error as Error).message}`;
  }
}

/** A size a person can act on, in the unit that actually fits it. Rounding everything to whole megabytes
 *  reported the 512 KiB guest bound as a "1 MB limit" that a 0.6 MB file was somehow over, and any bound
 *  under half a megabyte as "0 MB". Below one mebibyte the answer is in KiB; at or above it, megabytes to
 *  one decimal with a trailing `.0` dropped, so the 25 MB and 10 MB share limits read exactly as before.
 *  KiB round UP: a file one byte over the bound must not read as "512 KiB, over the 512 KiB limit". */
function byteLabel(bytes: number): string {
  return bytes >= 1048576 ? `${Number((bytes / 1048576).toFixed(1))} MB` : `${Math.ceil(bytes / 1024)} KiB`;
}

/** Read at most `maxBytes` of one guest file, in bounded chunks pinned to the INITIAL stat: the size and
 *  version are fixed up front, every chunk must agree with them (a grown or rewritten file changes its
 *  content version and is refused rather than read across the change), each response is validated BEFORE
 *  anything accumulates — totalBytes a safe non-negative int ≤ maxBytes, chunk bytes ≤ total−offset, a
 *  non-empty string version — and a final stat re-pins the end. Returns a refusal message on any
 *  failure; never throws, so callers can surface the string verbatim. */
export async function readGuestFileBounded(
  guest: GuestAccess,
  path: string,
  maxBytes: number,
): Promise<Buffer | string> {
  const name = posix.basename(path);
  const entry = await statGuestFile(guest, path);
  if (typeof entry === 'string') return entry;
  if (!entry) return `cannot find ${name}.`;
  if (entry.kind !== 'file') return `${name} is not a file.`;
  if (entry.size > maxBytes) {
    return `${name} is ${byteLabel(entry.size)}, over the ${byteLabel(maxBytes)} limit.`;
  }
  if (typeof entry.version !== 'string' || !entry.version) return `managed filesystem returned an invalid version for ${name}.`;
  const version = entry.version;
  const size = entry.size;

  const parts: Buffer[] = [];
  let offset = 0;
  do {
    const length = Math.min(GUEST_READ_CHUNK_BYTES, maxBytes - offset);
    try {
      const result = await runOperation(guest, { kind: 'read', path, offset, length, maxBytes: length });
      if (result.kind !== 'read') return `unexpected response reading ${name}.`;
      if (typeof result.version !== 'string' || !result.version) return `managed filesystem returned an invalid version for ${name}.`;
      // Malformed provider responses are refused BEFORE anything accumulates: a size outside the
      // requested bound can only be a lie, and never a licence for a follow-up zero-length read.
      if (typeof result.totalBytes !== 'number' || !Number.isSafeInteger(result.totalBytes)
        || result.totalBytes < 0 || result.totalBytes > maxBytes) {
        return `managed filesystem returned an invalid size for ${name}.`;
      }
      if (result.version !== version || result.totalBytes !== size) {
        return `file changed while it was being read; retry ${name}.`;
      }
      if (typeof result.base64 !== 'string' || result.base64.length > Math.ceil(length / 3) * 4 + 4) {
        return `managed filesystem exceeded the byte transport limit reading ${name}.`;
      }
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.length > size - offset) return `managed filesystem returned an oversized read of ${name}.`;
      if (bytes.length === 0 && offset < size) return `managed file read ended before EOF reading ${name}.`;
      if (bytes.length > 0) {
        parts.push(bytes);
        offset += bytes.length;
      }
    } catch (error) {
      return `cannot read ${name}: ${(error as Error).message}`;
    }
  } while (offset < size);
  const after = await statGuestFile(guest, path);
  if (typeof after === 'string') return after;
  if (!after || after.version !== version) return `file changed while it was being read; retry ${name}.`;
  return Buffer.concat(parts);
}

/** Create the missing parent directories of one guest path, the way the files plugin's managed Write
 *  does. Single-level `mkdir` ops, tolerating a parent that appears concurrently (`already_exists`). */
async function ensureGuestParents(guest: GuestAccess, path: string): Promise<true | string> {
  const missing: string[] = [];
  let parent = posix.dirname(path);
  for (;;) {
    const stat = await statGuestFile(guest, parent);
    if (typeof stat === 'string') return stat;
    if (stat) {
      if (stat.kind !== 'directory') return `${parent} is not a directory.`;
      break;
    }
    missing.push(parent);
    const next = posix.dirname(parent);
    if (next === parent) return 'guest filesystem root is unavailable.';
    parent = next;
  }
  for (const directory of missing.reverse()) {
    try {
      const result = await runOperation(guest, { kind: 'mkdir', path: directory });
      if (result.kind !== 'mkdir') return `unexpected ${result.kind} response creating ${directory}.`;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const stat = code === 'already_exists' ? await statGuestFile(guest, directory) : null;
      if (typeof stat === 'object' && stat !== null && stat.kind === 'directory') continue;
      return `cannot create ${directory}: ${(error as Error).message}`;
    }
  }
  return true;
}

/** Write at most {@link GUEST_WRITE_OP_BYTES} to one guest file with the contract's CAS semantics:
 *  `expectedVersion: null` creates, an explicit version overwrites exactly that content. The caller owns
 *  the CAS (stat → write) when it needs one; the plan export and the spill writer use create-once, which
 *  is what their placeholder semantics require. Returns a refusal string on any failure. */
export async function writeGuestFile(
  guest: GuestAccess,
  path: string,
  bytes: Buffer,
  expectedVersion: string | null = null,
): Promise<GuestFileStat | string> {
  // Central writes are confined to the hidden artifact prefix (plan mirror, spills) — the one place a
  // consumer ever writes. Every other guest write goes through the model's own file tools.
  const destination = guestArtifactDestinationPath(path);
  if (!destination) return `${path} is not a managed artifact destination.`;
  if (!Number.isSafeInteger(bytes.length) || bytes.length < 0) return 'invalid write payload.';
  if (bytes.length > GUEST_WRITE_OP_BYTES) {
    return `${posix.basename(destination)} needs a ${(bytes.length / 1024).toFixed(0)} KiB write, over the ${GUEST_WRITE_OP_BYTES / 1024} KiB guest write limit.`;
  }
  const parents = await ensureGuestParents(guest, destination);
  if (parents !== true) return parents;
  try {
    const result = await runOperation(guest, { kind: 'write', path: destination, base64: bytes.toString('base64'), expectedVersion });
    if (result.kind !== 'write') return `unexpected ${result.kind} response writing ${posix.basename(destination)}.`;
    return result.entry;
  } catch (error) {
    return `cannot write ${posix.basename(destination)}: ${(error as Error).message}`;
  }
}

/** The session's plan file INSIDE the managed project — same readable slug the central plans directory
 *  uses, under the hidden artifact prefix. Derived, never stored: every consumer that needs the path
 *  computes the same answer from the session id alone. */
export function guestPlanPath(sessionId: string): string {
  return posix.join(GUEST_PLAN_DIR, `${fsSafeSegment(planSlug(sessionId))}.md`);
}

/** Is `candidate` EXACTLY this session's guest plan file? The guest-side twin of pathGuard's
 *  `isSessionPlanPath`: the plan-mode write clamp admits one exact path and nothing else, so a planning
 *  turn in a managed project can author its plan in the guest. Normalized through `posix.resolve` (no
 *  `..`, no doubled separators); the provider's own CAS and the clamp's exactness are the boundary. */
export function isSessionGuestPlanPath(sessionId: string, candidate: string): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  return posix.resolve(candidate) === guestPlanPath(sessionId);
}

/** The guest spill directory of one HOST spill namespace — the same immutable namespace
 *  `sessionToolResultSpillDir` uses, so a `/context` re-key can never separate the guest files from the
 *  placeholders that name them either. */
export function guestSpillDirForNamespace(spillNs: string): string {
  return posix.join(GUEST_SPILL_DIR, fsSafeSegment(spillNs));
}
