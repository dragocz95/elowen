import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { MicrosoftSsoError, MicrosoftSsoService } from '../../src/auth/msSso.js';
import { createServer } from '../../src/api/server.js';
import { EventBus } from '../../src/api/sse.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserSettingStore } from '../../src/store/userSettingStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeClock } from '../../src/shared/clock.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

const NOW = 2_000_000_000_000;
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OID = '11111111-2222-3333-4444-555555555555';
const UNKNOWN_OID = '99999999-2222-3333-4444-555555555555';
const APP_ID = 'client-id';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: 'https://login.microsoftonline.com/authorize',
  token_endpoint: 'https://login.microsoftonline.com/token',
  jwks_uri: 'https://login.microsoftonline.com/keys',
};

let privateKey: KeyLike;
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
});

interface SetupOptions {
  createUser?: boolean;
  enabled?: boolean;
  redirectBase?: string;
  oid?: string;
  tofu?: boolean;
  bind?: boolean;
  ssoLinkByEmail?: boolean;
  ssoProvision?: 'off' | 'tenant';
  ssoDefaultProjects?: string | string[];
  ssoDefaultModels?: string[];
  ssoDefaultModel?: string;
  ssoDefaultPlugins?: string[];
  ssoAllowedTools?: string[];
  ssoDefaultYolo?: boolean;
  knownModels?: string[];
  knownPlugins?: string[];
  knownTools?: string[];
  modelCatalog?: () => Promise<readonly string[]>;
  graphStatus?: number;
  graphUser?: { id?: string; userType?: string; accountEnabled?: boolean };
  graphFailure?: Error;
}

function setup(options: SetupOptions = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const userSettings = new UserSettingStore(db);
  const projects = new ProjectStore(db);
  const userProjects = new UserProjectStore(db);
  const user = options.createUser === false ? null : users.create('alice', 'secret');
  const config = new ConfigStore(db);
  config.update({
    plugins: {
      enabled: options.enabled === false ? [] : ['msteams'],
      config: {
        msteams: {
          appId: APP_ID,
          appPassword: 'server-secret',
          tenantId: TENANT.toUpperCase(),
          ssoEnabled: true,
          ssoRedirectBase: options.redirectBase === undefined ? 'https://elowen.example' : options.redirectBase,
          ssoLinkByEmail: options.ssoLinkByEmail,
          ssoProvision: options.ssoProvision ?? 'off',
          ssoDefaultProjects: options.ssoDefaultProjects ?? '',
          ssoDefaultModels: options.ssoDefaultModels,
          ssoDefaultModel: options.ssoDefaultModel,
          ssoDefaultPlugins: options.ssoDefaultPlugins,
          ssoAllowedTools: options.ssoAllowedTools,
          ssoDefaultYolo: options.ssoDefaultYolo,
        },
      },
    },
  });
  if (user && options.bind !== false && !options.tofu) {
    users.linkExistingExternalIdentity({ provider: 'msteams', tenantId: TENANT, subjectId: options.oid ?? OID, userId: user.id });
  }
  if (user && options.tofu) userSettings.set(user.id, 'msteamsUserId', options.oid ?? OID);

  const clock = new FakeClock(NOW);
  const bus = new EventBus();
  const events: unknown[] = [];
  bus.subscribe((event) => events.push(event));
  let idToken = '';
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('.well-known/openid-configuration')) return Response.json(DISCOVERY);
    if (url === DISCOVERY.token_endpoint) return Response.json({ id_token: idToken });
    if (url.includes('/oauth2/v2.0/token')) return Response.json({ access_token: 'graph-token', expires_in: 3600 });
    if (url.startsWith('https://graph.microsoft.com/')) {
      if (options.graphFailure) throw options.graphFailure;
      if (options.graphStatus && options.graphStatus !== 200) return new Response('', { status: options.graphStatus });
      return Response.json(options.graphUser ?? { id: options.oid ?? OID, userType: 'Member', accountEnabled: true });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const keyResolver = vi.fn(() => createLocalJWKSet(jwks));
  const microsoftSso = new MicrosoftSsoService({
    config,
    users,
    userSettings,
    clock,
    bus,
    projects,
    userProjects,
    project: { id: 1 },
    catalogs: {
      models: options.modelCatalog ?? (async () => options.knownModels ?? []),
      plugins: async () => options.knownPlugins ?? [],
      tools: async () => options.knownTools ?? [],
    },
    fetch: fetchImpl,
    keyResolver,
  });
  const app = createServer({
    bus,
    engine: null as never,
    spawn: null as never,
    tmux: null as never,
    project: { id: 1, path: '/o' },
    fallback: { program: 'claude-code', model: 'sonnet' },
    clock,
    config,
    users,
    userSettings,
    projects,
    userProjects,
    microsoftSso,
  } as never);

  const claimsFor = (nonce: string, claims: Record<string, unknown> = {}) => {
    const now = Math.floor(clock.now() / 1000);
    return {
      iss: ISSUER,
      aud: APP_ID,
      tid: TENANT,
      oid: options.oid ?? OID,
      nonce,
      iat: now,
      nbf: now - 1,
      exp: now + 600,
      ...claims,
    };
  };
  const signFor = async (nonce: string, claims: Record<string, unknown> = {}) => {
    idToken = await new SignJWT(claimsFor(nonce, claims))
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey);
  };
  const setIdToken = (token: string) => { idToken = token; };

  const start = async (next?: string) => {
    const response = await app.request('/auth/sso/msteams/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next === undefined ? {} : { next }),
    });
    const body = await response.json() as { flowId: string; authorizationUrl: string; error?: string };
    const url = body.authorizationUrl ? new URL(body.authorizationUrl) : null;
    return { response, body, state: url?.searchParams.get('state') ?? '', nonce: url?.searchParams.get('nonce') ?? '', url };
  };

  const callback = (flowId: string, state: string) => app.request('/auth/sso/msteams/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flowId, state, code: 'authorization-code' }),
  });

  return {
    app, db, users, userSettings, userProjects, user, config, clock, events, fetchImpl, keyResolver,
    microsoftSso, start, callback, claimsFor, signFor, setIdToken,
  };
}

describe('Microsoft SSO routes', () => {
  it('returns no providers and 404s start/callback while SSO is unavailable', async () => {
    for (const options of [
      { enabled: false },
      { redirectBase: '' },
      { createUser: false },
    ]) {
      const { app } = setup(options);
      expect(await (await app.request('/auth/sso/providers')).json()).toEqual([]);
      expect((await app.request('/auth/sso/msteams/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(options.createUser === false ? 403 : 404);
    }
    const { app } = setup({ enabled: false });
    const callback = await app.request('/auth/sso/msteams/callback', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: 'x', state: 'y', code: 'z' }),
    });
    expect(callback.status).toBe(404);
  });

  it('builds a tenant authorization URL with PKCE S256', async () => {
    const { start } = setup();
    const flow = await start();
    expect(flow.response.status).toBe(200);
    expect(flow.url?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url?.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.url?.searchParams.get('redirect_uri')).toBe('https://elowen.example/api/auth/sso/microsoft/callback');
  });

  it('returns only a validated relative next path after callback', async () => {
    for (const [requested, expected] of [['/dash?tab=1', '/dash?tab=1'], ['https://evil.example', '/'], ['//evil.example', '/'], ['/\\evil', '/']] as const) {
      const { start, signFor, callback } = setup();
      const flow = await start(requested);
      await signFor(flow.nonce);
      const response = await callback(flow.body.flowId, flow.state);
      expect((await response.json()).next).toBe(expected);
    }
  });

  it('consumes state once', async () => {
    const { start, signFor, callback } = setup();
    const flow = await start();
    await signFor(flow.nonce);
    expect((await callback(flow.body.flowId, flow.state)).status).toBe(200);
    const replay = await callback(flow.body.flowId, flow.state);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'state_expired' });
  });

  it('rejects a valid flow id with a mismatched state', async () => {
    const { start, callback } = setup();
    const flow = await start();
    const response = await callback(flow.body.flowId, `${flow.state}-wrong`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'state_expired' });
  });

  it('rejects an expired flow', async () => {
    const { start, callback, clock } = setup();
    const flow = await start();
    clock.advance(10 * 60_000);
    const response = await callback(flow.body.flowId, flow.state);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'state_expired' });
  });

  it.each(['none', 'HS256'] as const)('rejects an id token using %s', async (algorithm) => {
    const { start, callback, claimsFor, setIdToken } = setup();
    const flow = await start();
    const claims = claimsFor(flow.nonce);
    if (algorithm === 'none') {
      const encodedHeader = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
      const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
      setIdToken(`${encodedHeader}.${encodedClaims}.`);
    } else {
      setIdToken(await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode('attacker-controlled-secret')));
    }

    const response = await callback(flow.body.flowId, flow.state);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'sso_failed' });
  });

  it('rejects an id token without exp', async () => {
    const { start, callback, claimsFor, setIdToken } = setup();
    const flow = await start();
    const { exp: _exp, ...claims } = claimsFor(flow.nonce);
    setIdToken(await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey));

    const response = await callback(flow.body.flowId, flow.state);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'sso_failed' });
  });

  it('reuses the JWKS resolver across token verifications', async () => {
    const { start, signFor, callback, keyResolver } = setup();
    for (let i = 0; i < 2; i++) {
      const flow = await start();
      await signFor(flow.nonce);
      expect((await callback(flow.body.flowId, flow.state)).status).toBe(200);
    }
    expect(keyResolver).toHaveBeenCalledTimes(1);
  });

  it('finds a lowercase binding for uppercase Entra ids', async () => {
    const { start, signFor, callback, user } = setup();
    const flow = await start();
    await signFor(flow.nonce, { tid: TENANT.toUpperCase(), oid: OID.toUpperCase() });
    const response = await callback(flow.body.flowId, flow.state);
    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(user?.id);
  });

  it('backfills an empty profile email from the verified claim', async () => {
    const { start, signFor, callback, users, user } = setup();
    expect(users.get(user!.id)?.email).toBe('');
    const flow = await start();
    await signFor(flow.nonce, { email: ' Alice@Example.com ' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(200);
    expect(users.get(user!.id)?.email).toBe('Alice@Example.com');
  });

  it('never overwrites an email the account already has', async () => {
    const { start, signFor, callback, users, user } = setup();
    // A profile address may differ from the UPN on purpose, and it drives Teams identity matching too.
    users.setProfile(user!.id, { email: 'chosen@example.com' });
    const flow = await start();
    await signFor(flow.nonce, { email: 'upn@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(200);
    expect(users.get(user!.id)?.email).toBe('chosen@example.com');
  });

  it('signs in without an email when the claimed address belongs to another account', async () => {
    const { start, signFor, callback, users, user } = setup();
    const other = users.create('carol', 'secret');
    users.setProfile(other.id, { email: 'taken@example.com' });
    const flow = await start();
    await signFor(flow.nonce, { email: 'taken@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(user?.id);
    expect(users.get(user!.id)?.email).toBe('');
    expect(users.get(other.id)?.email).toBe('taken@example.com');
  });

  it('records a sanitized denial event for a guest token', async () => {
    const { start, signFor, callback, events } = setup();
    const flow = await start();
    await signFor(flow.nonce, { acct: 1 });
    const response = await callback(flow.body.flowId, flow.state);
    expect(response.status).toBe(403);
    expect(events).toContainEqual({
      type: 'auth',
      kind: 'sso.denied',
      subject: `${OID}@${TENANT}`,
      detail: 'guest',
    });
  });

  it('promotes a Teams TOFU setting only when the token email matches the same account', async () => {
    const { start, signFor, callback, users, user } = setup({ tofu: true, bind: false });
    users.setProfile(user!.id, { email: 'alice@example.com' });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce, { email: 'alice@example.com', acct: 0 });
    const response = await callback(flow.body.flowId, flow.state);
    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(user?.id);
    expect(users.count()).toBe(before);
    expect(users.externalIdentity('msteams', TENANT, OID)?.id).toBe(user?.id);
  });

  it('does not promote a self-service TOFU setting when its account email does not match', async () => {
    const { start, signFor, callback, users, userSettings, user } = setup({ tofu: true, bind: false });
    users.setProfile(user!.id, { email: 'attacker@example.com' });
    const colleague = users.create('colleague', 'secret');
    users.setProfile(colleague.id, { email: 'colleague@example.com' });
    const flow = await start();
    await signFor(flow.nonce, { email: 'colleague@example.com', acct: 0 });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(colleague.id);
    expect(users.externalIdentity('msteams', TENANT, OID)?.id).toBe(colleague.id);
    expect(userSettings.get(user!.id, 'msteamsUserId')).toBeNull();
  });

  it('denies an unknown oid and cannot create an account', async () => {
    const { start, signFor, callback, users } = setup({ oid: UNKNOWN_OID, bind: false });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce);
    const response = await callback(flow.body.flowId, flow.state);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_account' });
    expect(users.count()).toBe(before);
  });

  it('does not link a matching email when email linking is disabled', async () => {
    const { start, signFor, callback, users, user } = setup({ bind: false, ssoLinkByEmail: false });
    users.setProfile(user!.id, { email: 'alice@example.com' });
    const flow = await start();
    await signFor(flow.nonce, { email: 'alice@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_account' });
    expect(users.externalIdentity('msteams', TENANT, OID)).toBeNull();
  });

  it('links one unambiguous matching email without provisioning', async () => {
    const { start, signFor, callback, users } = setup({ bind: false, ssoLinkByEmail: true });
    const target = users.create('bob', 'secret');
    users.setProfile(target.id, { email: 'bob@example.com' });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce, { email: ' BOB@example.com ' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(target.id);
    expect(users.count()).toBe(before);
    expect(users.externalIdentity('msteams', TENANT, OID)?.id).toBe(target.id);
  });

  it('rejects a Graph guest with no acct claim before linking by email', async () => {
    const { start, signFor, callback, users, user, fetchImpl } = setup({
      bind: false,
      ssoLinkByEmail: true,
      graphUser: { id: OID, userType: 'Guest', accountEnabled: true },
    });
    users.setProfile(user!.id, { email: 'guest@example.com' });
    const flow = await start();
    await signFor(flow.nonce, { email: 'guest@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'guest' });
    expect(users.externalIdentity('msteams', TENANT, OID)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/v1.0/users/${OID}?`),
      expect.objectContaining({ headers: { authorization: 'Bearer graph-token' } }),
    );
  });

  it('returns already_linked when the email account has another identity in the tenant', async () => {
    const { start, signFor, callback, users, user } = setup({ bind: false, ssoLinkByEmail: true });
    users.setProfile(user!.id, { email: 'alice@example.com' });
    users.linkExistingExternalIdentity({
      provider: 'msteams',
      tenantId: TENANT,
      subjectId: UNKNOWN_OID,
      userId: user!.id,
    });
    const flow = await start();
    await signFor(flow.nonce, { email: 'alice@example.com', acct: 0 });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'already_linked' });
    expect(users.externalIdentity('msteams', TENANT, OID)).toBeNull();
  });

  it('defaults email linking on and links one unambiguous email to an admin account by owner decision', async () => {
    const { start, signFor, callback, users, user } = setup({ bind: false });
    // Deliberate owner decision: email linking defaults on and may link an admin account too.
    users.setProfile(user!.id, { email: 'owner@example.com' });
    const flow = await start();
    await signFor(flow.nonce, { email: 'owner@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(user!.id);
    expect(users.externalIdentity('msteams', TENANT, OID)?.id).toBe(user!.id);
  });

  it('refuses an ambiguous email instead of provisioning another account', async () => {
    const { start, signFor, callback, db, users, user } = setup({ bind: false, ssoLinkByEmail: true, ssoProvision: 'tenant' });
    const second = users.create('bob', 'secret');
    db.prepare('DROP INDEX idx_users_email_normalized').run();
    db.prepare('UPDATE users SET email = ? WHERE id IN (?, ?)').run('shared@example.com', user!.id, second.id);
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce, { email: 'shared@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_account' });
    expect(users.count()).toBe(before);
    expect(users.externalIdentity('msteams', TENANT, OID)).toBeNull();
  });

  it('rejects a B2B guest reported by Graph even when the token tenant matches', async () => {
    const { start, signFor, callback, users, fetchImpl } = setup({
      oid: UNKNOWN_OID,
      bind: false,
      ssoProvision: 'tenant',
      graphUser: { id: UNKNOWN_OID, userType: 'Guest', accountEnabled: true },
    });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce, { email: 'guest@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'guest' });
    expect(users.count()).toBe(before);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/v1.0/users/${UNKNOWN_OID}?`),
      expect.objectContaining({ headers: { authorization: 'Bearer graph-token' } }),
    );
  });

  it('rejects a disabled tenant member', async () => {
    const { start, signFor, callback, users } = setup({
      oid: UNKNOWN_OID,
      bind: false,
      ssoProvision: 'tenant',
      graphUser: { id: UNKNOWN_OID, userType: 'Member', accountEnabled: false },
    });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce);

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_account' });
    expect(users.count()).toBe(before);
  });

  it.each([
    ['Graph 403', { graphStatus: 403 }],
    ['Graph timeout', { graphFailure: new Error('timeout') }],
  ])('fails closed when %s prevents directory verification', async (_label, graph) => {
    const { start, signFor, callback, users } = setup({ oid: UNKNOWN_OID, bind: false, ssoProvision: 'tenant', ...graph });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce, { email: 'member@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'directory_unavailable' });
    expect(users.count()).toBe(before);
  });

  it.each([
    ['legacy CSV', '1, 999, invalid'],
    ['selection array', ['1', '999', 'invalid']],
  ])('provisions a passwordless non-admin with defaults from the %s project shape', async (_shape, ssoDefaultProjects) => {
    const { start, signFor, callback, db, users, userSettings, userProjects } = setup({
      oid: UNKNOWN_OID,
      bind: false,
      ssoProvision: 'tenant',
      ssoDefaultProjects,
      ssoDefaultModels: ['relay/gpt-5', 'elowen:removed/model'],
      ssoDefaultModel: 'relay/gpt-5',
      ssoDefaultPlugins: ['agents', 'removed-plugin'],
      ssoAllowedTools: ['Bash', 'RemovedTool'],
      ssoDefaultYolo: true,
      knownModels: ['relay/gpt-5'],
      knownPlugins: ['agents'],
      knownTools: ['Bash'],
    });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce, {
      preferred_username: 'new.user@example.com',
      name: 'New User',
      email: 'new.user@example.com',
    });

    const response = await callback(flow.body.flowId, flow.state);
    const body = await response.json() as { user: { id: number; username: string; is_admin: boolean; name: string; email: string } };
    const provisioned = users.get(body.user.id);

    expect(response.status).toBe(200);
    expect(users.count()).toBe(before + 1);
    expect(body.user).toMatchObject({ is_admin: false, name: 'New User', email: 'new.user@example.com' });
    expect(provisioned).toMatchObject({
      allowed_execs: ['relay/gpt-5'],
      default_exec: 'relay/gpt-5',
      granted_plugins: ['agents'],
      allowed_tools: ['Bash'],
    });
    expect(userProjects.forUser(body.user.id)).toEqual([1]);
    expect(userSettings.permissionSettings(body.user.id).yolo).toBe(true);
    expect(db.prepare('SELECT 1 FROM user_projects WHERE project_id = 999').get()).toBeUndefined();
    expect(users.verify(body.user.username, 'new.user@example.com')).toBeNull();
    expect(users.verify(body.user.username, '')).toBeNull();
  });

  it('resolves defaults before creating the account so concurrent callbacks cannot observe unrestricted permissions', async () => {
    let releaseCatalog!: () => void;
    let firstCatalogStarted!: () => void;
    let secondCatalogStarted!: () => void;
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstCatalogStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { secondCatalogStarted = resolve; });
    let catalogCalls = 0;
    const { start, signFor, callback, users } = setup({
      oid: UNKNOWN_OID,
      bind: false,
      ssoProvision: 'tenant',
      ssoDefaultModels: ['relay/gpt-5'],
      modelCatalog: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) firstCatalogStarted();
        if (catalogCalls === 2) secondCatalogStarted();
        await catalogGate;
        return ['relay/gpt-5'];
      },
    });
    const firstFlow = await start();
    await signFor(firstFlow.nonce);
    const firstCallback = callback(firstFlow.body.flowId, firstFlow.state);
    await firstStarted;
    expect(users.count()).toBe(1);

    const secondFlow = await start();
    await signFor(secondFlow.nonce);
    const secondCallback = callback(secondFlow.body.flowId, secondFlow.state);
    await secondStarted;
    expect(users.count()).toBe(1);

    releaseCatalog();
    const responses = await Promise.all([firstCallback, secondCallback]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(users.count()).toBe(2);
    expect(users.externalIdentity('msteams', TENANT, UNKNOWN_OID)?.allowed_execs).toEqual(['relay/gpt-5']);
  });

  it('skips a preferred model outside the configured model allow-list', async () => {
    const { start, signFor, callback, users } = setup({
      oid: UNKNOWN_OID,
      bind: false,
      ssoProvision: 'tenant',
      ssoDefaultModels: ['relay/gpt-5'],
      ssoDefaultModel: 'relay/other',
      knownModels: ['relay/gpt-5', 'relay/other'],
    });
    const flow = await start();
    await signFor(flow.nonce);

    const response = await callback(flow.body.flowId, flow.state);
    const body = await response.json() as { user: { id: number } };

    expect(response.status).toBe(200);
    expect(users.get(body.user.id)).toMatchObject({ allowed_execs: ['relay/gpt-5'], default_exec: '' });
  });

  it('never applies provisioning defaults to an existing account', async () => {
    const { start, signFor, callback, users, user } = setup({
      ssoProvision: 'tenant',
      ssoDefaultProjects: ['1'],
      ssoDefaultModels: ['relay/gpt-5'],
      ssoDefaultModel: 'relay/gpt-5',
      ssoDefaultPlugins: ['agents'],
      ssoAllowedTools: ['Bash'],
      knownModels: ['relay/gpt-5'],
      knownPlugins: ['agents'],
      knownTools: ['Bash'],
    });
    users.setAllowedExecs(user!.id, ['sonnet']);
    users.setAllowedTools(user!.id, ['Read']);
    users.setGrantedPlugins(user!.id, ['work']);
    users.setProfile(user!.id, { default_exec: 'opus' });
    const flow = await start();
    await signFor(flow.nonce);

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(200);
    expect(users.get(user!.id)).toMatchObject({
      allowed_execs: ['sonnet'],
      allowed_tools: ['Read'],
      granted_plugins: ['work'],
      default_exec: 'opus',
    });
  });

  it('refuses provisioning cleanly when the email already belongs to an account', async () => {
    const { start, signFor, callback, users, user } = setup({
      oid: UNKNOWN_OID,
      bind: false,
      ssoLinkByEmail: false,
      ssoProvision: 'tenant',
    });
    users.setProfile(user!.id, { email: 'existing@example.com' });
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce, { email: 'existing@example.com' });

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_account' });
    expect(users.count()).toBe(before);
  });

  it('cannot provision on an instance that has users but no administrator', async () => {
    const { start, signFor, callback, db, users } = setup({ oid: UNKNOWN_OID, bind: false, ssoProvision: 'tenant' });
    db.prepare('UPDATE users SET is_admin = 0').run();
    const before = users.count();
    const flow = await start();
    await signFor(flow.nonce);

    const response = await callback(flow.body.flowId, flow.state);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no_account' });
    expect(users.count()).toBe(before);
  });

  it('matches the password-login session shape and TTL', async () => {
    const { app, start, signFor, callback } = setup();
    const password = await app.request('/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'secret' }),
    });
    const passwordBody = await password.json() as Record<string, unknown>;
    const flow = await start();
    await signFor(flow.nonce);
    const sso = await callback(flow.body.flowId, flow.state);
    const ssoBody = await sso.json() as Record<string, unknown>;
    expect(ssoBody.tokenTtlDays).toBe(passwordBody.tokenTtlDays);
    expect(ssoBody.user).toEqual(passwordBody.user);
    expect(typeof ssoBody.token).toBe('string');
  });

  it('shares the fixed-window rate limit with password login', async () => {
    const { app } = setup({ enabled: false });
    const headers = { 'content-type': 'application/json', 'x-real-ip': '10.0.0.9' };
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'alice', password: 'wrong' }) })).status).toBe(401);
    }
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/auth/sso/msteams/start', { method: 'POST', headers, body: '{}' })).status).toBe(404);
    }
    expect((await app.request('/auth/sso/msteams/callback', { method: 'POST', headers, body: '{}' })).status).toBe(429);
  });

  it('caps live flows at 500 and sweeps expired entries', async () => {
    const { microsoftSso, clock } = setup();
    for (let i = 0; i < 500; i++) await microsoftSso.start();
    await expect(microsoftSso.start()).rejects.toMatchObject({ code: 'too_many_flows' } satisfies Partial<MicrosoftSsoError>);
    clock.advance(10 * 60_000);
    await expect(microsoftSso.start()).resolves.toHaveProperty('flowId');
  });
});
