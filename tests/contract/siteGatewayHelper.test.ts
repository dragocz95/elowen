import { describe, expect, it } from 'vitest';
// The installed root helper is deliberately standalone ESM: it cannot import service-user-owned package
// code after sudo. This contract test imports its pure renderer directly and exercises the bytes shipped.
// @ts-expect-error the standalone deployment helper intentionally has no TypeScript declaration file
import {
  deploymentFrom, parseHosts, renderActiveConfig, renderDenyConfig, runtimeSocketPathFor, setHostsParams, zoneFor,
} from '../../scripts/elowen-site-gateway.mjs';

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

  it('derives the Namecheap zone and preserves every returned record in a replacement request', () => {
    const zone = zoneFor(deployment);
    expect(zone).toEqual({
      sld: 'chetty',
      tld: 'ai',
      wildcardName: '*.sites.agent',
      challengeName: '_acme-challenge.sites.agent',
      challengeFqdn: '_acme-challenge.sites.agent.chetty.ai',
    });
    const records = parseHosts(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>
      <DomainDNSGetHostsResult IsUsingOurDNS="true">
        <host HostId="1" Name="@" Type="A" Address="203.0.113.7" MXPref="10" TTL="300" />
        <host HostId="2" Name="www" Type="CNAME" Address="agent.chetty.ai." MXPref="10" TTL="1800" />
      </DomainDNSGetHostsResult></CommandResponse></ApiResponse>`);
    expect(records).toHaveLength(2);
    expect(setHostsParams(zone, records)).toEqual({
      SLD: 'chetty', TLD: 'ai',
      HostName1: '@', RecordType1: 'A', Address1: '203.0.113.7', MXPref1: '10', TTL1: '300',
      HostName2: 'www', RecordType2: 'CNAME', Address2: 'agent.chetty.ai.', MXPref2: '10', TTL2: '1800',
    });
    expect(() => parseHosts('<ApiResponse Status="OK"><DomainDNSGetHostsResult IsUsingOurDNS="false" /></ApiResponse>')).toThrow();
  });

  it('supports an app on a registrable root domain and derives its sites records inside that zone', () => {
    expect(zoneFor(deploymentFrom({ appHost: 'example.com', daemonPort: 4400 }))).toEqual({
      sld: 'example',
      tld: 'com',
      wildcardName: '*.sites',
      challengeName: '_acme-challenge.sites',
      challengeFqdn: '_acme-challenge.sites.example.com',
    });
  });

  it('derives runtime socket paths only from UUID site ids', () => {
    expect(runtimeSocketPathFor('123e4567-e89b-12d3-a456-426614174000'))
      .toBe('/var/lib/elowen/site-runtime-sockets/123e4567-e89b-12d3-a456-426614174000/app.sock');
    expect(() => runtimeSocketPathFor('../../run/daemon.sock')).toThrow(/site id/);
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
