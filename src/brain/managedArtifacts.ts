import { posix } from 'node:path';
import type { GuestFileOperation, GuestFileResult, GuestFileStat, ProjectEnvironmentControl } from '../plugins/environmentTypes.js';
import type { ManagedProjectRef } from '../shared/projectExecution.js';
import { currentAccountUserId, currentProjectRef, currentSessionId } from '../plugins/policyContext.js';
import { fsSafeSegment } from '../shared/paths.js';
import { planSlug } from '../shared/planSlug.js';
import { suffixedUploadName } from './chatUploads.js';

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
 *  - no linked account: the provider validates membership per account, and a caller with no account has
 *    none to validate;
 *  - no conversation: the plan/spill paths are per-session artifacts. */
export function managedArtifactTurn(): ManagedArtifactTurn | string {
  const projectRef = currentProjectRef();
  if (projectRef?.kind !== 'managed') return 'managed project artifacts require a managed project turn';
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

/** Shared tail: resolve the live provider for an ALREADY-VALIDATED turn request. Module-private, because
 *  the tenancy check is its caller's and both callers here do it first. */
async function resolveFor(
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
 *  `prepareExecution` options: the CALLER owns the tenancy rule for the identity it
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
function guestAbsolutePath(rawPath: unknown): string | null {
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

/** One bounded read of a MODEL-supplied guest path: the ambient managed turn, the live provider, the
 *  path shape and the bounded read, in that order. ShareFile, ShareImage and the plugin seam all go
 *  this way, so the tenancy rule and the path rule cannot drift apart between them; each refusal is a
 *  finished sentence the caller prefixes with its own tool name. */
export interface ManagedGuestArtifact {
  /** The normalized guest path the bytes came from — the callers name the file from it. */
  path: string;
  bytes: Buffer;
}

export async function readManagedGuestArtifact(
  resolver: SandboxResolver | undefined,
  rawPath: unknown,
  maxBytes: number,
): Promise<ManagedGuestArtifact | string> {
  const resolved = await resolveManagedArtifactTurn(resolver);
  if (typeof resolved === 'string') return `${resolved}.`;
  const path = guestAbsolutePath(rawPath);
  if (!path) return 'an absolute guest path is required.';
  const bytes = await readGuestFileBounded(
    { sandbox: resolved.sandbox, projectRef: resolved.turn.projectRef, accountUserId: resolved.turn.accountUserId },
    path,
    maxBytes,
  );
  return typeof bytes === 'string' ? bytes : { path, bytes };
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

/** How many times a colliding upload name is suffixed inside the guest before it is refused — the same
 *  bound the host path uses, for the same reason. */
const GUEST_UPLOAD_MAX_COLLISIONS = 200;

/** One uploaded file as it landed in the guest. `path` is an ABSOLUTE GUEST path: it is meaningful only
 *  inside this project's environment, which is exactly where the turn that reads it runs. */
export interface GuestUploadResult {
  path: string;
  name: string;
  /** Path relative to the project's guest root — what the UI shows. */
  relative: string;
  size: number;
}

/** Regroup an arbitrary byte stream into buffers of at most `chunkSize`, WITHOUT ever holding more than
 *  one chunk: the point of the upload path is that it is not bounded by what fits in memory, so a
 *  regrouping that concatenated first would reinstate exactly the ceiling this feature removed. */
async function* guestChunks(stream: AsyncIterable<Uint8Array>, chunkSize: number): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let heldBytes = 0;
  for await (const piece of stream) {
    let offset = 0;
    while (offset < piece.length) {
      const take = Math.min(chunkSize - heldBytes, piece.length - offset);
      held.push(Buffer.from(piece.subarray(offset, offset + take)));
      heldBytes += take;
      offset += take;
      if (heldBytes === chunkSize) {
        yield Buffer.concat(held, heldBytes);
        held = [];
        heldBytes = 0;
      }
    }
  }
  if (heldBytes > 0) yield Buffer.concat(held, heldBytes);
}

/**
 * Stream one upload into a managed project through the guest transport's chunked durable upload
 * (`write-begin` → `write-chunk`* → `write-commit`, `write-abort` on any failure).
 *
 * `write-begin` with `expectedVersion: null` is CREATE-ONLY and resolves the target inside the guest, so
 * the collision walk and the no-follow guarantee are the transport's own rather than a host-side check
 * with a gap in it; an `already_exists` refusal simply means the next suffix. There is no type allow-list
 * and no product size cap — `size` is the transport's own handle parameter, and the commit must account
 * for exactly the bytes that were sent or the upload is aborted rather than reported short.
 */
export async function streamGuestUpload(
  guest: GuestAccess,
  input: {
    /** The project's authoritative guest root (`managedGuestRoot`). */
    root: string;
    /** Directory under the root, e.g. `uploads/<account>/<YYYY-MM-DD>`. */
    relativeDir: string;
    /** The already-sanitized file name. */
    baseName: string;
    /** The client's declared byte count, already validated as a bounded non-negative integer. */
    declaredSize: number;
    body: AsyncIterable<Uint8Array>;
  },
): Promise<GuestUploadResult | string> {
  const dir = posix.join(input.root, input.relativeDir);
  const parents = await ensureGuestParents(guest, posix.join(dir, input.baseName));
  if (parents !== true) return parents;

  let begun: { uploadId: string; chunkSize: number; path: string } | undefined;
  let name = input.baseName;
  for (let n = 1; n <= GUEST_UPLOAD_MAX_COLLISIONS && !begun; n += 1) {
    name = n === 1 ? input.baseName : suffixedUploadName(input.baseName, n);
    const path = posix.join(dir, name);
    try {
      const result = await runOperation(guest, { kind: 'write-begin', path, expectedVersion: null, size: input.declaredSize });
      if (result.kind !== 'write-begin') return `unexpected ${result.kind} response starting the upload of ${name}.`;
      if (!result.uploadId || !Number.isSafeInteger(result.chunkSize) || result.chunkSize <= 0) {
        return `managed filesystem returned an unusable upload handle for ${name}.`;
      }
      // The transport resolved the target itself, which is what makes the create-only claim atomic.
      begun = { uploadId: result.uploadId, chunkSize: Math.min(result.chunkSize, GUEST_WRITE_OP_BYTES), path: result.resolvedPath || path };
    } catch (error) {
      if ((error as { code?: unknown }).code === 'already_exists') continue;
      return `cannot start the upload of ${name}: ${(error as Error).message}`;
    }
  }
  if (!begun) return `too many files named "${input.baseName}" in this folder today.`;

  const handle = begun;
  const abort = async (): Promise<void> => {
    // A half-written upload is worse than none, and the handle holds guest-side state until it is told
    // otherwise. Best effort: the failure already being reported is the one that matters.
    try { await runOperation(guest, { kind: 'write-abort', path: handle.path, uploadId: handle.uploadId }); } catch { /* the original failure stands */ }
  };

  let sent = 0;
  try {
    for await (const chunk of guestChunks(input.body, handle.chunkSize)) {
      const result = await runOperation(guest, {
        kind: 'write-chunk', path: handle.path, uploadId: handle.uploadId, offset: sent, base64: chunk.toString('base64'),
      });
      if (result.kind !== 'write-chunk') { await abort(); return `unexpected ${result.kind} response uploading ${name}.`; }
      sent += chunk.length;
      if (typeof result.received !== 'number' || result.received !== sent) {
        await abort();
        return `managed filesystem lost track of ${name} while it was being uploaded.`;
      }
    }
  } catch (error) {
    await abort();
    return `cannot upload ${name}: ${(error as Error).message}`;
  }

  // The declared size is the client's claim and the handle was opened against it; a stream that did not
  // match it is a truncated or overlong upload, never a success worth committing.
  if (sent !== input.declaredSize) {
    await abort();
    return `${name} arrived as ${sent} bytes where ${input.declaredSize} were declared.`;
  }

  try {
    const result = await runOperation(guest, { kind: 'write-commit', path: handle.path, uploadId: handle.uploadId });
    if (result.kind !== 'write-commit') { await abort(); return `unexpected ${result.kind} response finishing ${name}.`; }
    // The commit is what proves the size: reporting the byte count we happened to send would report a
    // number nothing on the far side ever confirmed.
    if (!Number.isSafeInteger(result.entry.size) || result.entry.size !== sent) {
      return `${name} was stored as ${result.entry.size} bytes where ${sent} were sent.`;
    }
    return { path: handle.path, name, relative: posix.join(input.relativeDir, name), size: result.entry.size };
  } catch (error) {
    await abort();
    return `cannot finish the upload of ${name}: ${(error as Error).message}`;
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
