import { describe, expect, it } from 'vitest';
import { todoCard } from '../../lib/todoCard';
import type { SessionTask } from '../../lib/types';

// The todo plugin's PATCH/DELETE routes answer the caller and leave the panel to whoever asked, so a task
// changed from the web is what rebuilds the card. This is that rebuild, and it has to agree with the
// plugin's own `pushTaskCard` (mirrored in src/shared/todoCard.ts): the rail's Tasks section reads its
// rows off these fields, and a row rebuilt without them is a row nothing can address or time.

const task = (over: Partial<SessionTask> & Pick<SessionTask, 'id' | 'subject' | 'status'>): SessionTask => ({
  description: '', metadata: {}, blockedBy: [], blocks: [], ...over,
});

describe('todoCard', () => {
  it('carries the structured fields beside the glued text', () => {
    const card = todoCard([
      task({ id: '1', subject: 'Read the code', status: 'completed' }),
      task({
        id: '2', subject: 'Ship the fix', activeForm: 'Shipping the fix', status: 'in_progress',
        startedAt: 1_000, owner: 'reviewer',
      }),
    ]);

    expect(card).toMatchObject({ id: 'todos', title: 'Todos', pinned: true });
    expect(card.items).toEqual([
      { text: '#1 Read the code', status: 'completed', id: '1', label: 'Read the code' },
      {
        text: '#2 Shipping the fix — reviewer', status: 'in_progress', startedAt: 1_000,
        id: '2', label: 'Shipping the fix', owner: 'reviewer',
      },
    ]);
  });

  it('lists only the blockers that are still unresolved', () => {
    const card = todoCard([
      task({ id: '1', subject: 'Done blocker', status: 'completed' }),
      task({ id: '2', subject: 'Open blocker', status: 'pending' }),
      task({ id: '3', subject: 'Waiting', status: 'pending', blockedBy: ['1', '2'] }),
    ]);

    // A completed blocker no longer blocks anyone, so it leaves both the text and the field.
    expect(card.items?.[2]).toEqual({
      text: '#3 Waiting (blocked by #2)', status: 'pending', id: '3', label: 'Waiting', blockedBy: ['2'],
    });
    expect(card.items?.[1]).not.toHaveProperty('blockedBy');
  });

  it('omits the clock for work that is not running', () => {
    const card = todoCard([task({ id: '1', subject: 'Waiting', status: 'pending', startedAt: 5_000 })]);
    expect(card.items?.[0]).not.toHaveProperty('startedAt');
  });
});
