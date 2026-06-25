import type { Runner } from './runner.js';

/** Reverse-proxy provisioning: detect which web server is installed, render a vhost that proxies the
 *  domain to the local web port, and build the certbot command that adds TLS. Renderers are pure;
 *  detection takes the injected Runner. */

export type ProxyKind = 'nginx' | 'apache';

/** Which reverse proxy is installed, preferring nginx. null when neither — the wizard then offers to
 *  apt-install one. */
export async function detectProxy(r: Runner): Promise<ProxyKind | null> {
  if (await r.which('nginx')) return 'nginx';
  if (await r.which('apache2')) return 'apache';
  return null;
}

/** nginx vhost. `proxy_buffering off` + a long read timeout keep the SSE event stream (`/events`,
 *  proxied via the web's `/api`) flowing instead of being buffered/idle-closed. The `/ws/` location
 *  upgrades the terminal WebSocket straight to the daemon (the Next.js BFF can't proxy a WS upgrade),
 *  so it must come before the catch-all `/`. certbot --nginx rewrites this to add the :443 server and
 *  the HTTP→HTTPS redirect. */
export function nginxVhost(domain: string, webPort: number, daemonPort: number): string {
  return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /ws/ {
        proxy_pass http://127.0.0.1:${daemonPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    # The service worker must never be cached, or a stale sw.js keeps running and push breaks. Exact
    # match wins over the catch-all below, so only /sw.js is forced no-cache.
    location = /sw.js {
        proxy_pass http://127.0.0.1:${webPort};
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location / {
        proxy_pass http://127.0.0.1:${webPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
`;
}

/** apache vhost. Needs mod_proxy + mod_proxy_http (the wizard enables them). certbot --apache adds TLS. */
export function apacheVhost(domain: string, webPort: number): string {
  return `<VirtualHost *:80>
    ServerName ${domain}
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${webPort}/
    ProxyPassReverse / http://127.0.0.1:${webPort}/
    # SSE: do not buffer the event stream
    SetEnv proxy-sendchunked 1
    ProxyTimeout 3600
</VirtualHost>
`;
}

/** certbot invocation for the chosen plugin: obtain + install the cert and add an HTTP→HTTPS redirect,
 *  non-interactively. With an email it registers normally; without, registers email-less. */
export function certbotCommand(kind: ProxyKind, domain: string, email?: string): { cmd: string; args: string[] } {
  const plugin = kind === 'nginx' ? '--nginx' : '--apache';
  const reg = email ? ['-m', email] : ['--register-unsafely-without-email'];
  return {
    cmd: 'certbot',
    args: [plugin, '-d', domain, '--redirect', ...reg, '--agree-tos', '--non-interactive'],
  };
}
