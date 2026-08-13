import { json } from './http.js';
import { detectGithubAuth } from '../integrations/githubAuth.js';
import { detectClis } from '../lib/cliDetection.js';
import type { PluginContext } from '../../../../src/plugins/api.js';
import type { AgentsPluginConfig } from '../config.js';

/** The external-integration status surface for the subsystem this plugin owns, ROOT-mounted at the
 *  grandfathered '/integrations/*' paths (install wizard, install smoke, the settings sections).
 *
 *  Both probes describe THIS plugin's own dependencies — the agent CLIs it spawns and the GitHub auth a
 *  mission PR would push with — so core neither runs them nor holds the token they report on. Not gated
 *  on the task domain: whether `gh` is installed is true regardless of who owns tasks, and a 503 there
 *  would say "missions unavailable" about a question that has nothing to do with missions.
 *
 *  access:'user' matches what these paths answered as core routes (any authenticated caller; the
 *  daemon's bearer guard runs first, and the setup-mode carve-out keeps the tokenless first-run probe
 *  working). Neither response carries a secret: the GitHub probe reports only WHETHER a token is set. */
export function registerIntegrationsApi(ctx: PluginContext, pluginConfig: () => AgentsPluginConfig): void {
  ctx.registerApiRoute({
    rootMount: '/integrations/cli-status', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return json({ error: 'not found' }, 404);
      const host = ctx.host.config();
      const cfg = host.get();
      return json(await detectClis({
        configPersisted: host.hasSettings(),
        // Relay creds resolve either from a legacy top-level key or a picked brain provider — either
        // counts as "configured" for the setup hint.
        hasApiKey: host.autopilotRelay() !== null,
        hasCustomSetup: cfg.customModels.length > 0 || cfg.hiddenPresets.length > 0,
      }));
    },
  });

  ctx.registerApiRoute({
    rootMount: '/integrations/github-status', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return json({ error: 'not found' }, 404);
      // Whether a push would succeed (via a stored token or gh's own login) and as whom. The token is
      // read from this plugin's own config slice — the value never leaves the daemon.
      return json(detectGithubAuth(pluginConfig().ghToken !== ''));
    },
  });
}
