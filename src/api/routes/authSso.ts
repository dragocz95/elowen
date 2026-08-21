import { z } from 'zod';
import { MicrosoftSsoError } from '../../auth/msSso.js';
import { clientOrigin } from '../clientIp.js';
import type { ElowenApp, RouteContext } from '../context.js';
import { parseBody } from '../validation.js';

const startSchema = z.object({ next: z.string().max(2048).optional() }).strict();
const callbackSchema = z.object({
  flowId: z.string().min(1).max(255),
  state: z.string().min(1).max(255),
  code: z.string().min(1).max(16_384),
}).strict();

function errorStatus(error: MicrosoftSsoError): 400 | 403 | 404 | 409 | 429 {
  switch (error.code) {
    case 'not_found': return 404;
    case 'already_linked': return 409;
    case 'too_many_flows': return 429;
    case 'no_account':
    case 'not_setup':
    case 'tenant_mismatch':
    case 'guest': return 403;
    default: return 400;
  }
}

/** Public Microsoft SSO endpoints. The service owns every secret and identity decision; routes only
 * validate bounded JSON, apply the shared login limiter, and expose stable error codes to the BFF. */
export function registerAuthSsoRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, microsoftSso, loginRateLimiter } = ctx;
  if (!microsoftSso) return;

  app.get('/auth/sso/providers', (c) => c.json(microsoftSso.providers()));

  app.post('/auth/sso/msteams/start', async (c) => {
    const ip = clientOrigin(c, d.config.get().security.trustProxy).value;
    if (loginRateLimiter.limited(ip, d.clock.now())) {
      return c.json({ error: 'too_many_flows' }, 429);
    }
    const body = await parseBody(c, startSchema);
    try {
      return c.json(await microsoftSso.start(body));
    } catch (error) {
      if (error instanceof MicrosoftSsoError) return c.json({ error: error.code }, errorStatus(error));
      throw error;
    }
  });

  app.post('/auth/sso/msteams/callback', async (c) => {
    const ip = clientOrigin(c, d.config.get().security.trustProxy).value;
    if (loginRateLimiter.limited(ip, d.clock.now())) {
      return c.json({ error: 'too_many_flows' }, 429);
    }
    const body = await parseBody(c, callbackSchema);
    try {
      return c.json(await microsoftSso.callback(body));
    } catch (error) {
      if (error instanceof MicrosoftSsoError) return c.json({ error: error.code }, errorStatus(error));
      throw error;
    }
  });
}
