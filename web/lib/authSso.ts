export const SSO_FLOW_COOKIE = 'elowen_sso';
export const SSO_FLOW_TTL_SECONDS = 600;

// Module-local: the list only backs `SsoErrorCode` and the narrowing below. Callers take the type.
const SSO_ERROR_CODES = [
  'no_account',
  'denied',
  'already_linked',
  'directory_unavailable',
  'tenant_mismatch',
  'state_expired',
  'not_setup',
  'sso_failed',
] as const;

export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

/** Accept only a same-origin path. Backslashes are rejected because browsers may normalize them into
 * slashes while resolving a Location header, turning an apparently relative value into `//host`. */
export function safeSsoNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}

export function ssoErrorCode(value: unknown): SsoErrorCode {
  if (value === 'guest') return 'denied';
  return typeof value === 'string' && (SSO_ERROR_CODES as readonly string[]).includes(value)
    ? value as SsoErrorCode
    : 'sso_failed';
}
