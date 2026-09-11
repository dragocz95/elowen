import type { BrainStore } from '../../store/brainStore.js';
import type { BrainEvent } from '../events.js';
import type { IdentityResolver } from '../identity.js';
import { processHandleAccount, processRegistry, type ProcessHandle, type ProcessInfo } from '../processRegistry.js';
import type { ClientAttachments } from './attachments.js';

interface SessionProcessDeps {
  store: BrainStore;
  attachments: ClientAttachments;
  identity: IdentityResolver;
  /** Background processes of the sub-agent runner pool, read LIVE per query — a runner-hosted child
   *  registers its handles in the RUNNER's own registry, and this is the one read that reaches across.
   *  Absent (pool off, runner dead) simply means no remote half. The output/kill callbacks carry the
   *  authorized owning session: the runner re-checks it against the live handle, so the act is atomic
   *  there and a stale snapshot can never cross sessions or accounts. */
  remoteProcesses?: () => Promise<ProcessInfo[]>;
  remoteProcessOutput?: (processId: string, sessionId: string) => Promise<string | null>;
  killRemoteProcess?: (processId: string, sessionId: string) => Promise<boolean>;
}

/** Background-process ownership and the owner-scoped process panel. A process is owned by the user its
 *  originating session belongs to (a delegated child carries a null handle userId, so the child session's
 *  `user_id` is authoritative); the sessionless surfaces span the user's whole process tree while the
 *  session-scoped ones stay inside one conversation. Split out of BrainService: it touches only the store,
 *  the client-stream map and the ownership check, none of the live-session/turn machinery.
 *
 *  A delegated child may run in the sub-agent runner, in which case its processes live in the RUNNER's
 *  registry and reach this service only through the remote readers — merged into the same lists, filtered
 *  by the SAME ownership rule, so the panel and the stop endpoint cannot disagree about what exists. */
export class SessionProcessService {
  private readonly store: BrainStore;
  private readonly attachments: ClientAttachments;
  private readonly identity: IdentityResolver;
  private readonly remoteProcesses?: () => Promise<ProcessInfo[]>;
  private readonly remoteProcessOutput?: (processId: string, sessionId: string) => Promise<string | null>;
  private readonly killRemoteProcess?: (processId: string, sessionId: string) => Promise<boolean>;
  constructor(deps: SessionProcessDeps) {
    this.store = deps.store;
    this.attachments = deps.attachments;
    this.identity = deps.identity;
    this.remoteProcesses = deps.remoteProcesses;
    this.remoteProcessOutput = deps.remoteProcessOutput;
    this.killRemoteProcess = deps.killRemoteProcess;
  }

  /** Push a background-process snapshot to the OWNER's live client streams (the CLI/web process panel),
   *  so it refreshes out of turn on every spawn/exit/kill. Wired to the process registry's change
   *  listener in the daemon. A command line can carry a secret, so the event is delivered ONLY to streams
   *  attached to a session owned by someone who operates this instance (see IdentityResolver.isOwner),
   *  never to an ordinary user's. A delegated child's handles carry no explicit account, so the session
   *  row's owner stands in for it — the same resolution the snapshot path applies. */
  broadcastProcesses(sessionId: string, accountUserId: number | null, processes: ProcessInfo[]): void {
    const account = accountUserId ?? this.store.getSession(sessionId)?.user_id ?? null;
    if (account === null) return;
    const event: BrainEvent = { type: 'process', processes };
    for (const [listener, attachedSessionId] of this.attachments.clientStreams) {
      if (attachedSessionId === sessionId
        && this.store.getSession(attachedSessionId)?.user_id === account
        && this.identity.isOwner(account)) listener(event);
    }
  }

  /** Ownership of ONE process, independent of any session scope. The originating session row decides: a
   *  process spawned inside a DELEGATED child (sub-agent) carries `handle.userId === null` — that turn's
   *  identity has no Elowen user — so the child session's `user_id` is the only reliable owner. The handle's
   *  own userId is the fallback for a process whose session row is already gone. */
  private ownsProcess(userId: number, handle: ProcessHandle): boolean {
    return this.ownsAccountSession(userId, processHandleAccount(handle) ?? undefined, handle.sessionId ?? null);
  }

  /** The one ownership rule, shared by local HANDLES and remote SNAPSHOTS: an explicit contribution
   *  account wins, else the originating session's row owner. A handle's explicit `null` is normalized to
   *  undefined by the caller above — "no account on this handle", which is exactly the delegated child's
   *  case and must resolve through the session row, not answer "owned by nobody". So the account here is
   *  a real user id or nothing at all; there is no third state to branch on. */
  private ownsAccountSession(userId: number, explicitAccount: number | undefined, sessionId: string | null): boolean {
    if (explicitAccount !== undefined) return explicitAccount === userId;
    const sessionOwner = sessionId ? this.store.getSession(sessionId)?.user_id : undefined;
    return (sessionOwner ?? null) === userId;
  }

  /** Ownership of a runner-reported process. The wire snapshot carries no account field, so the session
   *  row decides — the same answer the handle itself would give, since a runner serves delegated
   *  children only (whose handles carry no explicit account). */
  private ownsSnapshot(userId: number, process: ProcessInfo): boolean {
    return this.ownsAccountSession(userId, undefined, process.sessionId);
  }

  /** Resolve an EXPLICIT `?session=` process scope. Throws (→ 404) on an unknown or foreign session — the
   *  CLI's bound-session contract. The sessionless surfaces below never call it: they span the user's whole
   *  process tree instead. */
  private ownedProcessSession(userId: number, sessionId: string): string {
    const row = this.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    return sessionId;
  }

  /** The user's background processes — local registry plus, when a runner holds delegated children, the
   *  runner's. Without a session: EVERY process they own, across conversations, channels and sub-agent
   *  children — the web panel's view, and the only surface that can reach a service process an orphaned
   *  delegate left behind. With a session: that conversation only (CLI). A runner that cannot answer
   *  REJECTS the read: an empty list here would be the lie "nothing is running" and panels would hide
   *  live processes (the route renders it as 503, unavailable — a different answer from empty). */
  private async remoteSnapshots(): Promise<ProcessInfo[]> {
    if (!this.remoteProcesses) return [];
    try { return await this.remoteProcesses(); }
    catch (e) { throw new Error(`process list unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async processes(userId: number, sessionId?: string): Promise<ProcessInfo[]> {
    if (sessionId) {
      const owned = this.ownedProcessSession(userId, sessionId);
      const local = processRegistry.listWhere((handle) => handle.sessionId === owned && this.ownsProcess(userId, handle));
      const remote = await this.remoteSnapshots();
      return [...local, ...remote.filter((process) => process.sessionId === owned && this.ownsSnapshot(userId, process))];
    }
    // The cross-conversation (web panel) view excludes in-flight `foreground` Bash commands: they are
    // transient tool calls owned by their live turn (Ctrl+B backgrounds them), not managed background
    // processes to list and kill. The session-scoped path above keeps them — the CLI's Ctrl+B gate reads it.
    const local = processRegistry.listWhere((handle) => this.ownsProcess(userId, handle) && handle.completionMode !== 'foreground');
    const remote = await this.remoteSnapshots();
    return [...local, ...remote.filter((process) => this.ownsSnapshot(userId, process) && process.completionMode !== 'foreground')];
  }

  async processOutput(userId: number, processId: string, sessionId?: string): Promise<string | null> {
    if (sessionId) {
      const owned = this.ownedProcessSession(userId, sessionId);
      const handle = processRegistry.get(processId);
      if (handle?.sessionId === owned && this.ownsProcess(userId, handle)) return handle.readAll();
    } else {
      const handle = processRegistry.get(processId);
      if (handle && this.ownsProcess(userId, handle)) return handle.readAll();
    }
    // Not in THIS registry: a runner-hosted child's process. Ownership is decided HERE, from the same
    // rule as the list — the runner is only ever asked for output the caller may read. An unreachable
    // runner rejects (→ 503): faked null output would read as "the process printed nothing".
    const remoteOutput = await this.remoteSnapshots();
    const snapshot = remoteOutput.find((process) => process.id === processId);
    if (!snapshot || !this.ownsSnapshot(userId, snapshot)) return null;
    if (sessionId && snapshot.sessionId !== this.ownedProcessSession(userId, sessionId)) return null;
    // snapshot.sessionId is non-null here: a null-session snapshot already failed ownsSnapshot above.
    return (await this.remoteProcessOutput?.(processId, snapshot.sessionId!)) ?? null;
  }

  async killProcess(userId: number, processId: string, sessionId?: string): Promise<boolean> {
    // A foreground command is owned by its live turn; the process API never kills it (that would SIGKILL a
    // command the CLI is still awaiting). Ctrl+B backgrounds it; session deletion still reaps it via killSession.
    if (processRegistry.get(processId)?.completionMode === 'foreground') return false;
    if (sessionId) {
      const owned = this.ownedProcessSession(userId, sessionId);
      const handle = processRegistry.get(processId);
      if (handle?.sessionId === owned && this.ownsProcess(userId, handle)) return this.killLocal(processId);
    } else {
      const handle = processRegistry.get(processId);
      if (handle && this.ownsProcess(userId, handle)) return this.killLocal(processId);
    }
    // Runner-hosted: authorize against the snapshot list, then stop it through the same registry kill the
    // child's own tools use. Never a blind forward by id. The foreground guard matches the local path: a
    // command the child's live turn is still awaiting is not the process API's to SIGKILL. An
    // unconfirmed remote kill rejects (→ 503): false here must mean "already finished", never "gave up".
    const remoteKill = await this.remoteSnapshots();
    const snapshot = remoteKill.find((process) => process.id === processId);
    if (!snapshot || snapshot.completionMode === 'foreground' || !this.ownsSnapshot(userId, snapshot)) return false;
    if (sessionId && snapshot.sessionId !== this.ownedProcessSession(userId, sessionId)) return false;
    return (await this.killRemoteProcess?.(processId, snapshot.sessionId!)) ?? false;
  }

  /** The registry kill is confirmed-or-nothing: a failure leaves the handle in place and rejects, which
   *  the route renders as 503 (the process is still there, try again) rather than a 404-style "gone". */
  private async killLocal(processId: string): Promise<boolean> {
    try { return await processRegistry.kill(processId); }
    catch (e) { throw new Error(`process stop unconfirmed: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
