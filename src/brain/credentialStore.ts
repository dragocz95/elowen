/** THE BRAIN'S FILE-BACKED CREDENTIAL STORE — what ModelRuntime resolves OAuth tokens through.
 *
 *  pi-coding-agent's own AuthStorage parses auth.json ONCE, at construction, and serves read()/list()
 *  from that in-memory snapshot for the life of the process. Elowen shares one auth.json across SEVERAL
 *  processes — the daemon plus every forked sub-agent runner — and the file changes under all of them:
 *  a re-login through the settings UI rewrites it, and any process's token refresh rotates it. A
 *  snapshot-serving store then keeps handing out a credential the provider has already revoked. The
 *  failure is silent and permanent: a logout+login leaves the OLD access token wallclock-"valid" (its
 *  `expires` is still in the future), so pi's expiry check never enters the refresh path — the only
 *  path that re-reads the disk — and every request 401s until the process restarts.
 *
 *  This store therefore holds NO snapshot at all: every read() and list() parses the file anew, so a
 *  credential written by any process is what every other process serves on its very next access. The
 *  file is small and reads are rare (one per model request), so freshness costs nothing measurable.
 *  Reads are async (the write side is sync but runs only on login and periodic refresh) — a slow
 *  filesystem must stall the request that needs the credential, not the whole event loop.
 *
 *  Writes keep pi's contract (see pi-ai's CredentialStore doc: "mutual exclusion per provider id,
 *  cross-process too where the backing store supports it"): modify()/delete() are serialized in-process
 *  through one promise chain and across processes through a lock directory at `<authPath>.lock` — the
 *  same path (and the same mkdir semantics) proper-lockfile uses inside pi's AuthStorage, and the lock
 *  directory is kept EMPTY, so the two implementations exclude each other should both ever run against
 *  one file. (proper-lockfile itself is not a dependency of this package — it only exists nested under
 *  pi-coding-agent — hence this hand-rolled lock with the same on-disk shape.)
 *
 *  The lock has OWNERSHIP, not just existence. A lock is identified by the inode (plus birthtime) of
 *  the directory a holder created; a stale takeover replaces that identity. The holder re-checks its
 *  identity at the moments that matter — immediately before publishing a write and before unlocking —
 *  so a process that stalled past the stale window (SIGSTOP, a long synchronous pause) and lost its
 *  lock neither clobbers the taker's write nor removes the taker's lock. Without that check the
 *  observed failure was a three-way pile-up: A stalls, B takes over and writes, A wakes, writes over
 *  B's data and then removes B's LIVE lock in its cleanup, letting C write concurrently with B — for
 *  OAuth that is a rotated refresh token silently thrown away, i.e. the account logged out.
 *
 *  Inside the lock the file is re-read, which is what lets pi's double-checked refresh see a token
 *  another process rotated a moment ago and skip its own refresh instead of burning the rotated one. */
import {
  chmodSync, closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, mkdirSync,
  openSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeSync, type Stats,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

type AuthFileData = Record<string, Credential>;

/** A lock this old belongs to a process that died holding it; a waiter may take it over. Matches the
 *  30 s staleness pi's AuthStorage passes to proper-lockfile, so neither side steals the other's live
 *  lock earlier than its own would be stolen. */
const STALE_LOCK_MS = 30_000;
/** How often a held lock's mtime is touched. A token refresh inside modify() is a network call that can
 *  outlast the stale window on a slow day; the keepalive is what stops a waiter from "recovering" a lock
 *  that is very much alive. Well under STALE_LOCK_MS so one missed touch cannot look stale. */
const LOCK_KEEPALIVE_MS = 10_000;
/** Give up acquiring after this long — surfacing a wedged lock as an error beats queueing model
 *  requests behind it forever. */
const LOCK_ACQUIRE_DEADLINE_MS = 15_000;
const LOCK_RETRY_DELAY_MS = 50;

/** How a read behaves when the file does not parse: retry briefly (a writer without atomic rename —
 *  pi's AuthStorage writes in place — resolves within milliseconds), then propagate. */
const TORN_READ_RETRIES = 3;
const TORN_READ_RETRY_MS = 25;

/** Lock timings, injectable so the stale-takeover and fencing paths are testable without 30 s waits. */
interface LockTiming {
  staleLockMs: number;
  keepaliveMs: number;
  acquireDeadlineMs: number;
  retryDelayMs: number;
}

/** The identity of the lock THIS holder created. A lock removed and remade at the same path is a
 *  different lock (different inode; birthtime breaks the tie should the filesystem reuse the inode). */
interface LockOwner {
  ino: number;
  birthtimeMs: number;
}

/** Handed to the critical section so the write can be fenced at the last possible moment. */
interface HeldLock {
  /** Throws if the lock was taken over — a holder that lost its lock must neither write nor unlock. */
  assertOwned(): void;
}

const isErrnoCode = (e: unknown, code: string): boolean =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === code;

/** JSON.parse's own SyntaxError quotes the offending text — file content, i.e. secrets — so parse
 *  failures are re-thrown as this sanitized marker. It is also what the read path's bounded retry keys
 *  on: a torn in-place write is the one TRANSIENT cause of an unparsable file. */
class CredentialFileParseError extends Error {
  constructor() { super('the credential store file does not parse as JSON'); }
}

/** Runtime validation at the trust boundary: the file is shared, hand-editable state, and blindly
 *  casting it would let a mangled entry surface much later as an unexplainable auth failure. Only the
 *  fields this codebase actually consumes are pinned (an unknown future credential type must not brick
 *  the store on a pi upgrade). */
const isCredential = (v: unknown): v is Credential => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.type !== 'string') return false;
  if (c.type === 'oauth') {
    return typeof c.access === 'string' && typeof c.refresh === 'string' && typeof c.expires === 'number';
  }
  return true;
};

const isAuthFileData = (v: unknown): v is AuthFileData =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isCredential);

export class FileCredentialStore implements CredentialStore {
  private readonly lockPath: string;
  private readonly timing: LockTiming;
  /** In-process write serialization. One chain for the whole file (not per provider) because every
   *  write rewrites the whole document anyway — two providers' writes would still contend on the file
   *  lock, and write traffic (login, periodic refresh) is far too small to care. */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** The directory checks in hardenDir() hold for the process lifetime — run them once, not per write. */
  private dirHardened = false;

  constructor(private readonly authPath: string, timing: Partial<LockTiming> = {}) {
    this.lockPath = `${authPath}.lock`;
    this.timing = {
      staleLockMs: STALE_LOCK_MS,
      keepaliveMs: LOCK_KEEPALIVE_MS,
      acquireDeadlineMs: LOCK_ACQUIRE_DEADLINE_MS,
      retryDelayMs: LOCK_RETRY_DELAY_MS,
      ...timing,
    };
  }

  /** Parse auth.json as it is on disk right now. Missing file = logged out everywhere = empty store;
   *  any other failure (unreadable, unparsable, wrong shape) throws for the caller to decide. */
  private async loadStrict(): Promise<AuthFileData> {
    let raw: string;
    try {
      raw = await readFile(this.authPath, 'utf-8');
    } catch (e) {
      if (isErrnoCode(e, 'ENOENT')) return {};
      throw e;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new CredentialFileParseError(); }
    if (!isAuthFileData(parsed)) {
      throw new Error('the credential store file is not a JSON object of credentials');
    }
    return parsed;
  }

  /** Read-path load. The ONE failure a read may absorb is a torn parse while an in-place writer is
   *  mid-write — that resolves within milliseconds, so it is retried briefly and then followed.
   *  Everything else (EACCES, I/O errors, a file that STAYS unparsable) propagates: the old
   *  "serve the last good parse" fallback swallowed those too, which could silently serve a
   *  long-revoked token forever where a visible error would have named the real problem. */
  private async loadFresh(): Promise<AuthFileData> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.loadStrict();
      } catch (e) {
        if (!(e instanceof CredentialFileParseError) || attempt >= TORN_READ_RETRIES) throw e;
        await sleep(TORN_READ_RETRY_MS);
      }
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.loadFresh())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.loadFresh()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.enqueue(() => this.withFileLock(async (lock) => {
      const data = await this.loadStrict();
      const next = await fn(data[providerId]);
      // undefined = leave unchanged — but resolve with the CURRENT on-disk credential, exactly like
      // pi's AuthStorage: this is how a caller that skipped its refresh receives the token some other
      // process already rotated.
      if (next === undefined) return data[providerId];
      this.persist({ ...data, [providerId]: next }, lock);
      return next;
    }));
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(() => this.withFileLock(async (lock) => {
      const data = await this.loadStrict();
      if (!(providerId in data)) return;
      delete data[providerId];
      this.persist(data, lock);
    }));
  }

  /** The directory is the outer wall around the secrets. Refuse to write into one owned by another
   *  user, and close group/other access — auth.json's own 0600 is only the inner wall, and the window
   *  between creating a temp file and chmod'ing it is bounded by the directory being private. */
  private hardenDir(): void {
    if (this.dirHardened) return;
    const dir = dirname(this.authPath);
    const s = statSync(dir);
    const uid = process.getuid?.();
    if (uid !== undefined && s.uid !== uid) {
      throw new Error('the credential store directory is not owned by this process user — refusing to write secrets into it');
    }
    if ((s.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    this.dirHardened = true;
  }

  /** Atomic replace with no opening for another principal:
   *   - the temp name is random, not derived from the pid, so it cannot be pre-created or pre-linked;
   *   - O_CREAT|O_EXCL|O_NOFOLLOW makes a pre-planted file or symlink FAIL the write instead of being
   *     followed to some other file of this user;
   *   - fchmod(0600) runs explicitly because open()'s mode argument is filtered by the umask and does
   *     not apply at all to a file that already exists — writeFileSync's `mode` had exactly that hole
   *     (a pre-created 0644 temp stayed 0644 after the rename, world-readable secrets);
   *   - fsync before rename so the rename never publishes a file whose content is still in flight;
   *   - the rename REPLACES a symlink at the destination rather than writing through it;
   *   - immediately before the rename the lock is re-checked — a holder whose lock was taken over
   *     during a long stall must not publish its stale view over the taker's newer write. */
  private persist(data: AuthFileData, lock: HeldLock): void {
    const tmpPath = `${this.authPath}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, JSON.stringify(data, null, 2));
      fsyncSync(fd);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch { /* best effort — the write already failed */ }
      throw e;
    } finally {
      closeSync(fd);
    }
    try {
      lock.assertOwned();
      renameSync(tmpPath, this.authPath);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch { /* best effort — the temp never became the file */ }
      throw e;
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.catch(() => undefined).then(task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /** Cross-process mutual exclusion via mkdir (atomic on every platform we run on), with stale-lock
   *  takeover so a crash while holding the lock cannot brick credential writes forever — and with the
   *  ownership fencing described in the file header, so a takeover can never lead to two writers. */
  private async withFileLock<T>(task: (lock: HeldLock) => Promise<T>): Promise<T> {
    this.hardenDir();
    const owner = await this.acquire();
    const lock: HeldLock = {
      assertOwned: () => {
        if (!this.ownsLock(owner)) {
          throw new Error('the credential store lock was taken over while this process stalled — refusing to write');
        }
      },
    };
    const keepalive = setInterval(() => {
      // Refresh only what is still OURS: touching a lock another process took over would extend a lock
      // this process no longer holds and starve the real holder's waiters.
      if (!this.ownsLock(owner)) return;
      const now = new Date();
      try { utimesSync(this.lockPath, now, now); } catch { /* gone between the check and the touch */ }
    }, this.timing.keepaliveMs);
    // The keepalive must never be what keeps the process alive.
    keepalive.unref();
    try {
      return await task(lock);
    } finally {
      clearInterval(keepalive);
      // Unlock ONLY a lock this process still owns. The unconditional rmdir here is what used to remove
      // a taker's LIVE lock after a stale takeover, letting a third writer in beside them.
      if (this.ownsLock(owner)) {
        try { rmdirSync(this.lockPath); } catch { /* lost in the last instant — nothing left to release */ }
      }
    }
  }

  private async acquire(): Promise<LockOwner> {
    const deadline = Date.now() + this.timing.acquireDeadlineMs;
    for (;;) {
      try {
        mkdirSync(this.lockPath);
        const s = statSync(this.lockPath);
        return { ino: s.ino, birthtimeMs: s.birthtimeMs };
      } catch (e) {
        if (!isErrnoCode(e, 'EEXIST')) throw e;
      }
      this.maybeTakeOverStale();
      // The deadline is checked on EVERY contended pass — including right after a takeover attempt.
      // The old loop `continue`d out of the stale branch above its deadline check, so a takeover that
      // could never succeed (a symlink, a permission error) spun the event loop forever.
      if (Date.now() > deadline) throw new Error('timed out waiting for the credential store lock');
      await sleep(this.timing.retryDelayMs);
    }
  }

  /** Inspect a contended lock; remove it if its holder is provably gone. */
  private maybeTakeOverStale(): void {
    let holder: Stats;
    try {
      holder = lstatSync(this.lockPath);
    } catch (e) {
      if (isErrnoCode(e, 'ENOENT')) return; // released between mkdir and lstat — the next pass acquires
      throw e;
    }
    // lstat + directory check: a symlink planted at the lock path is REFUSED, not followed. statSync
    // followed it to the target (whose age then decided "staleness"), and rmdir on the symlink failed
    // forever — an unbreakable, busy-spinning lock a non-owner could set up with one syscall.
    if (!holder.isDirectory()) {
      throw new Error('the credential store lock path is occupied by something that is not a lock directory — refusing to touch it');
    }
    if (Date.now() - holder.mtimeMs <= this.timing.staleLockMs) return;
    // Takeover via RENAME, not rmdir-in-place: the rename atomically claims the stale directory, so of
    // several racing waiters exactly one wins and the losers get ENOENT — rmdir'ing by path let a slow
    // waiter remove the FRESH lock a faster one had already created in its place.
    const doomed = `${this.lockPath}.stale-${randomBytes(6).toString('hex')}`;
    try {
      const again = lstatSync(this.lockPath);
      // Still the same object, still stale? A fresh lock mkdir'd since the stat above must not be
      // renamed away. (The residual instant between this check and the rename is covered by the
      // owner's own fencing: whoever loses a lock refuses to write.)
      if (!again.isDirectory() || again.ino !== holder.ino || Date.now() - again.mtimeMs <= this.timing.staleLockMs) return;
      renameSync(this.lockPath, doomed);
    } catch {
      return; // another waiter won the takeover
    }
    try { rmSync(doomed, { recursive: true, force: true }); } catch { /* an empty leftover dir, harmless */ }
  }

  /** Is the lock at the path still the very directory this holder created? */
  private ownsLock(owner: LockOwner): boolean {
    try {
      const s = lstatSync(this.lockPath);
      return s.isDirectory() && s.ino === owner.ino && s.birthtimeMs === owner.birthtimeMs;
    } catch {
      return false;
    }
  }
}
