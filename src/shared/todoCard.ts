import type { BrainCard, BrainCardItem } from '../brain/events.js';

/** One task as the todo plugin's HTTP API returns it, narrowed to the PUBLIC fields the Todo card shows.
 *  `description` and `metadata` also come over the wire and are deliberately absent here: they are private
 *  agent context and must never reach a panel. */
export interface TodoCardTask {
  readonly id: string;
  readonly subject: string;
  readonly activeForm?: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
  readonly owner?: string;
  readonly startedAt?: number;
  readonly blockedBy: readonly string[];
}

/** Build the pinned `todos` card from a task list.
 *
 *  MIRROR of `pushTaskCard` in the todo plugin's `lib/render.mjs`, and the ONE place a client is allowed
 *  to compose that card. The plugin emits the card itself after every TOOL call, but its HTTP routes
 *  (PATCH/DELETE task) deliberately do not — they answer the caller and leave the panel to whoever asked.
 *  A UI that mutates a task through the API therefore has to rebuild the card locally, and doing it here
 *  rather than at each call site is what keeps the two renderings from drifting apart.
 *
 *  `text` stays the glued form every consumer understands; `id`, `label`, `owner` and `blockedBy` repeat
 *  the same information as fields, so a renderer that can lay a row out places them itself. */
export function todoCard(tasks: readonly TodoCardTask[]): BrainCard {
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
  return {
    id: 'todos',
    title: 'Todos',
    pinned: true,
    items: tasks.map((task): BrainCardItem => {
      // A completed blocker no longer blocks anyone, so only the unresolved ones are worth showing.
      const blockers = task.blockedBy.filter((id) => !completed.has(id));
      const label = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
      const owner = task.owner ? ` — ${task.owner}` : '';
      const blocked = blockers.length ? ` (blocked by ${blockers.map((id) => `#${id}`).join(', ')})` : '';
      return {
        text: `#${task.id} ${label}${owner}${blocked}`,
        status: task.status,
        ...(task.status === 'in_progress' && task.startedAt != null ? { startedAt: task.startedAt } : {}),
        id: task.id,
        label,
        ...(task.owner ? { owner: task.owner } : {}),
        ...(blockers.length ? { blockedBy: blockers } : {}),
      };
    }),
  };
}
