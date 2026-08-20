// Entra client-credentials tokens, one cached bearer PER SCOPE.
//
// The Bot Connector and Microsoft Graph are two different audiences behind the same app registration,
// so a single cached token cannot serve both — each caller holds its own TokenSource. Refreshed ~60s
// before expiry; concurrent callers share one in-flight refresh.

export class TokenSource {
  /**
   * @param cfg plugin config — `appId`, `appPassword` and `tenantId` are read lazily on every refresh.
   * @param scope the `…/.default` scope this source requests.
   * @param overrideKey optional cfg key holding an explicit token endpoint (the e2e seam: a fake
   *   Bot Framework serves its own). Read at call time, like the rest of cfg.
   */
  constructor(cfg, scope, overrideKey = '') {
    this.cfg = cfg;
    this.scope = scope;
    this.overrideKey = overrideKey;
    this.cached = null; // { token, expiresAt }
    this.refreshing = null;
  }

  /** The OAuth token endpoint — tenant-scoped for a single-tenant app registration. */
  tokenUrl() {
    const seam = this.overrideKey ? String(this.cfg?.[this.overrideKey] ?? '').trim() : '';
    return seam || `https://login.microsoftonline.com/${encodeURIComponent(String(this.cfg?.tenantId ?? ''))}/oauth2/v2.0/token`;
  }

  /** A valid bearer, refreshed ~60s before expiry; concurrent callers share one refresh. */
  async token() {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) return this.cached.token;
    this.refreshing ??= (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: String(this.cfg?.appId ?? ''),
          client_secret: String(this.cfg?.appPassword ?? ''),
          scope: this.scope,
        });
        const res = await fetch(this.tokenUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        // The response body of a FAILED token call is echoed, so it must never carry the request back:
        // Entra reports the error, not the secret that was posted.
        if (!res.ok) throw new Error(`token endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        if (typeof data?.access_token !== 'string') throw new Error('token endpoint returned no access_token');
        const ttlSeconds = Number(data.expires_in) || 3600;
        this.cached = { token: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
        return this.cached.token;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
