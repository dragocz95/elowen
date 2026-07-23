import { readFileSync } from 'node:fs';

/** Whether the install's MANAGED reverse-proxy vhost routes `/hooks/` (plugin webhooks) to the daemon.
 *  Installs provisioned before the route existed keep their old vhost forever — `elowen update` runs as
 *  the service user and deliberately cannot touch /etc — so the readiness check surfaces the gap with
 *  the fix instead. Only the vhosts our own installer writes are inspected; a hand-rolled proxy, Docker
 *  or localhost install has nothing recognizable to verify and the check stays silent. */
export interface WebhookProxyStatus {
  path: string;
  routesHooks: boolean;
}

const MANAGED_VHOSTS = [
  '/etc/nginx/sites-enabled/elowen.conf',
  '/etc/apache2/sites-enabled/elowen.conf',
];

function readOrNull(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** The first readable managed vhost and whether it mentions `/hooks/`; null when none is readable. */
export function webhookProxyStatus(read: (path: string) => string | null = readOrNull, paths: string[] = MANAGED_VHOSTS): WebhookProxyStatus | null {
  for (const path of paths) {
    const text = read(path);
    if (text !== null) return { path, routesHooks: text.includes('/hooks/') };
  }
  return null;
}
