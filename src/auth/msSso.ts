import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { ExternalIdentityConflictError, type User, type UserStore } from '../store/userStore.js';
import type { UserSettingStore } from '../store/userSettingStore.js';
import type { ConfigStore } from '../store/configStore.js';
import type { Clock } from '../shared/clock.js';
import type { EventBus } from '../api/sse.js';
import type { AgentsAdvisorHooks } from '../plugins/api.js';
import { logger } from '../shared/logger.js';

const FLOW_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 24 * 60 * 60_000;
const MAX_FLOWS = 500;
const TOKEN_TIMEOUT_MS = 10_000;
const PROVIDER = 'msteams';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MicrosoftSsoErrorCode =
  | 'not_found'
  | 'not_setup'
  | 'state_expired'
  | 'no_account'
  | 'already_linked'
  | 'tenant_mismatch'
  | 'guest'
  | 'sso_failed'
  | 'too_many_flows';

export class MicrosoftSsoError extends Error {
  constructor(
    public readonly code: MicrosoftSsoErrorCode,
    message: string = code,
    public readonly audit?: { subject: string; detail: string },
  ) {
    super(message);
    this.name = 'MicrosoftSsoError';
  }
}

interface MicrosoftSsoConfig {
  appId: string;
  appPassword: string;
  tenantId: string;
  redirectUri: string;
}

export interface MicrosoftOidcDiscovery {
  issuer: string;
  token_endpoint: string;
  authorization_endpoint: string;
  jwks_uri: string;
}

interface Flow {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
  next: string;
}

export interface VerifiedMicrosoftIdentity {
  tenantId: string;
  objectId: string;
  claims: JWTPayload;
}

export interface MicrosoftSsoDependencies {
  config: ConfigStore;
  users: UserStore;
  userSettings?: UserSettingStore;
  clock: Clock;
  bus: EventBus;
  advisor?: () => AgentsAdvisorHooks | undefined;
  fetch?: typeof fetch;
  keyResolver?: (jwksUri: URL) => JWTVerifyGetKey;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedKey(value: unknown): string {
  return text(value).toLowerCase();
}

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function s256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function validExternalSubject(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeNext(value: unknown): string {
  const next = text(value);
  return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !/[\u0000-\u001f\u007f]/.test(next)
    ? next
    : '/';
}

/** Tenant-scoped Microsoft OIDC for existing Elowen identities only. Account provisioning deliberately
 * lives outside this phase: a subject without a durable or Teams TOFU binding is always denied. */
export class MicrosoftSsoService {
  private readonly fetchImpl: typeof fetch;
  private readonly keyResolver: (jwksUri: URL) => JWTVerifyGetKey;
  private readonly flows = new Map<string, Flow>();
  private discoveryCache: { tenantId: string; value: MicrosoftOidcDiscovery; expiresAt: number } | null = null;
  private readonly log = logger('auth');

  constructor(private readonly d: MicrosoftSsoDependencies) {
    this.fetchImpl = d.fetch ?? fetch;
    this.keyResolver = d.keyResolver ?? ((url) => createRemoteJWKSet(url));
  }

  providers(): { id: 'msteams'; label: 'Microsoft' }[] {
    return this.activeConfig() && this.d.users.count() > 0 ? [{ id: PROVIDER, label: 'Microsoft' }] : [];
  }

  async start(input: { next?: string } = {}): Promise<{ flowId: string; authorizationUrl: string }> {
    const cfg = this.requireActiveConfig();
    if (this.d.users.count() === 0) throw new MicrosoftSsoError('not_setup');
    this.sweepFlows();
    if (this.flows.size >= MAX_FLOWS) throw new MicrosoftSsoError('too_many_flows');

    const flowId = randomBase64Url();
    const flow: Flow = {
      state: randomBase64Url(),
      nonce: randomBase64Url(),
      codeVerifier: randomBase64Url(64),
      createdAt: this.d.clock.now(),
      redirectUri: cfg.redirectUri,
      next: safeNext(input.next),
    };
    this.flows.set(flowId, flow);
    try {
      const discovery = await this.discovery(cfg.tenantId);
      const url = new URL(discovery.authorization_endpoint);
      url.searchParams.set('client_id', cfg.appId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', cfg.redirectUri);
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('scope', 'openid profile email');
      url.searchParams.set('state', flow.state);
      url.searchParams.set('nonce', flow.nonce);
      url.searchParams.set('code_challenge', s256(flow.codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
      return { flowId, authorizationUrl: url.toString() };
    } catch (error) {
      this.flows.delete(flowId);
      throw error;
    }
  }

  async callback(input: { flowId: string; state: string; code: string }): Promise<{ token: string; user: User; tokenTtlDays: number; next: string }> {
    const cfg = this.requireActiveConfig();
    if (this.d.users.count() === 0) throw new MicrosoftSsoError('not_setup');
    const flow = this.consumeFlow(input.flowId, input.state);
    try {
      const discovery = await this.discovery(cfg.tenantId);
      const idToken = await this.exchangeCode(discovery.token_endpoint, cfg, flow, input.code);
      const identity = await this.verifyIdToken(idToken, {
        appId: cfg.appId,
        tenantId: cfg.tenantId,
        nonce: flow.nonce,
        discovery,
      });

      const subject = `${identity.objectId}@${identity.tenantId}`;
      let user = this.d.users.externalIdentity(PROVIDER, identity.tenantId, identity.objectId);
      if (!user && GUID.test(identity.objectId)) {
        const tofuUserId = this.d.userSettings?.userIdBySetting('msteamsUserId', identity.objectId) ?? null;
        if (tofuUserId !== null) {
          try {
            user = this.d.users.linkExistingExternalIdentity({
              provider: PROVIDER,
              tenantId: identity.tenantId,
              subjectId: identity.objectId,
              userId: tofuUserId,
            }).user;
            this.publish('sso.link', subject, 'linked');
          } catch (error) {
            if (error instanceof ExternalIdentityConflictError) {
              this.publish('sso.denied', subject, 'already_linked');
              throw new MicrosoftSsoError('already_linked');
            }
            throw error;
          }
        }
      }
      if (!user) {
        this.publish('sso.denied', subject, 'no_account');
        throw new MicrosoftSsoError('no_account');
      }

      const token = this.d.users.issueToken(user.id);
      void this.d.advisor?.()?.ensureOnLogin(user.id);
      this.publish('sso.login', subject, 'linked');
      return { token, user, tokenTtlDays: this.d.config.get().security.tokenTtlDays, next: flow.next };
    } catch (error) {
      if (error instanceof MicrosoftSsoError) {
        if (error.audit) this.publish('sso.denied', error.audit.subject, error.audit.detail);
        this.log.warn(`Microsoft SSO callback failed: ${error.code}`);
      }
      throw error;
    }
  }

  async verifyIdToken(idToken: string, expected: {
    appId: string;
    tenantId: string;
    nonce: string;
    discovery: MicrosoftOidcDiscovery;
  }): Promise<VerifiedMicrosoftIdentity> {
    const tenantId = normalizedKey(expected.tenantId);
    const issuer = expected.discovery.issuer.replace(/\{tenantid\}/gi, tenantId);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keyResolver(new URL(expected.discovery.jwks_uri)), {
        algorithms: ['RS256'],
        issuer,
        audience: expected.appId,
        clockTolerance: 300,
        currentDate: new Date(this.d.clock.now()),
      }));
    } catch {
      throw new MicrosoftSsoError('sso_failed', 'id token verification failed');
    }

    if (payload.nonce !== expected.nonce) throw new MicrosoftSsoError('sso_failed', 'id token nonce mismatch');
    const tokenTenant = normalizedKey(payload.tid);
    const objectId = normalizedKey(payload.oid);
    if (!validExternalSubject(objectId)) throw new MicrosoftSsoError('sso_failed', 'id token oid is invalid');
    const subject = `${objectId}@${tokenTenant || 'unknown'}`;
    if (!tokenTenant || tokenTenant !== tenantId) {
      throw new MicrosoftSsoError('tenant_mismatch', 'id token tenant mismatch', { subject, detail: 'tenant_mismatch' });
    }
    if (payload.acct !== undefined && payload.acct !== 0 && payload.acct !== '0') {
      throw new MicrosoftSsoError('guest', 'guest accounts are not allowed', { subject, detail: 'guest' });
    }
    return { tenantId: tokenTenant, objectId, claims: payload };
  }

  private activeConfig(): MicrosoftSsoConfig | null {
    const root = this.d.config.get();
    if (!root.plugins.enabled.includes(PROVIDER)) return null;
    const raw = this.d.config.pluginConfig(PROVIDER);
    const appId = text(raw.appId);
    const appPassword = text(raw.appPassword);
    const tenantId = normalizedKey(raw.tenantId);
    if (!appId || !appPassword || !tenantId || raw.ssoEnabled !== true) return null;
    const redirectBase = text(raw.ssoRedirectBase);
    try {
      const url = new URL(redirectBase);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid');
      const base = url.toString().replace(/\/$/, '');
      return { appId, appPassword, tenantId, redirectUri: `${base}/api/auth/sso/microsoft/callback` };
    } catch {
      this.log.warn('Microsoft SSO disabled: ssoRedirectBase must be an absolute HTTPS URL');
      return null;
    }
  }

  private requireActiveConfig(): MicrosoftSsoConfig {
    const cfg = this.activeConfig();
    if (!cfg) throw new MicrosoftSsoError('not_found');
    return cfg;
  }

  private sweepFlows(): void {
    const now = this.d.clock.now();
    for (const [id, flow] of this.flows) {
      if (flow.createdAt + FLOW_TTL_MS <= now) this.flows.delete(id);
    }
  }

  private consumeFlow(flowId: string, state: string): Flow {
    const flow = this.flows.get(flowId);
    if (flow) this.flows.delete(flowId);
    if (!flow || flow.createdAt + FLOW_TTL_MS <= this.d.clock.now() || flow.state !== state) {
      throw new MicrosoftSsoError('state_expired');
    }
    return flow;
  }

  private async discovery(tenantId: string): Promise<MicrosoftOidcDiscovery> {
    const cached = this.discoveryCache;
    if (cached && cached.tenantId === tenantId && cached.expiresAt > this.d.clock.now()) return cached.value;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`;
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`discovery HTTP ${response.status}`);
      const raw = await response.json() as Partial<MicrosoftOidcDiscovery>;
      const value = {
        issuer: text(raw.issuer),
        token_endpoint: text(raw.token_endpoint),
        authorization_endpoint: text(raw.authorization_endpoint),
        jwks_uri: text(raw.jwks_uri),
      };
      if (!value.issuer || !value.token_endpoint || !value.authorization_endpoint || !value.jwks_uri) {
        throw new Error('incomplete discovery document');
      }
      this.discoveryCache = { tenantId, value, expiresAt: this.d.clock.now() + DISCOVERY_TTL_MS };
      return value;
    } catch {
      this.discoveryCache = null;
      throw new MicrosoftSsoError('sso_failed', 'Microsoft discovery failed');
    }
  }

  private async exchangeCode(tokenEndpoint: string, cfg: MicrosoftSsoConfig, flow: Flow, code: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.appId,
      client_secret: cfg.appPassword,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.codeVerifier,
    });
    try {
      const response = await this.fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`token HTTP ${response.status}`);
      const payload = await response.json() as { id_token?: unknown };
      if (typeof payload.id_token !== 'string' || !payload.id_token) throw new Error('missing id_token');
      return payload.id_token;
    } catch {
      throw new MicrosoftSsoError('sso_failed', 'Microsoft token exchange failed');
    }
  }

  private publish(kind: 'sso.login' | 'sso.link' | 'sso.denied', subject: string, detail: string): void {
    this.d.bus.publish({ type: 'auth', kind, subject, detail });
  }
}
