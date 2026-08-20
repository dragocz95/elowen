// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { TeamsAccountLinking } from '../plugins/msteams/lib/accountLinking.mjs';

const TENANT = '5d321ea3-359c-40a8-b0c6-2314101886df';
const OBJECT_ID = '11111111-2222-3333-4444-555555555555';
const cfg = {
  appId: 'app-id',
  appPassword: 'secret',
  tenantId: TENANT,
  accountLinking: true,
  oauthConnectionName: 'Chetty delegated access',
};

function token(claims: Record<string, unknown> = {}) {
  const encoded = Buffer.from(JSON.stringify({ tid: TENANT, oid: OBJECT_ID, ...claims })).toString('base64url');
  return `header.${encoded}.signature`;
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    from: { id: '29:teams-user', aadObjectId: OBJECT_ID },
    conversation: { id: '19:conversation', conversationType: 'personal', tenantId: TENANT },
    ...overrides,
  };
}

function harness(options: {
  accessToken?: string | null;
  profile?: Record<string, unknown>;
  graphOk?: boolean;
  graphJsonError?: boolean;
} = {}) {
  const tokenClient = {
    getUserToken: vi.fn(async () => options.accessToken === undefined ? { token: token() } : (options.accessToken ? { token: options.accessToken } : null)),
    getSignInResource: vi.fn(async () => ({ signInLink: 'https://token.botframework.com/signin' })),
    signOutUser: vi.fn(async () => undefined),
  };
  const fetch = vi.fn(async () => ({
    ok: options.graphOk ?? true,
    json: async () => {
      if (options.graphJsonError) throw new SyntaxError('invalid JSON');
      return options.profile ?? {
        id: OBJECT_ID,
        displayName: 'Alex Example',
        userPrincipalName: 'alex@chetty.ai',
        mail: 'alex@chetty.ai',
        accountEnabled: true,
        userType: 'Member',
      };
    },
  }));
  const externalUsers = {
    resolve: vi.fn(() => ({ id: 7, username: 'alex', isAdmin: false })),
    describe: vi.fn(() => ({ user: { id: 7, username: 'alex', isAdmin: false }, linkedAt: '2026-08-19T01:00:00.000Z' })),
    linkOrProvision: vi.fn(() => ({ user: { id: 7, username: 'alex', isAdmin: false }, created: true })),
    linkExisting: vi.fn(() => ({ user: { id: 7, username: 'alex', isAdmin: false }, linkedAt: '2026-08-19T01:00:00.000Z' })),
  };
  const linking = new TeamsAccountLinking(cfg, externalUsers, { info() {}, warn() {}, error() {} }, { tokenClient, fetch });
  return { linking, tokenClient, fetch, externalUsers };
}

describe('TeamsAccountLinking', () => {
  it('verifies a tenant member through Graph and provisions only bounded identity data', async () => {
    const { linking, tokenClient, fetch, externalUsers } = harness();

    await expect(linking.authenticate(activity())).resolves.toEqual({
      status: 'authorized',
      user: { id: 7, username: 'alex', isAdmin: false },
      created: true,
    });
    expect(tokenClient.getUserToken).toHaveBeenCalledWith('29:teams-user', cfg.oauthConnectionName, 'msteams', undefined);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/me?'), expect.objectContaining({
      headers: { authorization: expect.stringMatching(/^Bearer /), accept: 'application/json' },
    }));
    expect(externalUsers.linkOrProvision).toHaveBeenCalledWith({
      provider: 'msteams', tenantId: TENANT, subjectId: OBJECT_ID,
      preferredUsername: 'alex', name: 'Alex Example', email: 'alex@chetty.ai',
    });
    expect(JSON.stringify(externalUsers.linkOrProvision.mock.calls)).not.toContain('signature');
  });

  it('returns a sign-in requirement without calling Graph or provisioning', async () => {
    const { linking, fetch, externalUsers } = harness({ accessToken: null });
    await expect(linking.authenticate(activity())).resolves.toEqual({ status: 'sign_in_required' });
    expect(fetch).not.toHaveBeenCalled();
    expect(externalUsers.linkOrProvision).not.toHaveBeenCalled();
  });

  it.each([
    ['activity tenant', activity({ conversation: { id: '19:conversation', tenantId: 'other' } }), token(), 'wrong_tenant'],
    ['token tenant', activity(), token({ tid: 'other' }), 'wrong_tenant'],
    ['missing token subject', activity(), token({ oid: undefined }), 'identity_mismatch'],
    ['token subject', activity(), token({ oid: 'other' }), 'identity_mismatch'],
  ])('rejects a mismatched %s', async (_label, incoming, accessToken, code) => {
    const { linking, externalUsers } = harness({ accessToken });
    await expect(linking.authenticate(incoming)).rejects.toMatchObject({ code });
    expect(externalUsers.linkOrProvision).not.toHaveBeenCalled();
  });

  it.each([
    ['Graph subject', { id: 'other', userType: 'Member', accountEnabled: true }, 'identity_mismatch'],
    ['guest account', { id: OBJECT_ID, userType: 'Guest', accountEnabled: true }, 'not_member'],
    ['disabled account', { id: OBJECT_ID, userType: 'Member', accountEnabled: false }, 'disabled'],
  ])('rejects a mismatched %s', async (_label, profile, code) => {
    const { linking, externalUsers } = harness({ profile });
    await expect(linking.authenticate(activity())).rejects.toMatchObject({ code });
    expect(externalUsers.linkOrProvision).not.toHaveBeenCalled();
  });

  it('sanitizes failed and malformed Graph responses', async () => {
    const failed = harness({ graphOk: false });
    await expect(failed.linking.authenticate(activity())).rejects.toMatchObject({ code: 'graph_rejected' });
    const malformed = harness({ graphJsonError: true });
    await expect(malformed.linking.authenticate(activity())).rejects.toMatchObject({ code: 'graph_rejected' });
  });

  it('builds an OAuth card from Token Service without exposing credentials', async () => {
    const { linking, tokenClient } = harness({ accessToken: null });
    const card = await linking.signInActivity(activity(), 'Sign in to continue.', 'Sign in');
    expect(tokenClient.getSignInResource).toHaveBeenCalledWith(cfg.oauthConnectionName, expect.objectContaining({ channelId: 'msteams' }));
    expect(card).toEqual(expect.objectContaining({
      type: 'message',
      attachments: [expect.objectContaining({
        contentType: 'application/vnd.microsoft.card.oauth',
        content: expect.objectContaining({
          connectionName: cfg.oauthConnectionName,
          buttons: [{ type: 'signin', title: 'Sign in', value: 'https://token.botframework.com/signin' }],
        }),
      })],
    }));
    expect(card).not.toHaveProperty('text');
    expect(JSON.stringify(card)).not.toContain(cfg.appPassword);
  });

  it('exposes a delegated token only inside the matching personal Teams turn', async () => {
    const { linking } = harness();
    await expect(linking.delegatedSession({ platform: 'msteams', userId: OBJECT_ID })).rejects.toMatchObject({ code: 'personal_turn_required' });

    await linking.runWithActivity(activity(), async () => {
      await expect(linking.delegatedSession({ platform: 'web', userId: OBJECT_ID })).rejects.toMatchObject({ code: 'turn_identity_mismatch' });
      await expect(linking.delegatedSession({ platform: 'msteams', userId: 'other' })).rejects.toMatchObject({ code: 'turn_identity_mismatch' });
      await expect(linking.delegatedSession({ platform: 'msteams', userId: OBJECT_ID })).resolves.toMatchObject({
        token: expect.stringMatching(/^header\./), subjectId: OBJECT_ID, tenantId: TENANT,
      });
    });

    await expect(linking.runWithActivity(activity({ conversation: { id: '19:group', conversationType: 'groupChat', tenantId: TENANT } }),
      () => linking.delegatedSession({ platform: 'msteams', userId: OBJECT_ID })))
      .rejects.toMatchObject({ code: 'personal_turn_required' });
  });

  it('isolates concurrent delegated turns by immutable Entra subject', async () => {
    const otherObjectId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { linking } = harness();
    vi.mocked(linking.tokens.getUserToken).mockImplementation(async (userId: string) => ({ token: userId === '29:other' ? token({ oid: otherObjectId }) : token() }));
    vi.mocked(linking.fetch).mockImplementation(async (_url: string, init?: RequestInit) => {
      const authorization = String((init as { headers?: { authorization?: string } })?.headers?.authorization ?? '');
      const id = authorization.includes(token({ oid: otherObjectId })) ? otherObjectId : OBJECT_ID;
      return { ok: true, json: async () => ({ id, displayName: id, userPrincipalName: `${id}@example.com`, mail: `${id}@example.com`, accountEnabled: true, userType: 'Member' }) } as Response;
    });
    const one = linking.runWithActivity(activity(), async () => (await linking.delegatedSession({ platform: 'msteams', userId: OBJECT_ID })).subjectId);
    const two = linking.runWithActivity(activity({ from: { id: '29:other', aadObjectId: otherObjectId } }), async () => {
      return (await linking.delegatedSession({ platform: 'msteams', userId: otherObjectId })).subjectId;
    });
    await expect(Promise.all([one, two])).resolves.toEqual([OBJECT_ID, otherObjectId]);
  });

  it('serves safe account status, explicit binding and sign-out without returning tokens', async () => {
    const { linking, tokenClient, externalUsers } = harness();
    const person = { aad: OBJECT_ID, id: '29:teams-user' };
    const status = await linking.accountStatus(person);
    expect(status).toMatchObject({ linked: true, signedIn: true, user: { id: 7, username: 'alex' }, profile: { id: OBJECT_ID } });
    expect(JSON.stringify(status)).not.toContain('signature');

    await linking.linkExisting(person, 7, true);
    expect(externalUsers.linkExisting).toHaveBeenCalledWith({ provider: 'msteams', tenantId: TENANT, subjectId: OBJECT_ID, userId: 7, replace: true });
    await linking.signOutPerson(person);
    expect(tokenClient.signOutUser).toHaveBeenCalledWith('29:teams-user', cfg.oauthConnectionName, 'msteams');
  });
});
