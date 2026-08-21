import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { MicrosoftSsoError, MicrosoftSsoService, type MicrosoftOidcDiscovery } from '../../src/auth/msSso.js';
import { UserStore } from '../../src/store/userStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { EventBus } from '../../src/api/sse.js';
import { FakeClock } from '../../src/shared/clock.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';

const NOW = 2_000_000_000_000;
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OID = '11111111-2222-3333-4444-555555555555';
const APP_ID = 'client-id';
const NONCE = 'expected-nonce';
const discovery: MicrosoftOidcDiscovery = {
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  authorization_endpoint: 'https://login.microsoftonline.com/authorize',
  token_endpoint: 'https://login.microsoftonline.com/token',
  jwks_uri: 'https://login.microsoftonline.com/keys',
};

let privateKey: KeyLike;
let otherPrivateKey: KeyLike;
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
});

function service() {
  const db = openPluginTablesDb(':memory:');
  const users = new UserStore(db);
  users.create('admin', 'secret');
  return new MicrosoftSsoService({
    config: new ConfigStore(db),
    users,
    clock: new FakeClock(NOW),
    bus: new EventBus(),
    keyResolver: () => createLocalJWKSet(jwks),
  });
}

async function token(overrides: Record<string, unknown> = {}, key = privateKey): Promise<string> {
  const now = Math.floor(NOW / 1000);
  const claims = {
    iss: discovery.issuer,
    aud: APP_ID,
    tid: TENANT,
    oid: OID,
    nonce: NONCE,
    iat: now,
    nbf: now - 1,
    exp: now + 600,
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key === privateKey ? 'test-key' : 'other-key' })
    .sign(key);
}

async function verify(value: string) {
  return service().verifyIdToken(value, { appId: APP_ID, tenantId: TENANT, nonce: NONCE, discovery });
}

async function expectCode(value: Promise<unknown>, code: string): Promise<void> {
  await expect(value).rejects.toMatchObject<Partial<MicrosoftSsoError>>({ code });
}

describe('MicrosoftSsoService.verifyIdToken', () => {
  it('accepts a valid tenant token', async () => {
    await expect(verify(await token())).resolves.toMatchObject({ tenantId: TENANT, objectId: OID });
  });

  it('rejects a token with an untrusted signature', async () => {
    await expectCode(verify(await token({}, otherPrivateKey)), 'sso_failed');
  });

  it('rejects a wrong audience', async () => {
    await expectCode(verify(await token({ aud: 'other-client' })), 'sso_failed');
  });

  it('rejects a wrong issuer', async () => {
    await expectCode(verify(await token({ iss: 'https://issuer.example/other' })), 'sso_failed');
  });

  it('rejects a foreign tenant', async () => {
    await expectCode(verify(await token({ tid: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' })), 'tenant_mismatch');
  });

  it('rejects a wrong nonce', async () => {
    await expectCode(verify(await token({ nonce: 'wrong' })), 'sso_failed');
  });

  it('rejects a token expired beyond clock tolerance', async () => {
    const now = Math.floor(NOW / 1000);
    await expectCode(verify(await token({ exp: now - 301 })), 'sso_failed');
  });

  it('rejects a token not valid beyond clock tolerance', async () => {
    const now = Math.floor(NOW / 1000);
    await expectCode(verify(await token({ nbf: now + 301 })), 'sso_failed');
  });

  it('rejects a missing oid', async () => {
    await expectCode(verify(await token({ oid: undefined })), 'sso_failed');
  });

  it('rejects a guest account when acct is present', async () => {
    await expectCode(verify(await token({ acct: 1 })), 'guest');
  });

  it('normalizes tenant and object ids to lowercase', async () => {
    const result = await verify(await token({ tid: TENANT.toUpperCase(), oid: OID.toUpperCase() }));
    expect(result).toMatchObject({ tenantId: TENANT, objectId: OID });
  });
});
