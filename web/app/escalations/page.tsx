'use client';
export const dynamic = 'force-dynamic';
import { PluginRedirect } from '../../components/shell/PluginRedirect';

/** The escalations inbox moved into the agents plugin bundle (plugin platform F3); this route
 *  survives as a redirect so bookmarks and notification links keep working. */
export default function EscalationsPage() {
  return <PluginRedirect to="/p/agents/escalations" />;
}
