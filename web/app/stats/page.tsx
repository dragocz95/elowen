'use client';
export const dynamic = 'force-dynamic';
import { PluginRedirect } from '../../components/shell/PluginRedirect';

/** The spend statistics moved into the work plugin bundle; this route survives as a redirect so
 *  bookmarks and in-app links keep working. */
export default function StatsPage() {
  return <PluginRedirect to="/p/work/stats" />;
}
