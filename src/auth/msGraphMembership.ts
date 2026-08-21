import type { Clock } from '../shared/clock.js';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_RESERVE_MS = 60_000;

export type MicrosoftDirectoryMembership = 'member' | 'guest' | 'disabled' | 'not_member';

export class MicrosoftGraphDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrosoftGraphDirectoryError';
  }
}

export interface MicrosoftGraphMembershipConfig {
  appId: string;
  appPassword: string;
  tenantId: string;
}

export class MicrosoftGraphMembership {
  private tokenCache: { tenantId: string; appId: string; accessToken: string; expiresAt: number } | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async checkUser(config: MicrosoftGraphMembershipConfig, objectId: string): Promise<MicrosoftDirectoryMembership> {
    try {
      const accessToken = await this.accessToken(config);
      const url = `${GRAPH_BASE}/users/${encodeURIComponent(objectId)}?$select=id,userType,accountEnabled`;
      const response = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Graph user HTTP ${response.status}`);
      const raw = await response.json() as { id?: unknown; userType?: unknown; accountEnabled?: unknown };
      if (typeof raw.id !== 'string' || raw.id.trim().toLowerCase() !== objectId) return 'not_member';
      if (raw.userType === 'Guest') return 'guest';
      if (raw.userType !== 'Member') return 'not_member';
      return raw.accountEnabled === true ? 'member' : 'disabled';
    } catch (error) {
      if (error instanceof MicrosoftGraphDirectoryError) throw error;
      throw new MicrosoftGraphDirectoryError(error instanceof Error ? error.message : 'Microsoft Graph request failed');
    }
  }

  private async accessToken(config: MicrosoftGraphMembershipConfig): Promise<string> {
    const cached = this.tokenCache;
    if (cached && cached.tenantId === config.tenantId && cached.appId === config.appId && cached.expiresAt > this.clock.now()) {
      return cached.accessToken;
    }

    try {
      const response = await this.fetchImpl(
        `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.appId,
            client_secret: config.appPassword,
            grant_type: 'client_credentials',
            scope: GRAPH_SCOPE,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`Graph token HTTP ${response.status}`);
      const raw = await response.json() as { access_token?: unknown; expires_in?: unknown };
      if (typeof raw.access_token !== 'string' || !raw.access_token) throw new Error('Graph token response is missing access_token');
      const expiresIn = Number(raw.expires_in);
      const expiresAt = Number.isFinite(expiresIn)
        ? this.clock.now() + Math.max(0, expiresIn * 1000 - TOKEN_EXPIRY_RESERVE_MS)
        : this.clock.now();
      this.tokenCache = { tenantId: config.tenantId, appId: config.appId, accessToken: raw.access_token, expiresAt };
      return raw.access_token;
    } catch (error) {
      this.tokenCache = null;
      throw new MicrosoftGraphDirectoryError(error instanceof Error ? error.message : 'Microsoft Graph token request failed');
    }
  }
}
