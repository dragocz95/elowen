'use client';
export const dynamic = 'force-dynamic';
import { PluginRedirect } from '../../components/shell/PluginRedirect';

/** The sessions UI moved into the agents plugin bundle (plugin platform F3); this route survives as a
 *  redirect so bookmarks, notifications and old deep links (incl. ?filter=needs_input) keep working. */
export default function SessionsPage() {
  return <PluginRedirect to="/p/agents/sessions" />;
}
