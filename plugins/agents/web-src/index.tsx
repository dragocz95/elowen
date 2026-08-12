/** agents — browser UI bundle (plugin platform F3).
 *
 *  Registers the subsystem's moved pages (live agent sessions, the escalations inbox) and the plugin
 *  settings section on the host's plugin-UI runtime. Built by @elowen/plugin-ui-kit (esbuild; react
 *  shimmed to the host instance) into web/index.js, which the manifest's `web.entry` points at.
 */
import { useEffect } from 'react';
import { runtime, registerAgentsUi } from './runtime';
import { SessionsView } from './sessions/SessionsView';
import { EscalationsView } from './escalations/EscalationsView';
import { AgentsSettings } from './settings/AgentsSettings';
import { CliAgentsSettings } from './settings/CliAgentsSettings';

/** /p/agents root: nothing lives here — forward to the sessions page (replace, no history entry). */
function RootRedirect() {
  useEffect(() => { runtime().navigate('/p/agents/sessions'); }, []);
  return null;
}

registerAgentsUi({
  requiresApiVersion: 1,
  pages: {
    '': RootRedirect,
    'sessions': SessionsView,
    'escalations': EscalationsView,
  },
  settings: {
    'agents': AgentsSettings,
    'cli-agents': CliAgentsSettings,
  },
});
