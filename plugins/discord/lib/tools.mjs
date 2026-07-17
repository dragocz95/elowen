// Admin/server tools: the Discord* tool registrations (raw REST access + curated wrappers).
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

export function registerTools(ctx, adapter) {
  // Raw Discord REST access for the OWNER: delete/purge messages, manage roles, edit channels —
  // whatever the bot's permissions allow. The token never leaves the plugin; admin sessions only.
  ctx.registerTool(defineTool({
    name: 'DiscordApi', label: 'Discord API',
    description: 'Call the Discord REST API (v10) with the bot token — server management: delete messages (DELETE /channels/{id}/messages/{msgId}, bulk POST /channels/{id}/messages/bulk-delete with {"messages":[ids]} for <14d messages), manage roles (PUT/DELETE /guilds/{gid}/members/{uid}/roles/{roleId}), fetch messages (GET /channels/{id}/messages?limit=50), edit channels, and anything else the API offers. Operator only.',
    parameters: Type.Object({
      method: Type.Union([Type.Literal('GET'), Type.Literal('POST'), Type.Literal('PATCH'), Type.Literal('PUT'), Type.Literal('DELETE')]),
      path: Type.String({ description: 'API path starting with /, e.g. /channels/123/messages?limit=20' }),
      body: Type.Optional(Type.String({ description: 'JSON request body, when the endpoint takes one' })),
    }),
    execute: async (_id, p) => {
      try {
        // Owner-only, NOT merely admin: the raw bot token can delete/ban/reconfigure the whole server,
        // so a foreign member holding an admin-mapped role must never reach it. `owner` is the operator.
        if (ctx.currentIdentity?.()?.owner !== true) throw new Error('DiscordApi is only available to the operator');
        if (!p.path.startsWith('/')) return ok('Error: path must start with "/".');
        let body;
        if (p.body) {
          try { body = JSON.parse(p.body); } catch { return ok('Error: body is not valid JSON.'); }
        }
        const res = await adapter.rest(p.method, p.path, body);
        const text = res === null ? '(no content)' : JSON.stringify(res, null, 2);
        return ok(text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text);
      } catch (e) { return fail(e); }
    },
  }));

  // ── Ergonomic server tools (structured wrappers over the REST surface, so the agent needn't know raw
  // endpoints). Every one gates on an admin session (ctx.isAdminSession() → the role-id-mapped admin
  // access): a role granted all tools can run the full server surface, reads and destructive writes alike.
  // The raw-token DiscordApi above stays owner-only. ──
  const cfgGuild = typeof ctx.config.guildId === 'string' ? ctx.config.guildId.trim() : '';
  const requireGuild = (p) => {
    const g = (p?.guildId && String(p.guildId).trim()) || cfgGuild;
    if (!g) throw new Error('no guild id — set guildId in the plugin config or pass it as guildId');
    return g;
  };
  const adminGate = () => { if (!ctx.isAdminSession()) throw new Error('available only in an admin session'); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CHAN_TYPE = { 0: 'text', 2: 'voice', 4: 'category', 5: 'news', 10: 'news-thread', 11: 'thread', 12: 'private-thread', 13: 'stage', 15: 'forum' };
  // Channel type name → numeric id, for create_channel (text/voice/category/news/forum/stage).
  const CHAN_TYPE_ID = { text: 0, voice: 2, category: 4, news: 5, stage: 13, forum: 15 };

  ctx.registerTool(defineTool({
    name: 'DiscordListChannels', label: 'List Discord channels',
    description: 'List the guild\'s channels AND active threads (id, type, name, parent) so you can pick one to read or post to.',
    parameters: Type.Object({ guildId: Type.Optional(Type.String({ description: 'Guild id (defaults to the configured one)' })) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const g = requireGuild(p);
        const chans = (await adapter.rest('GET', `/guilds/${g}/channels`)) ?? [];
        const active = ((await adapter.rest('GET', `/guilds/${g}/threads/active`)) ?? {}).threads ?? [];
        const line = (c, t) => `${c.id}  [${t}]  ${c.name ?? ''}${c.parent_id ? `  (parent ${c.parent_id})` : ''}`;
        const out = [...chans.map((c) => line(c, CHAN_TYPE[c.type] ?? c.type)), ...active.map((t) => line(t, 'active-thread'))];
        return ok(out.length ? out.join('\n') : '(no channels)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordReadChannel', label: 'Read Discord channel',
    description: 'Read recent messages from a channel or thread by id (oldest→newest) — use it to load context from another thread. Returns "author: text" lines.',
    parameters: Type.Object({
      channelId: Type.String({ description: 'Channel or thread id' }),
      limit: Type.Optional(Type.Number({ description: 'How many recent messages (default 30, max 100)' })),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const limit = Math.min(Math.max(1, Number(p.limit) || 30), 100);
        const msgs = (await adapter.rest('GET', `/channels/${encodeURIComponent(p.channelId)}/messages?limit=${limit}`)) ?? [];
        const lines = msgs.reverse().map((m) => `${m.author?.username ?? m.author?.id ?? '?'}: ${(m.content ?? '').replace(/\s+/g, ' ').trim()}${m.attachments?.length ? `  [${m.attachments.length} attachment(s)]` : ''}`);
        const text = lines.join('\n') || '(no messages)';
        return ok(text.length > 6000 ? text.slice(-6000) : text);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordListRoles', label: 'List Discord roles',
    description: 'List the guild\'s roles (id, name) — get a roleId here before assigning/removing it.',
    parameters: Type.Object({ guildId: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const roles = (await adapter.rest('GET', `/guilds/${requireGuild(p)}/roles`)) ?? [];
        return ok(roles.map((r) => `${r.id}  ${r.name}`).join('\n') || '(no roles)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordListMembers', label: 'List Discord members',
    description: 'List guild members (id, username, role ids) — needs the SERVER MEMBERS privileged intent. Use it to find a user id before assigning a role.',
    parameters: Type.Object({ guildId: Type.Optional(Type.String()), limit: Type.Optional(Type.Number({ description: 'default 50, max 200' })) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const limit = Math.min(Math.max(1, Number(p.limit) || 50), 200);
        const members = (await adapter.rest('GET', `/guilds/${requireGuild(p)}/members?limit=${limit}`)) ?? [];
        return ok(members.map((m) => `${m.user?.id}  ${m.user?.username ?? ''}${m.roles?.length ? `  roles:[${m.roles.join(',')}]` : ''}`).join('\n') || '(no members)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordAssignRole', label: 'Assign Discord role',
    description: 'DESTRUCTIVE. Give a guild member a role (a role can grant permissions). Get ids from DiscordListMembers + DiscordListRoles.',
    parameters: Type.Object({ userId: Type.String(), roleId: Type.String(), guildId: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('PUT', `/guilds/${requireGuild(p)}/members/${encodeURIComponent(p.userId)}/roles/${encodeURIComponent(p.roleId)}`);
        return ok(`Assigned role ${p.roleId} to member ${p.userId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordRemoveRole', label: 'Remove Discord role',
    description: 'DESTRUCTIVE. Remove a role from a guild member.',
    parameters: Type.Object({ userId: Type.String(), roleId: Type.String(), guildId: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('DELETE', `/guilds/${requireGuild(p)}/members/${encodeURIComponent(p.userId)}/roles/${encodeURIComponent(p.roleId)}`);
        return ok(`Removed role ${p.roleId} from member ${p.userId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  // ── More server tools (structured REST wrappers). Per the operator's choice, ALL of these gate on an
  // admin session (ctx.isAdminSession() → the role-id-mapped admin access): the destructive ones can
  // delete/reconfigure the server, so they must never run in a plain member's channel. The raw-token
  // DiscordApi above stays owner-only; these curated wrappers are the admin-session surface. ──

  ctx.registerTool(defineTool({
    name: 'DiscordServerInfo', label: 'Discord server info',
    description: 'Guild overview: name, id, owner, approximate member/online counts, channel and role totals.',
    parameters: Type.Object({ guildId: Type.Optional(Type.String({ description: 'Guild id (defaults to the configured one)' })) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const g = requireGuild(p);
        const info = await adapter.rest('GET', `/guilds/${g}?with_counts=true`);
        const chans = (await adapter.rest('GET', `/guilds/${g}/channels`)) ?? [];
        const roles = (await adapter.rest('GET', `/guilds/${g}/roles`)) ?? [];
        return ok([
          `name: ${info.name}`, `id: ${info.id}`, `owner_id: ${info.owner_id}`,
          `members≈ ${info.approximate_member_count ?? '?'} (online≈ ${info.approximate_presence_count ?? '?'})`,
          `channels: ${chans.length}`, `roles: ${roles.length}`,
        ].join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordChannelInfo', label: 'Discord channel info',
    description: 'Details of one channel or thread by id: type, name, topic, parent, NSFW, slowmode, archived/locked (threads).',
    parameters: Type.Object({ channelId: Type.String({ description: 'Channel or thread id' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const c = await adapter.rest('GET', `/channels/${encodeURIComponent(p.channelId)}`);
        const out = [`id: ${c.id}`, `type: ${CHAN_TYPE[c.type] ?? c.type}`, `name: ${c.name ?? ''}`];
        if (c.topic) out.push(`topic: ${c.topic}`);
        if (c.parent_id) out.push(`parent: ${c.parent_id}`);
        if (c.nsfw) out.push('nsfw: true');
        if (c.rate_limit_per_user) out.push(`slowmode: ${c.rate_limit_per_user}s`);
        if (c.thread_metadata) out.push(`archived: ${!!c.thread_metadata.archived}`, `locked: ${!!c.thread_metadata.locked}`);
        return ok(out.join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordMemberInfo', label: 'Discord member info',
    description: 'Details of one guild member by user id: username, nickname, role ids, joined date.',
    parameters: Type.Object({ userId: Type.String(), guildId: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const m = await adapter.rest('GET', `/guilds/${requireGuild(p)}/members/${encodeURIComponent(p.userId)}`);
        return ok([
          `id: ${m.user?.id}`, `username: ${m.user?.username ?? ''}`,
          m.nick ? `nick: ${m.nick}` : null, `roles: [${(m.roles ?? []).join(', ')}]`,
          m.joined_at ? `joined: ${m.joined_at}` : null,
        ].filter(Boolean).join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordSearchMembers', label: 'Search Discord members',
    description: 'Find guild members whose username/nickname starts with a query string (id, username, nick). Use it to resolve a user id from a name.',
    parameters: Type.Object({
      query: Type.String({ description: 'Name prefix to match' }),
      guildId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ description: 'default 10, max 100' })),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const limit = Math.min(Math.max(1, Number(p.limit) || 10), 100);
        const members = (await adapter.rest('GET', `/guilds/${requireGuild(p)}/members/search?query=${encodeURIComponent(p.query)}&limit=${limit}`)) ?? [];
        return ok(members.map((m) => `${m.user?.id}  ${m.user?.username ?? ''}${m.nick ? `  (${m.nick})` : ''}`).join('\n') || '(no matches)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordListPins', label: 'List Discord pins',
    description: 'List the pinned messages of a channel (id, author, text) — get a message id before unpinning.',
    parameters: Type.Object({ channelId: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const pins = (await adapter.rest('GET', `/channels/${encodeURIComponent(p.channelId)}/pins`)) ?? [];
        return ok(pins.map((m) => `${m.id}  ${m.author?.username ?? '?'}: ${(m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`).join('\n') || '(no pins)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordCreateThread', label: 'Create Discord thread',
    description: 'Create a public thread. If messageId is given the thread hangs off that message; otherwise a standalone thread is created in the channel.',
    parameters: Type.Object({
      channelId: Type.String({ description: 'Parent text channel id' }),
      name: Type.String({ description: 'Thread name' }),
      messageId: Type.Optional(Type.String({ description: 'Anchor message id (omit for a standalone thread)' })),
      autoArchiveMinutes: Type.Optional(Type.Number({ description: '60, 1440, 4320 or 10080 (default 1440)' })),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const auto = [60, 1440, 4320, 10080].includes(Number(p.autoArchiveMinutes)) ? Number(p.autoArchiveMinutes) : 1440;
        const cid = encodeURIComponent(p.channelId);
        const path = p.messageId
          ? `/channels/${cid}/messages/${encodeURIComponent(p.messageId)}/threads`
          : `/channels/${cid}/threads`;
        const body = p.messageId ? { name: p.name, auto_archive_duration: auto } : { name: p.name, auto_archive_duration: auto, type: 11 };
        const th = await adapter.rest('POST', path, body);
        return ok(`Created thread ${th.id} "${th.name}".`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordPinMessage', label: 'Pin Discord message',
    description: 'Pin a message in its channel.',
    parameters: Type.Object({ channelId: Type.String(), messageId: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('PUT', `/channels/${encodeURIComponent(p.channelId)}/pins/${encodeURIComponent(p.messageId)}`);
        return ok(`Pinned message ${p.messageId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordUnpinMessage', label: 'Unpin Discord message',
    description: 'Remove a pinned message (does NOT delete it).',
    parameters: Type.Object({ channelId: Type.String(), messageId: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('DELETE', `/channels/${encodeURIComponent(p.channelId)}/pins/${encodeURIComponent(p.messageId)}`);
        return ok(`Unpinned message ${p.messageId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordDeleteMessage', label: 'Delete Discord message',
    description: 'DESTRUCTIVE. Permanently delete ONE message by id.',
    parameters: Type.Object({ channelId: Type.String(), messageId: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('DELETE', `/channels/${encodeURIComponent(p.channelId)}/messages/${encodeURIComponent(p.messageId)}`);
        return ok(`Deleted message ${p.messageId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordPurgeMessages', label: 'Purge Discord messages',
    description: 'DESTRUCTIVE. Bulk-delete recent messages from a channel/thread. Fetches up to maxMessages (newest first), skips pinned unless includePinned, then deletes them (bulk for <14-day messages, one-by-one for older, throttled). Always run with dryRun:true first to see the count.',
    parameters: Type.Object({
      channelId: Type.String(),
      maxMessages: Type.Optional(Type.Number({ description: '1..5000 (default 100)' })),
      includePinned: Type.Optional(Type.Boolean({ description: 'also delete pinned messages (default false)' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'count only, delete nothing (default false)' })),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const cid = encodeURIComponent(p.channelId);
        const cap = Math.min(Math.max(1, Number(p.maxMessages) || 100), 5000);
        const collected = [];
        let before;
        while (collected.length < cap) {
          const q = `limit=${Math.min(100, cap - collected.length)}${before ? `&before=${before}` : ''}`;
          const batch = (await adapter.rest('GET', `/channels/${cid}/messages?${q}`)) ?? [];
          if (!batch.length) break;
          collected.push(...batch);
          before = batch[batch.length - 1].id;
          if (batch.length < 100) break;
        }
        let targets = collected.slice(0, cap);
        if (!p.includePinned) targets = targets.filter((m) => !m.pinned);
        if (p.dryRun) return ok(`Dry run: ${targets.length} message(s) would be deleted${p.includePinned ? '' : ' (pinned skipped)'}.`);
        // Discord's bulk endpoint only accepts 2–100 messages younger than 14 days; older ones must go one by one.
        const CUTOFF = 14 * 24 * 60 * 60 * 1000 - 60_000;
        const now = Date.now();
        const fresh = []; const old = [];
        for (const m of targets) ((now - Date.parse(m.timestamp)) < CUTOFF ? fresh : old).push(m.id);
        let deleted = 0;
        for (let i = 0; i < fresh.length; i += 100) {
          const chunk = fresh.slice(i, i + 100);
          if (chunk.length >= 2) { await adapter.rest('POST', `/channels/${cid}/messages/bulk-delete`, { messages: chunk }); }
          else { await adapter.rest('DELETE', `/channels/${cid}/messages/${chunk[0]}`); }
          deleted += chunk.length;
          await sleep(500);
        }
        for (const mid of old) { await adapter.rest('DELETE', `/channels/${cid}/messages/${mid}`); deleted += 1; await sleep(400); }
        return ok(`Deleted ${deleted} message(s)${old.length ? ` (${old.length} older than 14 days, removed individually)` : ''}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordCreateChannel', label: 'Create Discord channel',
    description: 'Create a channel in the guild. type is one of: text, voice, news, stage, forum (default text). Optionally nest under a category id.',
    parameters: Type.Object({
      name: Type.String(),
      type: Type.Optional(Type.String({ description: 'text | voice | news | stage | forum (default text)' })),
      parentId: Type.Optional(Type.String({ description: 'Category id to nest under' })),
      guildId: Type.Optional(Type.String()),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const type = CHAN_TYPE_ID[String(p.type ?? 'text').toLowerCase()] ?? 0;
        const body = { name: p.name, type };
        if (p.parentId) body.parent_id = p.parentId;
        const c = await adapter.rest('POST', `/guilds/${requireGuild(p)}/channels`, body);
        return ok(`Created channel ${c.id} "${c.name}".`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordCreateCategory', label: 'Create Discord category',
    description: 'Create a category (channel group) in the guild.',
    parameters: Type.Object({ name: Type.String(), guildId: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const c = await adapter.rest('POST', `/guilds/${requireGuild(p)}/channels`, { name: p.name, type: 4 });
        return ok(`Created category ${c.id} "${c.name}".`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordRenameChannel', label: 'Rename Discord channel',
    description: 'Rename a channel, thread or category by id.',
    parameters: Type.Object({ channelId: Type.String(), name: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const c = await adapter.rest('PATCH', `/channels/${encodeURIComponent(p.channelId)}`, { name: p.name });
        return ok(`Renamed channel ${p.channelId} to "${c.name}".`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordDeleteChannel', label: 'Delete Discord channel',
    description: 'DESTRUCTIVE. Permanently delete a channel, thread or category by id (a category delete does NOT delete its children, they become uncategorized).',
    parameters: Type.Object({ channelId: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('DELETE', `/channels/${encodeURIComponent(p.channelId)}`);
        return ok(`Deleted channel ${p.channelId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordArchiveThread', label: 'Archive Discord thread',
    description: 'Archive (archived:true) or reopen (archived:false) a thread by id.',
    parameters: Type.Object({ threadId: Type.String(), archived: Type.Optional(Type.Boolean({ description: 'default true' })) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const archived = p.archived !== false;
        await adapter.rest('PATCH', `/channels/${encodeURIComponent(p.threadId)}`, { archived });
        return ok(`${archived ? 'Archived' : 'Reopened'} thread ${p.threadId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordLockThread', label: 'Lock Discord thread',
    description: 'Lock (locked:true) or unlock a thread by id — a locked thread can\'t get new messages from non-moderators.',
    parameters: Type.Object({ threadId: Type.String(), locked: Type.Optional(Type.Boolean({ description: 'default true' })) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const locked = p.locked !== false;
        await adapter.rest('PATCH', `/channels/${encodeURIComponent(p.threadId)}`, { locked });
        return ok(`${locked ? 'Locked' : 'Unlocked'} thread ${p.threadId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordAddThreadMember', label: 'Add Discord thread member',
    description: 'Add a guild member to a thread by user id.',
    parameters: Type.Object({ threadId: Type.String(), userId: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('PUT', `/channels/${encodeURIComponent(p.threadId)}/thread-members/${encodeURIComponent(p.userId)}`);
        return ok(`Added member ${p.userId} to thread ${p.threadId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'DiscordRemoveThreadMember', label: 'Remove Discord thread member',
    description: 'Remove a member from a thread by user id.',
    parameters: Type.Object({ threadId: Type.String(), userId: Type.String() }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await adapter.rest('DELETE', `/channels/${encodeURIComponent(p.threadId)}/thread-members/${encodeURIComponent(p.userId)}`);
        return ok(`Removed member ${p.userId} from thread ${p.threadId}.`);
      } catch (e) { return fail(e); }
    },
  }));
}
