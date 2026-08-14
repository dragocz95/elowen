/** work — browser UI bundle.
 *
 *  Registers the work domain's four pages (task register, kanban board, timeline, spend stats) on the
 *  host's plugin-UI runtime. The plugin already owns their tables, API routes and control-plane tools;
 *  these are the surfaces on top of them, so disabling the plugin takes the whole vertical with it.
 *  Built by elowen-plugin-ui-kit (esbuild; react shimmed to the host instance) into web/index.js,
 *  which the manifest's `web.entry` points at.
 */
import { useEffect } from 'react';
import { runtime, registerWorkUi } from './runtime';
import { TasksView } from './tasks/TasksView';
import { KanbanPage } from './kanban/KanbanPage';
import { TimelineView } from './timeline/TimelineView';
import { StatsView } from './stats/StatsView';

/** /p/work root: nothing lives here — forward to the task register (replace, no history entry). */
function RootRedirect() {
  useEffect(() => { runtime().navigate('/p/work/tasks'); }, []);
  return null;
}

registerWorkUi({
  requiresApiVersion: 1,
  pages: {
    '': RootRedirect,
    'tasks': TasksView,
    'kanban': KanbanPage,
    'timeline': TimelineView,
    'stats': StatsView,
  },
});
