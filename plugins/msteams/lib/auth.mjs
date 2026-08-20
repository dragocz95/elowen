// Inbound webhook authentication: every Bot Framework callback carries a JWT signed by Microsoft's
// bot connector service. We verify it against the service's JWKS (discovered from its OpenID metadata),
// pin the audience to OUR app id and the issuer to the connector service, and cross-check the token's
// serviceUrl claim against the activity — a token minted for another bot or endpoint is rejected.
//
// Note the issuer is the CONNECTOR service (api.botframework.com) even for a single-tenant bot: the
// tenant-scoped issuer applies to user tokens, never to service-to-bot callbacks.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const DEFAULT_OPENID_METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const ISSUER = 'https://api.botframework.com';

/** Build the verifier once per adapter: the JWKS handle caches keys (jose re-fetches on unknown kid
 *  with its own cooldown), and the metadata document is fetched lazily on first use. */
export function makeTokenVerifier(cfg, logger) {
  const metadataUrl = String(cfg.openIdMetadataUrl ?? '').trim() || DEFAULT_OPENID_METADATA;
  let jwks = null;

  const loadJwks = async () => {
    if (jwks) return jwks;
    const res = await fetch(metadataUrl);
    if (!res.ok) throw new Error(`OpenID metadata fetch failed (${res.status})`);
    const meta = await res.json();
    if (typeof meta?.jwks_uri !== 'string' || !meta.jwks_uri) throw new Error('OpenID metadata carries no jwks_uri');
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    return jwks;
  };

  /** True when `authHeader` proves the request came from Microsoft's connector for OUR bot and the
   *  activity's serviceUrl. Any failure (missing/expired/foreign token) is a quiet false — the caller
   *  answers 401 without detail. */
  return async function verify(authHeader, activity) {
    const token = String(authHeader ?? '').startsWith('Bearer ') ? String(authHeader).slice(7) : '';
    if (!token) return false;
    try {
      const keys = await loadJwks();
      const { payload } = await jwtVerify(token, keys, {
        audience: String(cfg.appId ?? ''),
        issuer: ISSUER,
        clockTolerance: 300,
      });
      // The connector stamps the serviceUrl it will accept replies on; an activity claiming a different
      // one is spoofed (or replayed against another region) — reject.
      const claimed = typeof payload.serviceUrl === 'string' ? payload.serviceUrl.replace(/\/+$/, '') : '';
      const actual = typeof activity?.serviceUrl === 'string' ? activity.serviceUrl.replace(/\/+$/, '') : '';
      if (claimed && actual && claimed !== actual) return false;
      return true;
    } catch (e) {
      logger?.warn?.(`webhook token rejected: ${e?.message ?? e}`);
      // A metadata/JWKS fetch hiccup must not cache a broken handle forever.
      if (!(e instanceof Error) || /metadata|jwks/i.test(e.message)) jwks = null;
      return false;
    }
  };
}
