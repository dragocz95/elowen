import type { BrainCard, SessionTask } from './types';

/** Build the pinned `todos` card from a task list — the web's ONE place that composes that card.
 *
 *  The todo plugin emits the card itself after every TOOL call, but its HTTP routes (PATCH/DELETE task)
 *  deliberately do not: they answer the caller and leave the panel to whoever asked. A UI that mutates a
 *  task through the API therefore has to rebuild the card locally, which is what this is for.
 *
 *  It is a port of `todoCard` in `src/shared/todoCard.ts` (itself a mirror of `pushTaskCard` in the
 *  plugin's `lib/render.mjs`) rather than an import of it, for the same reason `lib/chatPresentation.ts`
 *  is a copy: the web cannot import RUNTIME code from `src/`, because Turbopack resolves module paths
 *  relative to the web root and fails the production build on anything outside it. Only the types cross
 *  that line, and only because the bundler erases them before resolution happens.
 *
 *  `text` stays the glued form every consumer understands — a chat platform posting a static message, a
 *  core older than structured card items — while `id`, `label`, `owner` and `blockedBy` repeat the same
 *  information as fields, so a renderer that can lay a row out (the telemetry rail's Tasks section, the
 *  CLI panel) places them itself instead of parsing them back out of the text. `description` and
 *  `metadata` are private agent context and never reach a panel. */
export function todoCard(tasks: readonly SessionTask[]): BrainCard {
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
  return {
    id: 'todos',
    title: 'Todos',
    pinned: true,
    items: tasks.map((task) => {
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
