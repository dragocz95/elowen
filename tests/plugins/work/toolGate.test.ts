import { describe, it, expect } from 'vitest';
import { registerWorkTools } from '../../../plugins/work/src/tools.js';
import type { PluginContext } from '../../../src/plugins/api.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** The core composed these tools into `owner-chat` sessions ONLY and handed them the acting user's own
 *  advisor token. As plugin tools they are composed into EVERY session kind, so both halves of that
 *  boundary have to be reproduced at execute time — this pins them. */

type Access = { owner: boolean; admin: boolean; projectIds: number[] };
const OWNER: Access = { owner: true, admin: true, projectIds: [] };
const CHANNEL_ADMIN: Access = { owner: false, admin: true, projectIds: [] };

function harness(opts: { access?: Access; userId?: number | null; identity?: () => number | null; tokenFor?: (id: number) => string | null } = {}) {
  const tools: ToolDefinition[] = [];
  const fetches: { url: string; auth: string | null }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    fetches.push({ url: String(url), auth: headers.get('authorization') });
    return new Response(JSON.stringify([{ id: 'elowen-1' }]), { status: 200 });
  }) as typeof fetch;
  const ctx = {
    registerTool: (t: ToolDefinition) => { tools.push(t); },
    currentAccess: () => ({ ...(opts.access ?? OWNER), permissionBoundary: null }),
    currentIdentity: () => {
      const id = opts.identity ? opts.identity() : (opts.userId === undefined ? 7 : opts.userId);
      return id === null ? null : { elowenUserId: id };
    },
    host: { elowenCli: () => ({ url: 'http://d:4400', tokenForUser: opts.tokenFor ?? (() => 'user-token') }) },
  } as unknown as PluginContext;
  registerWorkTools(ctx);
  return { tools, fetches, restore: () => { globalThis.fetch = origFetch; } };
}

const run = (t: ToolDefinition, params: unknown = {}) => t.execute('call-1', params as never, undefined as never, undefined as never, undefined as never);

describe('work plugin tool registration (owner gate + per-call credential)', () => {
  it('registers the seven task tools in their historical order', () => {
    const h = harness();
    try {
      expect(h.tools.map((t) => t.name)).toEqual([
        'ElowenListTasks', 'ElowenCreateTask', 'ElowenUpdateTask', 'ElowenPlan',
        'ElowenGetTask', 'ElowenStopTask', 'ElowenTaskOutput',
      ]);
    } finally { h.restore(); }
  });

  it('refuses a platform admin who is not the owner — and never reaches the API', async () => {
    // The Discord-moderator case: admin scope WITHOUT owner truth. These tools MUTATE, so serving them
    // here would be exactly the escalation the core prevented by composing them for owner-chat only.
    const h = harness({ access: CHANNEL_ADMIN });
    try {
      for (const t of h.tools) {
        const res = await run(t, { task_id: 'x', title: 't', project_id: 1, goal: 'g' });
        expect(res.content[0]!.text).toContain("only available in the owner's own chat session");
      }
      expect(h.fetches).toHaveLength(0);
    } finally { h.restore(); }
  });

  it("serves the owner on the ACTING user's own credential, resolved per call", async () => {
    const seen: number[] = [];
    const h = harness({ tokenFor: (id) => { seen.push(id); return `token-for-${id}`; } });
    try {
      await run(h.tools[0]!);
      expect(seen).toEqual([7]);
      expect(h.fetches[0]).toEqual({ url: 'http://d:4400/tasks', auth: 'Bearer token-for-7' });
    } finally { h.restore(); }
  });

  it('follows the acting identity between turns rather than the one present at registration', async () => {
    // A registration-time capture would let a later turn act as whoever happened to load the plugin.
    let acting: number | null = 7;
    const h = harness({ identity: () => acting, tokenFor: (id) => `token-for-${id}` });
    try {
      await run(h.tools[0]!);
      acting = 9;
      await run(h.tools[0]!);
      expect(h.fetches.map((f) => f.auth)).toEqual(['Bearer token-for-7', 'Bearer token-for-9']);
    } finally { h.restore(); }
  });

  it('says so when the turn has no linked account, instead of falling back to a shared token', async () => {
    const h = harness({ userId: null });
    try {
      const res = await run(h.tools[0]!);
      expect(res.content[0]!.text).toContain('needs a linked Elowen account');
      expect(h.fetches).toHaveLength(0);
    } finally { h.restore(); }
  });

  it('says so when no credential can be minted for the acting user', async () => {
    const h = harness({ tokenFor: () => null });
    try {
      const res = await run(h.tools[0]!);
      expect(res.content[0]!.text).toContain('could not resolve a credential');
      expect(h.fetches).toHaveLength(0);
    } finally { h.restore(); }
  });
});
