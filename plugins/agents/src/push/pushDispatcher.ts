import type { ElowenEvent } from '../../../../src/api/sse.js';
import type { AgentsBus as EventBus } from '../lib/bus.js';
import type { MissionStore } from '../store/missionStore.js';
import type { TaskStore } from '../../../../src/store/taskStore.js';
import { recipientsForMission, type PushUsersView } from './recipients.js';
import { buildReview, buildNeedsInput, buildStalled, buildBlocked, buildDone, type PushPayload } from './messages.js';
import { logger } from '../lib/logger.js';
import { stripPrefix } from '../lib/text.js';

const log = logger('push-dispatch');

/** Read-only slice of MissionGit the dispatcher needs (the opened PR url for a finished mission). */
export interface PrInfoReader { prInfo(missionId: string): { prUrl: string | null } | null }

/** The push TRANSPORT seam (mine-4 decision): the PushSender stays in core; the plugin only ever hands
 *  it user ids + a payload. Structural, so the composition root passes the host transport through. */
interface PushTransport { sendToUsers(userIds: number[], payload: PushPayload): Promise<unknown> }

export interface PushDispatcherDeps {
  missions: MissionStore;
  tasks: TaskStore;
  /** Read-only admin-flag view (host usersRead) — deviation from core, which takes the full UserStore. */
  users: PushUsersView;
  sender: PushTransport;
  missionGit?: PrInfoReader;
}

/** The single EventBus subscriber that turns Elowen lifecycle events into phone push notifications.
 *  Maps each "a human is (maybe) needed" or "mission finished" event to a payload + recipient set and
 *  fires the sender. Every handler is null-guarded and wrapped so a lookup miss or a sender error can
 *  never abort the bus broadcast. */
export class PushDispatcher {
  constructor(private d: PushDispatcherDeps) {}

  /** Subscribe to the bus; returns the unsubscribe fn. */
  subscribe(bus: EventBus): () => void {
    return bus.subscribe((e) => {
      try { this.handle(e); } catch (err) { log.error('push dispatch failed', err); }
    });
  }

  private handle(e: ElowenEvent): void {
    const payload = this.map(e);
    if (!payload) return;
    // A standalone (mission-less) task still needs a human when it blocks or asks — buildNeedsInput /
    // buildBlocked deliberately model `missionId: undefined`. Fall back to admins (mirroring
    // recipientsForMission's own owner-less fallback) instead of dropping the notification entirely.
    const recipients = payload.missionId
      ? recipientsForMission(payload.missionId, this.d)
      : this.d.users.list().filter((u) => u.is_admin).map((u) => u.id);
    if (recipients.length === 0) return; // no one to notify (e.g. owner-less mission, no admins)
    // Fire-and-forget: the bus publish is synchronous, so never await network I/O here.
    void this.d.sender.sendToUsers(recipients, payload).catch((err) => log.error('push send failed', err));
  }

  /** Map an event to a payload, or null when it warrants no push. Resolves the owning mission so the
   *  recipient set can be derived in `handle`. */
  private map(e: ElowenEvent): PushPayload | null {
    if (e.type === 'review') {
      if (e.approve) return null; // approved → nothing to decide
      const phase = this.d.tasks.get(e.taskId);
      return buildReview({ missionId: e.missionId, taskId: e.taskId, phaseTitle: phase?.title ?? 'Fáze', rationale: e.rationale });
    }
    if (e.type === 'signal' && e.signal.type === 'needs_input') {
      const task = this.taskForSession(e.session);
      const missionId = task?.parent_id ? `m-${task.parent_id}` : undefined;
      return buildNeedsInput({ missionId, taskId: task?.id, session: e.session, question: e.signal.question, hasOptions: e.signal.options.length > 0 });
    }
    if (e.type === 'mission' && e.state === 'stalled') {
      return buildStalled({ missionId: e.missionId, epicTitle: this.epicTitle(e.missionId) });
    }
    if (e.type === 'mission' && e.state === 'disengaged') {
      // `disengaged` is overloaded: it fires on natural completion AND on manual teardown (DELETE
      // mission/task, admin cleanup). Only natural completion closes the epic (writeMissionSummary),
      // so gate the "Mise dokončena" push on that — a manual stop must not claim the mission finished.
      const epicId = this.d.missions.get(e.missionId)?.epic_id;
      if (!epicId || this.d.tasks.get(epicId)?.status !== 'closed') return null;
      return buildDone({ missionId: e.missionId, epicTitle: this.epicTitle(e.missionId), prUrl: this.d.missionGit?.prInfo(e.missionId)?.prUrl ?? null });
    }
    if (e.type === 'task' && e.status === 'blocked') {
      const task = this.d.tasks.get(e.taskId);
      if (!task) return null;
      const missionId = task.parent_id ? `m-${task.parent_id}` : undefined;
      return buildBlocked({ missionId, taskId: task.id, taskTitle: task.title });
    }
    return null;
  }

  /** Resolve a tmux session (`elowen-<agent>`) to its task via the agent:<name> label (latest match). */
  private taskForSession(session: string) {
    const name = stripPrefix(session, 'elowen-');
    return this.d.tasks.list().filter((t) => t.labels.includes(`agent:${name}`)).at(-1) ?? null;
  }

  /** The epic's human title for a mission id (`m-<epicId>`), falling back to a generic label. */
  private epicTitle(missionId: string): string {
    const epicId = this.d.missions.get(missionId)?.epic_id;
    return (epicId ? this.d.tasks.get(epicId)?.title : null) ?? 'Mise';
  }
}
