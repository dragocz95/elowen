import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';
import { PluginRegistry } from '../../src/plugins/registry.js';

/** The users modal asks this route what an account may run. It used to answer `allowed` for every plugin
 *  tool the daemon had loaded, reading only the per-user deny-list — so a tool from a plugin the account
 *  was never granted was presented as a permission it held. The account then watched the tool do nothing.
 *
 *  It matters most for `terminal`, which is grant-gated precisely because a shell is the whole host. */
type Pill = { name: string; plugin: string | null; state: string; toggleable: boolean };

function registryWith(): PluginRegistry {
  const reg = new PluginRegistry();
  reg.tools.push({ name: 'Bash', label: 'Run command' } as unknown as PluginRegistry['tools'][number]);
  reg.tools.push({ name: 'OpenTool', label: 'Open' } as unknown as PluginRegistry['tools'][number]);
  reg.toolOwnerUsers.push(null, null);
  reg.toolOwner.set('Bash', 'terminal');
  reg.toolOwner.set('OpenTool', 'open');
  reg.userGrantable.add('terminal');
  return reg;
}

async function pillsFor(grants: string[], isAdmin = false): Promise<Map<string, Pill>> {
  const reg = registryWith();
  const { app, deps } = await makeTestApp({
    userProjects: true,
    extra: { plugins: { get: async () => reg, peek: () => reg } as never },
  });
  const admin = deps.users.create('root', 'pw');
  deps.users.setAdmin(admin.id, true);
  const target = deps.users.create('josef', 'pw');
  if (grants.length) deps.users.setGrantedPlugins(target.id, grants);
  if (isAdmin) deps.users.setAdmin(target.id, true);
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
});
