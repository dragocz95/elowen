import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const replace = vi.fn();
const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search.value),
}));

import TasksPage from '../../app/tasks/page';
import KanbanPage from '../../app/kanban/page';
import TimelinePage from '../../app/timeline/page';
import StatsPage from '../../app/stats/page';

beforeEach(() => { replace.mockClear(); search.value = ''; });

/** The four work pages moved into the work plugin's bundle. Their historical routes are bookmarked,
 *  linked from notifications and typed from memory, so they have to keep resolving — and they have to
 *  carry their query string over, because that is where the deep links live: `?new=1` opens the new-task
 *  modal (the command palette's action), `?select=` opens one task's detail (the dashboard's tiles). */
describe('legacy work routes', () => {
  it.each([
    ['/tasks', TasksPage, '/p/work/tasks'],
    ['/kanban', KanbanPage, '/p/work/kanban'],
    ['/timeline', TimelinePage, '/p/work/timeline'],
    ['/stats', StatsPage, '/p/work/stats'],
  ])('replaces %s with the plugin page', (_route, Page, target) => {
    render(<Page />);
    expect(replace).toHaveBeenCalledWith(target);
  });

  it('carries a deep link’s query string across the redirect', () => {
    search.value = 'select=elowen-42';
    render(<TasksPage />);
    expect(replace).toHaveBeenCalledWith('/p/work/tasks?select=elowen-42');
  });
});
