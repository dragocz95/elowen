/** Normalize a deployment-owned browser URL for plugin callbacks. The input must come from trusted install
 * metadata or a local development default, never from request Host/Origin/forwarded headers. */
export function trustedPublicWebUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/g, '');
    url.pathname = path || '/';
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}
