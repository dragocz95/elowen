import { AsyncLocalStorage } from 'node:async_hooks';
import botframeworkConnector from 'botframework-connector';
import userTokenClientModule from 'botframework-connector/lib/auth/userTokenClientImpl.js';

const { MicrosoftAppCredentials } = botframeworkConnector;
const { UserTokenClientImpl } = userTokenClientModule;

const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType';
const PROVIDER = 'msteams';
const CHANNEL = 'msteams';

export class TeamsAccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TeamsAccountError';
    this.code = code;
  }
}

const normalized = (value) => String(value ?? '').trim().toLowerCase();

function claimsOf(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) throw new Error('missing payload');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new TeamsAccountError('invalid_token', 'Microsoft returned an invalid access token.');
  }
}

function preferredUsername(profile) {
  const principal = String(profile.userPrincipalName || profile.mail || '').trim();
  return principal.includes('@') ? principal.slice(0, principal.indexOf('@')) : (principal || profile.displayName || profile.id);
}

function safeProfile(profile) {
  return {
    id: String(profile?.id ?? ''),
    displayName: String(profile?.displayName ?? ''),
    userPrincipalName: String(profile?.userPrincipalName ?? ''),
    mail: String(profile?.mail ?? ''),
    accountEnabled: profile?.accountEnabled === true,
    userType: String(profile?.userType ?? ''),
  };
}

/**
 * Delegated Microsoft authentication isolated from the Teams transport. Bot Framework Token Service owns
 * access and refresh tokens; this module holds a delegated token only for the duration of one request,
 * checks the immutable Entra object id against both the activity and Graph, then hands only identity data
 * to the core account seam.
 */
export class TeamsAccountLinking {
  constructor(cfg, externalUsers, logger, deps = {}) {
    this.cfg = cfg;
    this.externalUsers = externalUsers;
    this.log = logger;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.turn = new AsyncLocalStorage();
    if (deps.tokenClient) {
      this.tokens = deps.tokenClient;
    } else {
      const credentials = new MicrosoftAppCredentials(cfg.appId, cfg.appPassword, cfg.tenantId);
      this.tokens = new UserTokenClientImpl(cfg.appId, credentials, deps.tokenServiceEndpoint ?? 'https://api.botframework.com');
    }
  }

  get enabled() { return this.cfg.accountLinking === true; }

  validateActivity(activity) {
    const tenantId = normalized(activity?.conversation?.tenantId || activity?.channelData?.tenant?.id);
    const configuredTenant = normalized(this.cfg.tenantId);
    if (!tenantId || tenantId !== configuredTenant) {
      throw new TeamsAccountError('wrong_tenant', 'This Microsoft account does not belong to the configured organisation.');
    }
    const teamsUserId = String(activity?.from?.id ?? '').trim();
    const objectId = normalized(activity?.from?.aadObjectId);
    if (!teamsUserId || !objectId) {
      throw new TeamsAccountError('missing_identity', 'Microsoft Teams did not provide a verifiable Entra identity.');
    }
    return { tenantId: configuredTenant, teamsUserId, objectId };
  }

  async tokenForUser(teamsUserId, magicCode) {
    const response = await this.tokens.getUserToken(
      String(teamsUserId),
      String(this.cfg.oauthConnectionName),
      CHANNEL,
      magicCode ? String(magicCode) : undefined,
    );
    return typeof response?.token === 'string' && response.token ? response.token : null;
  }

  async tokenFor(activity, magicCode) {
    const { teamsUserId } = this.validateActivity(activity);
    return this.tokenForUser(teamsUserId, magicCode);
  }

  async profileFor(token, identity) {
    let response;
    try {
      response = await this.fetch(GRAPH_ME, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new TeamsAccountError('graph_unavailable', 'Microsoft could not verify this account. Please try again.');
    }
    if (!response?.ok) {
      throw new TeamsAccountError('graph_rejected', 'Microsoft could not verify this account. Please sign in again.');
    }
    let profile;
    try { profile = await response.json(); } catch {
      throw new TeamsAccountError('graph_rejected', 'Microsoft could not verify this account. Please sign in again.');
    }
    if (normalized(profile?.id) !== identity.objectId) {
      throw new TeamsAccountError('identity_mismatch', 'The signed-in Microsoft account does not match the Teams sender.');
    }
    if (String(profile?.userType ?? '').toLowerCase() !== 'member') {
      throw new TeamsAccountError('not_member', 'Guest and external Microsoft accounts cannot use this service.');
    }
    if (profile?.accountEnabled !== true) {
      throw new TeamsAccountError('disabled', 'This Microsoft account is disabled.');
    }
    return safeProfile(profile);
  }

  async authenticate(activity, { magicCode } = {}) {
    const identity = this.validateActivity(activity);
    const token = await this.tokenForUser(identity.teamsUserId, magicCode);
    if (!token) return { status: 'sign_in_required' };

    const claims = claimsOf(token);
    if (normalized(claims.tid) !== identity.tenantId) {
      throw new TeamsAccountError('wrong_tenant', 'This Microsoft account does not belong to the configured organisation.');
    }
    if (!claims.oid || normalized(claims.oid) !== identity.objectId) {
      throw new TeamsAccountError('identity_mismatch', 'The signed-in Microsoft account does not match the Teams sender.');
    }

    const profile = await this.profileFor(token, identity);
    const result = this.externalUsers.linkOrProvision({
      provider: PROVIDER,
      tenantId: identity.tenantId,
      subjectId: identity.objectId,
      preferredUsername: preferredUsername(profile),
      name: profile.displayName,
      email: profile.mail || profile.userPrincipalName,
    });
    return { status: 'authorized', user: result.user, created: result.created };
  }

  /** Establish the only context from which delegated Microsoft tools may load a bearer token. */
  runWithActivity(activity, fn) {
    const identity = this.validateActivity(activity);
    const kind = String(activity?.conversation?.conversationType ?? 'personal');
    return this.turn.run({ activity, identity, kind, session: null }, fn);
  }

  /** Return one verified delegated token/profile for the current personal Teams turn. */
  async delegatedSession(currentIdentity) {
    const scoped = this.turn.getStore();
    if (!scoped || scoped.kind !== 'personal') {
      throw new TeamsAccountError('personal_turn_required', 'Microsoft 365 tools are available only in a personal Microsoft Teams chat.');
    }
    if (currentIdentity?.platform !== 'msteams' || normalized(currentIdentity?.userId) !== scoped.identity.objectId) {
      throw new TeamsAccountError('turn_identity_mismatch', 'Microsoft 365 access is not available outside the verified Teams sender turn.');
    }
    scoped.session ??= (async () => {
      const token = await this.tokenForUser(scoped.identity.teamsUserId);
      if (!token) throw new TeamsAccountError('sign_in_required', 'Microsoft sign-in expired. Send a new message in the personal Teams chat and sign in again.');
      const profile = await this.profileFor(token, scoped.identity);
      return { token, profile, subjectId: scoped.identity.objectId, tenantId: scoped.identity.tenantId };
    })();
    return scoped.session;
  }

  bindingFor(objectId) {
    const tenantId = normalized(this.cfg.tenantId);
    const subjectId = normalized(objectId);
    if (!subjectId) return null;
    if (typeof this.externalUsers.describe === 'function') return this.externalUsers.describe(PROVIDER, tenantId, subjectId);
    const user = this.externalUsers.resolve(PROVIDER, tenantId, subjectId);
    return user ? { user } : null;
  }

  async accountStatus(person) {
    const objectId = normalized(person?.aad);
    const teamsUserId = String(person?.id ?? '').trim();
    const binding = this.bindingFor(objectId);
    if (!objectId || !teamsUserId) return { linked: Boolean(binding), ...(binding ?? {}), signedIn: false };
    const token = await this.tokenForUser(teamsUserId).catch(() => null);
    if (!token) return { linked: Boolean(binding), ...(binding ?? {}), signedIn: false };
    try {
      const profile = await this.profileFor(token, { objectId, tenantId: normalized(this.cfg.tenantId), teamsUserId });
      return { linked: Boolean(binding), ...(binding ?? {}), signedIn: true, verifiedAt: new Date().toISOString(), profile };
    } catch (error) {
      this.log?.warn?.(`msteams delegated account status: ${error?.message ?? error}`);
      return { linked: Boolean(binding), ...(binding ?? {}), signedIn: false };
    }
  }

  async linkExisting(person, userId, replace = false) {
    if (typeof this.externalUsers.linkExisting !== 'function') {
      throw new TeamsAccountError('core_upgrade_required', 'This Elowen version cannot bind an Entra identity to an existing account yet.');
    }
    const objectId = normalized(person?.aad);
    if (!objectId) throw new TeamsAccountError('missing_identity', 'This Teams person has no Entra object ID.');
    return this.externalUsers.linkExisting({
      provider: PROVIDER,
      tenantId: normalized(this.cfg.tenantId),
      subjectId: objectId,
      userId: Number(userId),
      replace: replace === true,
    });
  }

  async signOutPerson(person) {
    const teamsUserId = String(person?.id ?? '').trim();
    if (!teamsUserId) throw new TeamsAccountError('missing_identity', 'This Teams person has no Teams account ID.');
    await this.tokens.signOutUser(teamsUserId, String(this.cfg.oauthConnectionName), CHANNEL);
  }

  async signInActivity(activity, text, buttonTitle) {
    this.validateActivity(activity);
    const resource = await this.tokens.getSignInResource(String(this.cfg.oauthConnectionName), activity);
    if (!resource?.signInLink) throw new TeamsAccountError('sign_in_unavailable', 'Microsoft sign-in is temporarily unavailable.');
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.oauth',
        content: {
          text,
          connectionName: String(this.cfg.oauthConnectionName),
          buttons: [{ type: 'signin', title: buttonTitle, value: resource.signInLink }],
          ...(resource.tokenExchangeResource ? { tokenExchangeResource: resource.tokenExchangeResource } : {}),
        },
      }],
    };
  }
}
