import { describe, it, expect } from 'vitest';
import { webhookProxyStatus } from '../../src/api/webhookProxy.js';

const PATHS = ['/etc/nginx/sites-enabled/elowen.conf', '/etc/apache2/sites-enabled/elowen.conf'];
const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;

describe('webhookProxyStatus', () => {
  it('is silent (null) when no managed vhost is readable — Docker/localhost/custom proxies', () => {
    expect(webhookProxyStatus(reader({}), PATHS)).toBeNull();
  });

  it('reports a managed nginx vhost that routes /hooks/', () => {
    const files = { [PATHS[0]!]: 'server {\n  location /hooks/ {\n    proxy_pass http://127.0.0.1:4400;\n  }\n}' };
    expect(webhookProxyStatus(reader(files), PATHS)).toEqual({ path: PATHS[0], routesHooks: true });
  });

  it('flags a pre-hooks vhost (installed before the route existed, kept alive by in-place updates)', () => {
    const files = { [PATHS[0]!]: 'server {\n  location /ws/ { proxy_pass http://127.0.0.1:4400; }\n  location / { proxy_pass http://127.0.0.1:4500; }\n}' };
    expect(webhookProxyStatus(reader(files), PATHS)).toEqual({ path: PATHS[0], routesHooks: false });
  });

  it('falls through to the apache vhost when nginx has none', () => {
    const files = { [PATHS[1]!]: 'ProxyPass /hooks/ http://127.0.0.1:4400/hooks/' };
    expect(webhookProxyStatus(reader(files), PATHS)).toEqual({ path: PATHS[1], routesHooks: true });
  });
});
