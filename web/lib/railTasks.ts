import { TODO_CARD_ID } from './chatPresentation';
import type { BrainCard, SessionTask } from './types';

/** One row of the telemetry rail's Tasks section, in the shape the section lays out.
 *
 *  It is the STRUCTURED half of a card item (see `lib/todoCard.ts`), never the glued `text`: the rail
 *  places the label, the owner and the blocked marker itself rather than parsing them back out. `id` is
 *  the todo plugin's own handle and the only thing that makes a row addressable — a card emitted before
 *  structured items existed has none, which is what the session-task fallback is for. */
export interface RailTask {
  id?: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt?: number;
  owner?: string;
  blockedBy: string[];
}

/** The conversation's checklist rows, read off the cards the stream has already delivered — no request of
 *  its own and nothing to poll.
 *
 *  ONLY the todo card. Card items are a generic mechanism, so any plugin may emit rows with ids of its
 *  own; those ids are that plugin's handles and mean nothing to the todo API, which is what a tick box
 *  built from them would PATCH. Everything else keeps reporting itself in the transcript. */
export function cardTasks(cards: readonly BrainCard[]): RailTask[] {
  const todo = cards.find((card) => card.id === TODO_CARD_ID);
  return (todo?.items ?? []).map((item) => ({
    ...(item.id !== undefined ? { id: item.id } : {}),
    label: item.label ?? item.text,
    status: item.status ?? 'pending',
    ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
    ...(item.owner !== undefined ? { owner: item.owner } : {}),
    blockedBy: item.blockedBy ?? [],
  }));
}

/** Whether the card's own rows can be ticked, i.e. whether every one of them carries a task id. A card
 *  older than structured items has rows but no handles, and a half-addressable list would offer controls
 *  that work on some rows only — so it is all or nothing, and the fallback query answers the rest. */
export const cardTasksAddressable = (rows: readonly RailTask[]): boolean =>
  rows.length > 0 && rows.every((row) => !!row.id);

export const sessionTaskRows = (tasks: readonly SessionTask[]): RailTask[] => tasks.map((task) => ({
  id: task.id,
  label: task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject,
  status: task.status,
  ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
  ...(task.owner !== undefined ? { owner: task.owner } : {}),
  blockedBy: task.blockedBy,
}));

/** Running work first, then what is waiting, then what is done — the rail reports live work, so the row
 *  worth reading is at the top. `sort` is stable, so each group keeps the list's own order. */
const TASK_ORDER: Record<RailTask['status'], number> = { in_progress: 0, pending: 1, completed: 2 };
export const orderTasks = (tasks: readonly RailTask[]): RailTask[] =>
  [...tasks].sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status]);
