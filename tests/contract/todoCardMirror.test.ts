import { describe, it, expect } from 'vitest';
import { todoCard as sharedTodoCard, type TodoCardTask } from '../../src/shared/todoCard.js';
import { todoCard as webTodoCard } from '../../web/lib/todoCard';

/** The todo card is composed in THREE places and must come out identical from each: the plugin's own
 *  `pushTaskCard` (registry repo, `plugins/todo/lib/render.mjs`) emits it after every tool call, while a
 *  UI that mutates a task over the plugin's HTTP routes — which deliberately do not re-emit the card —
 *  rebuilds it locally, the CLI through `src/shared/todoCard.ts` and the web through `web/lib/todoCard.ts`.
 *
 *  The web copy is a PORT rather than an import for the same reason `lib/chatPresentation.ts` is a copy:
 *  Turbopack resolves module paths relative to the web root and fails `next build` on anything outside it,
 *  and `tsc --noEmit` plus vitest both resolve such an import happily — so the mistake would only surface
 *  in the production build. Here the two copies are pinned by BEHAVIOUR rather than by source text: their
 *  signatures legitimately differ (`TodoCardTask` against the web's `SessionTask`), so the honest question
 *  is whether they still emit the same card, not whether they still read the same.
 *
 *  The plugin's `pushTaskCard` cannot join this test: it lives in the plugin registry repository, and
 *  reaching across would make the core test suite depend on a checkout it does not own. It stays pinned by
 *  the registry's own todo tests and by the doc comments on both sides. */
describe('todoCard mirror', () => {
  /** Every branch the mapper has: an in-progress row with an activeForm and a start time, an owner, a
   *  blocker that is still open, a blocker that is already done (dropped), a pending row with neither, and
   *  a completed row that keeps no startedAt. */
  const TASKS: TodoCardTask[] = [
    {
      id: '1', subject: 'Read the code', activeForm: 'Reading the code', status: 'in_progress',
      startedAt: 100_000, blockedBy: [],
    },
    { id: '2', subject: 'Ship the fix', status: 'pending', owner: 'filip', blockedBy: ['1', '4'] },
    { id: '3', subject: 'Write it up', status: 'pending', blockedBy: [] },
    { id: '4', subject: 'Open the branch', status: 'completed', startedAt: 90_000, blockedBy: [] },
    // A row whose activeForm must be IGNORED because it is not the running one.
    { id: '5', subject: 'Draft the notes', activeForm: 'Drafting the notes', status: 'pending', owner: 'reviewer', blockedBy: ['4'] },
  ];

  it('emits the same card from the shared mapper and the web port', () => {
    expect(webTodoCard(TASKS.map((task) => ({
      ...task,
      description: 'private',
      metadata: {},
      blockedBy: [...task.blockedBy],
      blocks: [],
    })))).toEqual(sharedTodoCard(TASKS));
  });

  it('agrees on the empty list', () => {
    expect(webTodoCard([])).toEqual(sharedTodoCard([]));
  });

  /** The shape itself, so a change made identically in both copies still has to be a deliberate one. */
  it('composes the pinned todo card the plugin emits', () => {
    expect(sharedTodoCard(TASKS)).toEqual({
      id: 'todos',
      title: 'Todos',
      pinned: true,
      items: [
        { text: '#1 Reading the code', status: 'in_progress', startedAt: 100_000, id: '1', label: 'Reading the code' },
        { text: '#2 Ship the fix — filip (blocked by #1)', status: 'pending', id: '2', label: 'Ship the fix', owner: 'filip', blockedBy: ['1'] },
        { text: '#3 Write it up', status: 'pending', id: '3', label: 'Write it up' },
        { text: '#4 Open the branch', status: 'completed', id: '4', label: 'Open the branch' },
        { text: '#5 Draft the notes — reviewer', status: 'pending', id: '5', label: 'Draft the notes', owner: 'reviewer' },
      ],
    });
  });
});
