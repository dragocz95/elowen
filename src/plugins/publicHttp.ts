import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { PluginPublicHttp, PluginPublicHttpResponse } from './api.js';

export interface PinnedPublicUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{
  address: string;
  family: number;
}>>;

const hostnameOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

export function isGlobalIpAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try { parsed = ipaddr.parse(address); } catch { return false; }
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) return false;
  return parsed.range() === 'unicast';
}

export async function resolvePublicHttpUrl(raw: string | URL, lookup: Lookup = dnsLookup): Promise<PinnedPublicUrl> {
  const url = raw instanceof URL ? new URL(raw) : new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  url.hash = '';

  const hostname = hostnameOf(url);
  const literalFamily = isIP(hostname);
  const answers = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (answers.length === 0) throw new Error('URL host did not resolve');
  if (answers.some((answer) => !isGlobalIpAddress(answer.address))) {
    throw new Error('URL resolves to a non-global address');
  }
  const selected = answers[0]!;
  if (selected.family !== 4 && selected.family !== 6) throw new Error('URL host resolved with an unsupported address family');
  return { url, address: selected.address, family: selected.family };
}

export function makePinnedRequestOptions(
  pinned: PinnedPublicUrl,
  headers: Record<string, string> = {},
): RequestOptions {
  const hostname = hostnameOf(pinned.url);
  return {
    protocol: pinned.url.protocol,
    method: 'GET',
    hostname,
    port: pinned.url.port || undefined,
    path: `${pinned.url.pathname}${pinned.url.search}`,
    servername: isIP(hostname) ? undefined : hostname,
    headers: { host: pinned.url.host, ...headers },
    lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
  };
}

function requestPinned(
  pinned: PinnedPublicUrl,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<PluginPublicHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = pinned.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request({ ...makePinnedRequestOptions(pinned, headers), signal }, (res) => {
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) responseHeaders[name] = value.join(', ');
        else if (value !== undefined) responseHeaders[name] = String(value);
      }
      resolve({
        url: pinned.url.toString(),
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders,
        body: res,
        cancel: (reason) => res.destroy(reason),
      });
    });
    req.once('error', reject);
    req.end();
  });
}

export function createPublicHttpTransport(lookup: Lookup = dnsLookup): PluginPublicHttp {
  return {
    async validate(raw) {
      return (await resolvePublicHttpUrl(raw, lookup)).url.toString();
    },
    async request(raw, options = {}) {
      const pinned = await resolvePublicHttpUrl(raw, lookup);
      return requestPinned(pinned, options.headers ?? {}, options.signal);
    },
  };
}

export const publicHttpTransport = createPublicHttpTransport();
