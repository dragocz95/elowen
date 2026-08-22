import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { EmailConflictError, ExternalIdentityConflictError, type User, type UserStore } from '../store/userStore.js';
import type { UserSettingStore } from '../store/userSettingStore.js';
import type { UserProjectStore } from '../store/userProjectStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { ConfigStore } from '../store/configStore.js';
import type { Clock } from '../shared/clock.js';
import { MicrosoftGraphDirectoryError, MicrosoftGraphMembership } from './msGraphMembership.js';
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
  | 'directory_unavailable'
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
  linkByEmail: boolean;
  provision: 'off' | 'tenant';
  defaultProjects: number[];
  defaultModels: string[];
  defaultModel: string;
  defaultPlugins: string[];
  disabledTools: string[];
}

interface MicrosoftSsoCatalogs {
  models(): Promise<readonly string[]>;
  plugins(): Promise<readonly string[]>;
  tools(): Promise<readonly string[]>;
}

interface ResolvedProvisioningDefaults {
  allowedModels: string[];
  defaultModel: string;
  plugins: string[];
  disabledTools: string[];
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
  projects?: ProjectStore;
  userProjects?: UserProjectStore;
  project?: { id: number };
  catalogs?: MicrosoftSsoCatalogs;
  clock: Clock;
  bus: EventBus;
  advisor?: () => AgentsAdvisorHooks | undefined;
  fetch?: typeof fetch;
  keyResolver?: (jwksUri: URL) => JWTVerifyGetKey;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function projectIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : text(value).split(',');
  return [...new Set(values
    .map((entry) => Number(text(entry)))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0))];
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

/** Tenant-scoped Microsoft OIDC with guarded linking and Graph-verified account provisioning. */
export class MicrosoftSsoService {
  private readonly fetchImpl: typeof fetch;
  private readonly keyResolver: (jwksUri: URL) => JWTVerifyGetKey;
  private readonly flows = new Map<string, Flow>();
  private readonly jwksResolvers = new Map<string, JWTVerifyGetKey>();
  private discoveryCache: { tenantId: string; value: MicrosoftOidcDiscovery; expiresAt: number } | null = null;
  private readonly graph: MicrosoftGraphMembership;
  private readonly log = logger('auth');

  constructor(private readonly d: MicrosoftSsoDependencies) {
    this.fetchImpl = d.fetch ?? fetch;
    this.keyResolver = d.keyResolver ?? ((url) => createRemoteJWKSet(url));
    this.graph = new MicrosoftGraphMembership(d.clock, this.fetchImpl);
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
      const email = text(identity.claims.email);
      let membershipCheck: Promise<void> | null = null;
      const requireDirectoryMember = (): Promise<void> => {
        membershipCheck ??= this.requireDirectoryMember(cfg, identity.objectId, subject);
        return membershipCheck;
      };
      let user = this.d.users.externalIdentity(PROVIDER, identity.tenantId, identity.objectId);
      if (user && email) {
        const emailUser = this.d.users.userByUniqueEmail(email);
        if (emailUser && emailUser.id !== user.id) {
          this.log.warn(`Microsoft SSO kept the existing subject binding for ${subject} despite an email match to user #${emailUser.id}`);
        }
      }
      if (!user && email && GUID.test(identity.objectId)) {
        const tofuUserId = this.d.userSettings?.userIdBySetting('msteamsUserId', identity.objectId) ?? null;
        const emailUser = this.d.users.userByUniqueEmail(email);
        if (tofuUserId !== null && emailUser?.id === tofuUserId) {
          if (identity.claims.acct === undefined) await requireDirectoryMember();
          try {
            user = this.d.users.linkExistingExternalIdentity({
              provider: PROVIDER,
              tenantId: identity.tenantId,
              subjectId: identity.objectId,
              userId: tofuUserId,
            }).user;
            this.publish('sso.link', subject, 'linked', user.username);
          } catch (error) {
            if (error instanceof ExternalIdentityConflictError) {
              this.publish('sso.denied', subject, 'already_linked');
              throw new MicrosoftSsoError('already_linked');
            }
            throw error;
          }
        } else if (tofuUserId !== null) {
          this.d.userSettings?.remove(tofuUserId, 'msteamsUserId');
        }
      }
      if (!user && email && this.d.users.hasAmbiguousEmail(email)) {
        this.publish('sso.denied', subject, 'ambiguous');
        throw new MicrosoftSsoError('no_account');
      }
      if (!user && cfg.linkByEmail) {
        const emailUser = email ? this.d.users.userByUniqueEmail(email) : null;
        if (emailUser) {
          if (identity.claims.acct === undefined) await requireDirectoryMember();
          try {
            user = this.d.users.linkExistingExternalIdentity({
              provider: PROVIDER,
              tenantId: identity.tenantId,
              subjectId: identity.objectId,
              userId: emailUser.id,
            }).user;
            this.publish('sso.link', subject, 'linked', user.username);
          } catch (error) {
            if (error instanceof ExternalIdentityConflictError) {
              this.publish('sso.denied', subject, 'already_linked');
              throw new MicrosoftSsoError('already_linked');
            }
            throw error;
          }
        }
      }
      if (!user && cfg.provision === 'tenant') {
        await requireDirectoryMember();
        const defaults = await this.resolveProvisioningDefaults(cfg);
        try {
          const result = this.d.users.linkExternalIdentity({
            provider: PROVIDER,
            tenantId: identity.tenantId,
            subjectId: identity.objectId,
            preferredUsername: text(identity.claims.preferred_username),
            name: text(identity.claims.name),
            email: text(identity.claims.email),
          });
          user = result.user;
          if (result.created) {
            this.assignDefaultProjects(user.id, cfg.defaultProjects);
            this.applyProvisioningDefaults(user.id, defaults);
            this.publish('sso.provision', subject, 'provisioned', user.username);
          }
        } catch (error) {
          if (error instanceof ExternalIdentityConflictError) {
            throw new MicrosoftSsoError('no_account', 'Microsoft account cannot be provisioned', {
              subject,
              detail: 'provisioning_conflict',
            });
          }
          throw error;
        }
      }
      if (!user) {
        this.publish('sso.denied', subject, 'no_account');
        throw new MicrosoftSsoError('no_account');
      }

      // Backfill an EMPTY profile e-mail from the verified claim: a signed token from our own tenant is a
      // better source than the self-service field. A non-empty one is never touched, because it may differ
      // from the UPN deliberately and it also drives Teams identity matching — silently repointing that is
      // not this code's call. An address another account already holds is left alone, not resolved by guesswork.
      if (email && !user.email.trim()) {
        try {
          user = this.d.users.setProfile(user.id, { email }) ?? user;
        } catch (error) {
          if (!(error instanceof EmailConflictError)) throw error;
          this.log.warn(`Microsoft SSO left user #${user.id} without an e-mail: ${email} already belongs to another account`);
        }
      }

      const token = this.d.users.issueToken(user.id);
      void this.d.advisor?.()?.ensureOnLogin(user.id);
      this.publish('sso.login', subject, 'linked', user.username);
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
      ({ payload } = await jwtVerify(idToken, this.jwksResolver(expected.discovery.jwks_uri), {
        algorithms: ['RS256'],
        issuer,
        audience: expected.appId,
        requiredClaims: ['exp', 'iat', 'nbf', 'tid', 'oid'],
        clockTolerance: 60,
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
      const provision = raw.ssoProvision === 'tenant' ? 'tenant' : 'off';
      return {
        appId,
        appPassword,
        tenantId,
        redirectUri: `${base}/api/auth/sso/microsoft/callback`,
        linkByEmail: raw.ssoLinkByEmail !== false,
        provision,
        defaultProjects: projectIds(raw.ssoDefaultProjects),
        defaultModels: stringList(raw.ssoDefaultModels),
        defaultModel: text(raw.ssoDefaultModel),
        defaultPlugins: stringList(raw.ssoDefaultPlugins),
        disabledTools: stringList(raw.ssoDisabledTools),
      };
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

  private jwksResolver(jwksUri: string): JWTVerifyGetKey {
    const cached = this.jwksResolvers.get(jwksUri);
    if (cached) return cached;
    const resolver = this.keyResolver(new URL(jwksUri));
    this.jwksResolvers.set(jwksUri, resolver);
    return resolver;
  }

  private async requireDirectoryMember(cfg: MicrosoftSsoConfig, objectId: string, subject: string): Promise<void> {
    let membership;
    try {
      membership = await this.graph.checkUser(cfg, objectId);
    } catch (error) {
      if (error instanceof MicrosoftGraphDirectoryError) {
        throw new MicrosoftSsoError('directory_unavailable', 'Microsoft Graph directory check failed', {
          subject,
          detail: 'directory_unavailable',
        });
      }
      throw error;
    }
    if (membership === 'guest') {
      throw new MicrosoftSsoError('guest', 'guest accounts are not allowed', { subject, detail: 'guest' });
    }
    if (membership !== 'member') {
      throw new MicrosoftSsoError('no_account', 'Microsoft directory account is not an enabled member', {
        subject,
        detail: 'not_member',
      });
    }
  }

  private assignDefaultProjects(userId: number, projectIds: number[]): void {
    if (!this.d.userProjects) return;
    for (const projectId of projectIds) {
      if (projectId !== this.d.project?.id && !this.d.projects?.get(projectId)) {
        this.log.warn(`Microsoft SSO ignored unknown default project #${projectId}`);
        continue;
      }
      this.d.userProjects.assign(userId, projectId);
    }
  }

  private async resolveProvisioningDefaults(cfg: MicrosoftSsoConfig): Promise<ResolvedProvisioningDefaults> {
    let allowedModels: string[] = [];
    let defaultModel = '';
    const requestedModels = [...new Set([...cfg.defaultModels, cfg.defaultModel].filter(Boolean))];
    if (requestedModels.length > 0) {
      const knownModels = await this.knownDefaults('model', requestedModels, this.d.catalogs?.models);
      allowedModels = cfg.defaultModels.filter((value) => knownModels.has(value));
      if (cfg.defaultModel && knownModels.has(cfg.defaultModel)) {
        if (cfg.defaultModels.length === 0 || allowedModels.includes(cfg.defaultModel)) defaultModel = cfg.defaultModel;
        else this.log.warn(`Microsoft SSO ignored default model ${cfg.defaultModel}: it is not in the configured model allow-list`);
      }
    }

    let plugins: string[] = [];
    if (cfg.defaultPlugins.length > 0) {
      const knownPlugins = await this.knownDefaults('plugin', cfg.defaultPlugins, this.d.catalogs?.plugins);
      plugins = cfg.defaultPlugins.filter((value) => knownPlugins.has(value));
    }

    let disabledTools: string[] = [];
    if (cfg.disabledTools.length > 0) {
      const knownTools = await this.knownDefaults('tool', cfg.disabledTools, this.d.catalogs?.tools);
      disabledTools = cfg.disabledTools.filter((value) => knownTools.has(value));
    }
    return { allowedModels, defaultModel, plugins, disabledTools };
  }

  private applyProvisioningDefaults(userId: number, defaults: ResolvedProvisioningDefaults): void {
    if (defaults.allowedModels.length > 0) this.d.users.setAllowedExecs(userId, defaults.allowedModels);
    if (defaults.defaultModel) this.d.users.setProfile(userId, { default_exec: defaults.defaultModel });
    if (defaults.plugins.length > 0) this.d.users.setGrantedPlugins(userId, defaults.plugins);
    if (defaults.disabledTools.length > 0) this.d.users.setDisabledTools(userId, defaults.disabledTools);
  }

  private async knownDefaults(
    kind: 'model' | 'plugin' | 'tool',
    requested: string[],
    load: (() => Promise<readonly string[]>) | undefined,
  ): Promise<Set<string>> {
    if (!load) {
      this.log.warn(`Microsoft SSO ignored configured default ${kind}s: the live catalog is unavailable`);
      return new Set();
    }
    let known: Set<string>;
    try {
      known = new Set(await load());
    } catch (error) {
      this.log.warn(`Microsoft SSO ignored configured default ${kind}s: catalog lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return new Set();
    }
    for (const value of requested) {
      if (!known.has(value)) this.log.warn(`Microsoft SSO ignored unknown default ${kind} ${value}`);
    }
    return known;
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

  /** `label` is the account name, passed wherever one has already been resolved so the activity feed
   *  names a person. A DENIAL deliberately passes none: there is no account behind it, and the external
   *  identity is exactly what an operator needs to see in that case. */
  private publish(
    kind: 'sso.login' | 'sso.provision' | 'sso.link' | 'sso.denied',
    subject: string, detail: string, label?: string,
  ): void {
    this.d.bus.publish({ type: 'auth', kind, subject, detail, label });
  }
}
