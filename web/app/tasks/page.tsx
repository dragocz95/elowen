'use client';
export const dynamic = 'force-dynamic';
import { PluginRedirect } from '../../components/shell/PluginRedirect';

/** The task register moved into the work plugin bundle, together with the domain under it; this route
 *  survives as a redirect so bookmarks, notifications and deep links (incl. ?new=1 from the command
 *  palette and ?select= from the dashboard) keep working. */
export default function TasksPage() {
  return <PluginRedirect to="/p/work/tasks" />;
}
