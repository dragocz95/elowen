import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestApp } from '../helpers/testApp.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { makeSubagentCatalog } from '../../src/brain/agents/catalogService.js';
import manifest from '../../plugins/subagent/elowen-plugin.json' with { type: 'json' };

/** Who may reach the Agents page and what it may answer them.
 *
 *  The page belongs to every authenticated account, because choosing which model a built-in agent runs on
 *  is that person's own setting. Authoring agent definitions writes instance-wide files and stays with the
 *  administrators. One permission model — the host's `access` level plus the account's own config slice —
 *  and no per-page role of its own. */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

type Entry = { name: string; description: string; source: string; canDelete: boolean; body?: string };

async function setup() {
  const agentsDir = mkdtempSync(join(tmpdir(), 'subagent-agents-'));
  dirs.push(agentsDir);
  const catalog = makeSubagentCatalog({
    builtinDir: join(repoRoot, 'prompts/agents'),
    userDir: agentsDir,
    pluginToolNames: async () => [],
  });
  const provider = new PluginRegistryProvider(() => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'],
    host: { subagentCatalog: catalog },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Parameters<typeof loadPlugins>[0]));
  // `userProjects` makes the REAL admin gate live: without it the app runs in open mode, where every
  // caller counts as an administrator and this whole distinction would be untested.
  const { app, token, deps } = await makeTestApp({ userProjects: true, extra: { plugins: provider } });
  const member = deps.users.create('mia', 'pw');
  await catalog.save('triage', { description: 'Bug triage.', tools: 'inherit', body: 'Investigate first.' });
  return { app, adminTok: token, memberTok: deps.users.issueToken(member.id) };
}

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe('the Agents page surface', () => {
  it('is not administrator-only chrome', () => {
    // `web.adminOnly` hides the nav entry AND 403s the bundle, so the page could not be opened at all.
    expect((manifest as { web?: { adminOnly?: boolean } }).web?.adminOnly).toBeUndefined();
  });

  it('lets an ordinary account read the agent catalog it needs to label its own model choices', async () => {
    const { app, memberTok } = await setup();
    const res = await app.request('/plugins/agents/list', auth(memberTok));
    expect(res.status).toBe(200);
    const entries = await res.json() as Entry[];
    expect(entries.map((e) => e.name).sort()).toEqual(['explore', 'plan', 'review', 'triage']);
    expect(entries.find((e) => e.name === 'explore')).toMatchObject({ source: 'builtin' });
  });

  it('never sends an ordinary account another author\'s agent prompt, nor a delete affordance', async () => {
    const { app, memberTok, adminTok } = await setup();
    const asMember = await (await app.request('/plugins/agents/list', auth(memberTok))).json() as Entry[];
    expect(asMember.every((e) => e.body === undefined)).toBe(true);
    expect(JSON.stringify(asMember)).not.toContain('Investigate first.');
    expect(asMember.every((e) => e.canDelete === false)).toBe(true);
    // The administrator who may edit it still gets it.
    const asAdmin = await (await app.request('/plugins/agents/list', auth(adminTok))).json() as Entry[];
    expect(asAdmin.find((e) => e.name === 'triage')).toMatchObject({ body: 'Investigate first.', canDelete: true });
  });

  it('refuses every write to the shared catalog from an ordinary account', async () => {
    const { app, memberTok } = await setup();
    const put = await app.request('/plugins/agents/mine', {
      method: 'PUT', ...auth(memberTok),
      headers: { authorization: `Bearer ${memberTok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'mine', tools: 'inherit', body: 'do things' }),
    });
    expect(put.status).toBe(403);
    expect((await app.request('/plugins/agents/triage', { method: 'DELETE', ...auth(memberTok) })).status).toBe(403);
  });
});
