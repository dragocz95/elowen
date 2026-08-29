import { describe, expect, it } from 'vitest';
// The installed root helper is deliberately standalone ESM: it cannot import service-user-owned package
// code after sudo. This contract test imports its pure renderer directly and exercises the bytes shipped.
// @ts-expect-error the standalone deployment helper intentionally has no TypeScript declaration file
import { deploymentFrom, renderActiveConfig, renderDenyConfig } from '../../scripts/elowen-site-gateway.mjs';

const deployment = deploymentFrom({ appHost: 'agent.chetty.ai', daemonPort: 4400 });

describe('root-owned published-sites gateway helper', () => {
  it('derives one fixed wildcard from the app host', () => {
    expect(deployment).toEqual({
      appHost: 'agent.chetty.ai',
      daemonPort: 4400,
      hostnameBase: 'sites.agent.chetty.ai',
    });
    expect(() => deploymentFrom({ appHost: 'sites.evil.test', daemonPort: 4400 })).toThrow();
    expect(() => deploymentFrom({ appHost: 'agent.chetty.ai', daemonPort: 80 })).toThrow();
  });

  it('renders one wildcard gateway whose slug comes from Host and whose upstream is fixed', () => {
    const config = renderActiveConfig(deployment, 'a'.repeat(43));
    expect(config).toContain('server_name ~^(?<elowen_site_slug>');
    expect(config).toContain('\\.sites\\.agent\\.chetty\\.ai$');
    expect(config).toContain('proxy_pass http://127.0.0.1:4400/hooks/sites/s/$elowen_site_slug$request_uri;');
    expect(config).toContain('proxy_set_header X-Elowen-Site-Gateway "');
    expect(config).toContain('proxy_set_header Authorization "";');
    expect(config).not.toContain('$connection_upgrade');
    expect(config.match(/location \/ \{/g)).toHaveLength(1);
  });

  it('keeps a deny tombstone instead of letting old hostnames fall into another vhost', () => {
    const beforeCertificate = renderDenyConfig(deployment, false);
    expect(beforeCertificate).toContain('listen 80;');
    expect(beforeCertificate).toContain('return 410;');
    expect(beforeCertificate).not.toContain('listen 443 ssl;');
    expect(beforeCertificate).not.toContain('proxy_pass');

    const afterCertificate = renderDenyConfig(deployment, true);
    expect(afterCertificate).toContain('listen 443 ssl;');
    expect(afterCertificate.match(/return 410;/g)).toHaveLength(2);
    expect(afterCertificate).not.toContain('proxy_pass');
  });
});
