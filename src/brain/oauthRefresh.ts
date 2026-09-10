import type { Credential } from '@earendil-works/pi-ai';
import type { Clock } from '../shared/clock.js';

export const ANTHROPIC_OAUTH_REFRESH_LEAD_MS = 4 * 60 * 60 * 1000;
export const OAUTH_REFRESH_CHECK_INTERVAL_MS = 60_000;

interface OAuthRefreshRuntime {
  getAuth(providerId: string, overrides?: { minOAuthValidityMs?: number; signal?: AbortSignal }): Promise<unknown>;
}

interface CredentialReader {
  get(providerId: string): Credential | undefined;
}

interface OAuthRefreshLog {
  info(message: string): void;
  error(message: string): void;
}

function oauthExpiry(credential: Credential | undefined): number | undefined {
  return credential?.type === 'oauth' ? credential.expires : undefined;
}

/** Refresh Anthropic early enough to rotate its shorter-lived refresh token, even without model traffic. */
export async function refreshExpiringAnthropicCredential(
  runtime: OAuthRefreshRuntime,
  credentials: CredentialReader,
  signal?: AbortSignal,
): Promise<boolean> {
  const before = oauthExpiry(credentials.get('anthropic'));
  await runtime.getAuth('anthropic', { minOAuthValidityMs: ANTHROPIC_OAUTH_REFRESH_LEAD_MS, signal });
  const after = oauthExpiry(credentials.get('anthropic'));
  return before !== undefined && after !== undefined && after > before;
}

/** Daemon-only loop. Runners still use the shared store lock when an ordinary request triggers refresh. */
export function startOAuthCredentialRefreshLoop(deps: {
  runtime: OAuthRefreshRuntime;
  credentials: CredentialReader;
  clock: Clock;
  log: OAuthRefreshLog;
}): () => Promise<void> {
  const abort = new AbortController();
  let active: Promise<void> | undefined;
  let stopped = false;
  const refresh = () => {
    if (active || stopped) return;
    const work = refreshExpiringAnthropicCredential(deps.runtime, deps.credentials, abort.signal)
      .then((rotated) => {
        if (rotated) deps.log.info('OAuth credential refreshed for anthropic');
      })
      // PI's OAuth errors include the token endpoint response body. Keep that out of durable logs.
      .catch(() => {
        if (!abort.signal.aborted) deps.log.error('OAuth credential refresh failed for anthropic');
      });
    const completion = work.finally(() => {
      if (active === completion) active = undefined;
    });
    active = completion;
  };

  const stopInterval = deps.clock.setInterval(refresh, OAUTH_REFRESH_CHECK_INTERVAL_MS);
  refresh();
  return async () => {
    if (!stopped) {
      stopped = true;
      stopInterval();
      abort.abort();
    }
    await active;
  };
}
