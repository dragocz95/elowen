import type { BrainStore } from '../../store/brainStore.js';
import type { BrainEvent } from '../events.js';
import type { IdentityResolver } from '../identity.js';
import { processRegistry, type ProcessHandle, type ProcessInfo } from '../processRegistry.js';
import type { ClientAttachments } from './attachments.js';

interface SessionProcessDeps {
  store: BrainStore;
  attachments: ClientAttachments;
  identity: IdentityResolver;
}

/** Background-process ownership and the owner-scoped process panel. A process is owned by the user its
 *  originating session belongs to (a delegated child carries a null handle userId, so the child session's
 *  `user_id` is authoritative); the sessionless surfaces span the user's whole process tree while the
 *  session-scoped ones stay inside one conversation. Split out of BrainService: it touches only the store,
 *  the client-stream map and the ownership check, none of the live-session/turn machinery. */
export class SessionProcessService {
  private readonly store: BrainStore;
  private readonly attachments: ClientAttachments;
  private readonly identity: IdentityResolver;
  constructor(deps: SessionProcessDeps) {
    this.store = deps.store;
    this.attachments = deps.attachments;
    this.identity = deps.identity;
  }

  /** Push a background-process snapshot to the OWNER's live client streams (the CLI/web process panel),
   *  so it refreshes out of turn on every spawn/exit/kill. Wired to the process registry's change
   *  listener in the daemon. A command line can carry a secret, so the event is delivered ONLY to streams
   *  attached to a session owned by someone who operates this instance (see IdentityResolver.isOwner),
   *  never to an ordinary user's. */
  broadcastProcesses(sessionId: string, processes: ProcessInfo[]): void {
    const event: BrainEvent = { type: 'process', processes };
    for (const [listener, attachedSessionId] of this.attachments.clientStreams) {
      if (attachedSessionId === sessionId && this.identity.isOwner(this.store.getSession(attachedSessionId)?.user_id)) listener(event);
    }
  }

  /** Ownership of ONE process, independent of any session scope. The originating session row decides: a
   *  process spawned inside a DELEGATED child (sub-agent) carries `handle.userId === null` — that turn's
   *  identity has no Elowen user — so the child session's `user_id` is the only reliable owner. The handle's
   *  own userId is the fallback for a process whose session row is already gone. */
  private ownsProcess(userId: number, handle: ProcessHandle): boolean {
    const sessionOwner = handle.sessionId ? this.store.getSession(handle.sessionId)?.user_id : undefined;
    return (sessionOwner ?? handle.userId ?? null) === userId;
  }

  /** Resolve an EXPLICIT `?session=` process scope. Throws (→ 404) on an unknown or foreign session — the
   *  CLI's bound-session contract. The sessionless surfaces below never call it: they span the user's whole
   *  process tree instead. */
  private ownedProcessSession(userId: number, sessionId: string): string {
    const row = this.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    return sessionId;
  }

  /** The user's background processes. Without a session: EVERY process they own, across conversations,
   *  channels and sub-agent children — the web panel's view, and the only surface that can reach a service
   *  process an orphaned delegate left behind. With a session: that conversation only (CLI). */
  processes(userId: number, sessionId?: string): ProcessInfo[] {
    if (sessionId) return processRegistry.listForSession(this.ownedProcessSession(userId, sessionId));
    // The cross-conversation (web panel) view excludes in-flight `foreground` Bash commands: they are
    // transient tool calls owned by their live turn (Ctrl+B backgrounds them), not managed background
    // processes to list and kill. The session-scoped path above keeps them — the CLI's Ctrl+B gate reads it.
    return processRegistry.listWhere((handle) => this.ownsProcess(userId, handle) && handle.completionMode !== 'foreground');
  }

  processOutput(userId: number, processId: string, sessionId?: string): string | null {
    if (sessionId) return processRegistry.outputForSession(this.ownedProcessSession(userId, sessionId), processId);
    const handle = processRegistry.get(processId);
    return handle && this.ownsProcess(userId, handle) ? handle.readAll() : null;
  }

  killProcess(userId: number, processId: string, sessionId?: string): boolean {
    // A foreground command is owned by its live turn; the process API never kills it (that would SIGKILL a
    // command the CLI is still awaiting). Ctrl+B backgrounds it; session deletion still reaps it via killSession.
    if (processRegistry.get(processId)?.completionMode === 'foreground') return false;
    if (sessionId) return processRegistry.killForSession(this.ownedProcessSession(userId, sessionId), processId);
    const handle = processRegistry.get(processId);
    return handle !== undefined && this.ownsProcess(userId, handle) && processRegistry.kill(processId);
  }
}
