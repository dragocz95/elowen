import type { OrcaEvent, EventBus } from '../api/sse.js';
import type { MissionStore } from '../store/missionStore.js';
import type { TaskStore } from '../store/taskStore.js';
import type { UserStore } from '../store/userStore.js';
import type { PushSender } from './pushSender.js';
import { recipientsForMission } from './recipients.js';
import { buildReview, buildNeedsInput, buildStalled, buildBlocked, buildDone, type PushPayload } from './messages.js';
import { logger } from '../shared/logger.js';

const log = logger('push-dispatch');

/** Read-only slice of MissionGit the dispatcher needs (the opened PR url for a finished mission). */
export interface PrInfoReader { prInfo(missionId: string): { prUrl: string | null } | null }

export interface PushDispatcherDeps {
  missions: MissionStore;
  tasks: TaskStore;
  users: UserStore;
  sender: PushSender;
  missionGit?: PrInfoReader;
}

/** The single EventBus subscriber that turns Orca lifecycle events into phone push notifications.
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

  private handle(e: OrcaEvent): void {
    const payload = this.map(e);
    if (!payload) return;
    const recipients = payload.missionId ? recipientsForMission(payload.missionId, this.d) : [];
    if (recipients.length === 0) return; // no one to notify (e.g. owner-less mission, no admins)
    // Fire-and-forget: the bus publish is synchronous, so never await network I/O here.
    void this.d.sender.sendToUsers(recipients, payload).catch((err) => log.error('push send failed', err));
  }

  /** Map an event to a payload, or null when it warrants no push. Resolves the owning mission so the
   *  recipient set can be derived in `handle`. */
  private map(e: OrcaEvent): PushPayload | null {
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

  /** Resolve a tmux session (`orca-<agent>`) to its task via the agent:<name> label (latest match). */
  private taskForSession(session: string) {
    const name = session.replace(/^orca-/, '');
    return this.d.tasks.list().filter((t) => t.labels.includes(`agent:${name}`)).at(-1) ?? null;
  }

  /** The epic's human title for a mission id (`m-<epicId>`), falling back to a generic label. */
  private epicTitle(missionId: string): string {
    const epicId = this.d.missions.get(missionId)?.epic_id;
    return (epicId ? this.d.tasks.get(epicId)?.title : null) ?? 'Mise';
  }
}
