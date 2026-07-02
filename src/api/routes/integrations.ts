import { detectClis } from '../../integrations/cliDetection.js';
import { detectGithubAuth } from '../../integrations/github/auth.js';
import type { OrcaApp, RouteContext } from '../context.js';

/** External-integration status surface: CLI detection and GitHub auth posture. */
export function registerIntegrationRoutes(app: OrcaApp, ctx: RouteContext): void {
  const { d } = ctx;
  app.get('/integrations/cli-status', async c => {
    const cfg = d.config.get();
    const detectCtx = {
      configPersisted: d.config.hasSettings(),
      hasApiKey: cfg.autopilot.apiKeySet,
      hasCustomSetup: cfg.customModels.length > 0 || cfg.hiddenPresets.length > 0,
    };
    return c.json(await detectClis(detectCtx));
  });

  // GitHub auth posture for the PR-native workflow — whether a push would succeed (via a stored token
  // or gh's own login) and as whom. The token value is never exposed, only whether one is set.
  app.get('/integrations/github-status', c => c.json(detectGithubAuth(!!d.config.ghToken())));
}
