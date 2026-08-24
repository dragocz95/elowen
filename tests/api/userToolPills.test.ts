import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';
import { PluginRegistry } from '../../src/plugins/registry.js';

/** The users modal asks this route what an account may run. It used to answer `allowed` for every plugin
 *  tool the daemon had loaded, reading only the per-user deny-list — so a tool from a plugin the account
 *  was never granted was presented as a permission it held. The account then watched the tool do nothing.
 *
 *  It matters most for `terminal`, which is grant-gated precisely because a shell is the whole host. */
type Pill = { name: string; plugin: string | null; state: string; toggleable: boolean };

/** `strangerId` owns a personal tool: index-parallel to `tools`, exactly as the loader builds it. */
function registryWith(strangerId: number | null): PluginRegistry {
  const reg = new PluginRegistry();
  reg.tools.push({ name: 'Bash', label: 'Run command' } as unknown as PluginRegistry['tools'][number]);
  reg.tools.push({ name: 'OpenTool', label: 'Open' } as unknown as PluginRegistry['tools'][number]);
  reg.toolOwnerUsers.push(null, null);
  reg.toolOwner.set('Bash', 'terminal');
  reg.toolOwner.set('OpenTool', 'open');
  reg.userGrantable.add('terminal');
  if (strangerId !== null) {
    reg.tools.push({ name: 'SomeonesPersonalTool', label: 'Theirs' } as unknown as PluginRegistry['tools'][number]);
    reg.toolOwnerUsers.push(strangerId);
    reg.toolOwner.set('SomeonesPersonalTool', 'open');
  }
  return reg;
}

async function pillsFor(
  grants: string[], isAdmin = false, denied: string[] = [], strangerId: number | null = null,
  allowedTools: string[] = ['*'],
): Promise<Map<string, Pill>> {
  const reg = registryWith(strangerId);
  const { app, deps } = await makeTestApp({
    userProjects: true,
    extra: { plugins: { get: async () => reg, peek: () => reg } as never },
  });
  const admin = deps.users.create('root', 'pw');
  deps.users.setAdmin(admin.id, true);
  const target = deps.users.create('josef', 'pw');
  if (grants.length) deps.users.setGrantedPlugins(target.id, grants);
  if (isAdmin) deps.users.setAdmin(target.id, true);
  if (denied.length) deps.users.setDisabledTools(target.id, denied);
  // A locally created account starts with an EMPTY grant, so every case that is not about the grant
  // itself hands the account the pre-migration `*` marker and stays about the plugin grant alone.
  deps.users.setAllowedTools(target.id, allowedTools);
  const res = await app.request(`/users/${target.id}/tools`, {
    headers: { authorization: `Bearer ${deps.users.issueToken(admin.id)}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as Pill[];
  return new Map(body.map((p) => [p.name, p]));
}

describe('the tool list an admin sees for one account', () => {
  it('calls a grant-gated tool unavailable, not allowed, when the grant is missing', async () => {
    const pills = await pillsFor([]);
    expect(pills.get('Bash')?.state).toBe('unavailable');
    // Nothing to toggle: the deny-list cannot subtract from a tool already withheld.
    expect(pills.get('Bash')?.toggleable).toBe(false);
    // A plugin that never opted into grants is unaffected.
    expect(pills.get('OpenTool')?.state).toBe('allowed');
  });

  it('turns it allowed once the plugin is granted', async () => {
    const pills = await pillsFor(['terminal']);
    expect(pills.get('Bash')?.state).toBe('allowed');
    expect(pills.get('Bash')?.toggleable).toBe(true);
  });

  it('needs no grant for an administrator, who reaches the host anyway', async () => {
    const pills = await pillsFor([], true);
    expect(pills.get('Bash')?.state).toBe('allowed');
  });

  // The admin's explicit "no" outranks a missing grant in this list, and it has to: the PATCH this list
  // drives replaces the deny-list wholesale, so a denied tool reported as anything else would silently
  // drop out of the deny-list on the next save — and come back enabled the moment the grant returned.
  it('keeps reporting an explicit deny even when the grant is gone', async () => {
    const pills = await pillsFor([], false, ['Bash']);
    expect(pills.get('Bash')?.state).toBe('disabled');
    expect(pills.get('Bash')?.toggleable).toBe(true);
  });

  // The tool grant is the account's positive authority, and this list is its editor: a tool the admin
  // never granted has to read as an unchecked box, not as one the account holds.
  it('reports a tool outside the account grant as disabled, and a granted one as allowed', async () => {
    const pills = await pillsFor([], false, [], null, ['OpenTool']);
    expect(pills.get('OpenTool')?.state).toBe('allowed');
    expect(pills.get('OpenTool')?.toggleable).toBe(true);
    const empty = await pillsFor([], false, [], null, []);
    expect(empty.get('OpenTool')?.state).toBe('disabled');
    expect(empty.get('OpenTool')?.toggleable).toBe(true);
  });

  // An admin bypasses the grant entirely (toolAuthorityForUser), so an empty one must not read as "no
  // tools" here either — that would show the operator a panel full of unchecked boxes they still hold.
  it('ignores an empty grant for an administrator', async () => {
    const pills = await pillsFor([], true, [], null, []);
    expect(pills.get('OpenTool')?.state).toBe('allowed');
  });

  // Another account's personal tool can never reach this user's session, so it must not be listed as
  // something they hold — PluginRegistry.toolsFor filters it out and this list has to agree.
  it('never lists a personal tool belonging to somebody else', async () => {
    const pills = await pillsFor([], false, [], 4242);
    expect(pills.has('SomeonesPersonalTool')).toBe(false);
    expect(pills.has('OpenTool')).toBe(true);
  });
});
