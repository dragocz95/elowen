// Admin/owner-gated Telegram* tools: outbound messaging, chat/member inspection and group management.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** Coerce a chat id string into what the Bot API expects: a numeric id, or an `@channelusername`. */
function chat(v) {
  const s = String(v ?? '').trim();
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

export function registerTools(ctx, adapter) {
  const adminGate = () => { if (!ctx.isAdminSession()) throw new Error('available only in an admin session'); };
  const ownerGate = (name) => { if (ctx.currentIdentity?.()?.owner !== true) throw new Error(`${name} is only available to the operator`); };
  const api = () => adapter.requireBot().api;

  // Send a message to any chat — OWNER only (it can message anyone the bot can reach).
  ctx.registerTool(defineTool({
    name: 'TelegramSend', label: 'Telegram send message',
    description: 'Send a Telegram text message to a chat: a numeric chat id (e.g. 123456789 or a negative group id like -1001234567890) or an @channelusername. Operator only.',
    parameters: Type.Object({
      chatId: Type.String({ description: 'Numeric chat id or @channelusername' }),
      text: Type.String({ description: 'Message text' }),
    }),
    execute: async (_id, p) => {
      try {
        ownerGate('TelegramSend');
        await api().sendMessage(chat(p.chatId), String(p.text ?? ''));
        return ok(`Sent to ${p.chatId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramChatInfo', label: 'Telegram chat info',
    description: 'Details of a chat by id/username: type, title/username, description and pinned message (via getChat).',
    parameters: Type.Object({ chatId: Type.String({ description: 'Numeric chat id or @channelusername' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const c = await api().getChat(chat(p.chatId));
        const out = [`id: ${c.id}`, `type: ${c.type}`];
        if (c.title) out.push(`title: ${c.title}`);
        if (c.username) out.push(`username: @${c.username}`);
        if (c.description) out.push(`description: ${c.description}`);
        if (c.is_forum) out.push('forum: true');
        return ok(out.join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramGetMembersCount', label: 'Telegram member count',
    description: 'The number of members in a group/supergroup/channel (via getChatMemberCount).',
    parameters: Type.Object({ chatId: Type.String({ description: 'Numeric chat id or @channelusername' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const n = await api().getChatMemberCount(chat(p.chatId));
        return ok(`members: ${n}`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramMemberInfo', label: 'Telegram member info',
    description: 'Details of one chat member by user id: status (creator/administrator/member/…), name and admin rights (via getChatMember).',
    parameters: Type.Object({ chatId: Type.String(), userId: Type.Number({ description: 'Numeric Telegram user id' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const m = await api().getChatMember(chat(p.chatId), Number(p.userId));
        const u = m.user ?? {};
        return ok([
          `id: ${u.id}`, `name: ${[u.first_name, u.last_name].filter(Boolean).join(' ')}`,
          u.username ? `username: @${u.username}` : null, `status: ${m.status}`,
        ].filter(Boolean).join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramPinMessage', label: 'Pin Telegram message',
    description: 'Pin a message in a chat by id. The bot must have pin rights.',
    parameters: Type.Object({ chatId: Type.String(), messageId: Type.Number() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().pinChatMessage(chat(p.chatId), Number(p.messageId)); return ok(`Pinned message ${p.messageId}.`); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramUnpinMessage', label: 'Unpin Telegram message',
    description: 'Unpin a pinned message in a chat by id (does NOT delete it).',
    parameters: Type.Object({ chatId: Type.String(), messageId: Type.Number() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().unpinChatMessage(chat(p.chatId), Number(p.messageId)); return ok(`Unpinned message ${p.messageId}.`); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramDeleteMessage', label: 'Delete Telegram message',
    description: 'DESTRUCTIVE. Permanently delete ONE message by id from a chat.',
    parameters: Type.Object({ chatId: Type.String(), messageId: Type.Number() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().deleteMessage(chat(p.chatId), Number(p.messageId)); return ok(`Deleted message ${p.messageId}.`); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramBanMember', label: 'Ban Telegram member',
    description: 'DESTRUCTIVE. Ban a user from a group/channel by user id. The bot must be an admin with ban rights.',
    parameters: Type.Object({ chatId: Type.String(), userId: Type.Number() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().banChatMember(chat(p.chatId), Number(p.userId)); return ok(`Banned member ${p.userId}.`); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramUnbanMember', label: 'Unban Telegram member',
    description: 'Unban a previously banned user by user id so they can rejoin the group/channel.',
    parameters: Type.Object({ chatId: Type.String(), userId: Type.Number() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().unbanChatMember(chat(p.chatId), Number(p.userId)); return ok(`Unbanned member ${p.userId}.`); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramPromoteMember', label: 'Promote Telegram member',
    description: 'DESTRUCTIVE. Promote or demote a member to/from admin by user id. Pass the rights you want granted (true) — omitted rights and a demote (all false) both go through promoteChatMember. The bot must be an admin with can_promote_members.',
    parameters: Type.Object({
      chatId: Type.String(),
      userId: Type.Number(),
      canManageChat: Type.Optional(Type.Boolean()),
      canDeleteMessages: Type.Optional(Type.Boolean()),
      canRestrictMembers: Type.Optional(Type.Boolean()),
      canPromoteMembers: Type.Optional(Type.Boolean()),
      canChangeInfo: Type.Optional(Type.Boolean()),
      canInviteUsers: Type.Optional(Type.Boolean()),
      canPinMessages: Type.Optional(Type.Boolean()),
      canManageTopics: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        await api().promoteChatMember(chat(p.chatId), Number(p.userId), {
          can_manage_chat: p.canManageChat, can_delete_messages: p.canDeleteMessages,
          can_restrict_members: p.canRestrictMembers, can_promote_members: p.canPromoteMembers,
          can_change_info: p.canChangeInfo, can_invite_users: p.canInviteUsers,
          can_pin_messages: p.canPinMessages, can_manage_topics: p.canManageTopics,
        });
        return ok(`Updated admin rights for member ${p.userId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramSetChatTitle', label: 'Set Telegram chat title',
    description: 'Rename a group/supergroup/channel by id. The bot must be an admin with can_change_info.',
    parameters: Type.Object({ chatId: Type.String(), title: Type.String() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().setChatTitle(chat(p.chatId), String(p.title)); return ok(`Set title to "${p.title}".`); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramSetChatDescription', label: 'Set Telegram chat description',
    description: 'Set the description of a group/supergroup/channel by id. The bot must be an admin with can_change_info.',
    parameters: Type.Object({ chatId: Type.String(), description: Type.String() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().setChatDescription(chat(p.chatId), String(p.description ?? '')); return ok('Set chat description.'); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramCreateForumTopic', label: 'Create Telegram forum topic',
    description: 'Create a forum topic in a forum-enabled supergroup. Returns the new message_thread_id.',
    parameters: Type.Object({ chatId: Type.String(), name: Type.String({ description: 'Topic name' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const t = await api().createForumTopic(chat(p.chatId), String(p.name));
        return ok(`Created topic "${t.name}" (thread ${t.message_thread_id}).`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramEditForumTopic', label: 'Edit Telegram forum topic',
    description: 'Rename a forum topic by its message_thread_id in a forum-enabled supergroup.',
    parameters: Type.Object({ chatId: Type.String(), threadId: Type.Number({ description: 'message_thread_id of the topic' }), name: Type.String() }),
    execute: async (_id, p) => {
      try { adminGate(); await api().editForumTopic(chat(p.chatId), Number(p.threadId), { name: String(p.name) }); return ok(`Renamed topic ${p.threadId} to "${p.name}".`); }
      catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TelegramCloseForumTopic', label: 'Close Telegram forum topic',
    description: 'Close (closed:true) or reopen (closed:false) a forum topic by its message_thread_id.',
    parameters: Type.Object({ chatId: Type.String(), threadId: Type.Number(), closed: Type.Optional(Type.Boolean({ description: 'default true (close); false reopens' })) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const close = p.closed !== false;
        if (close) await api().closeForumTopic(chat(p.chatId), Number(p.threadId));
        else await api().reopenForumTopic(chat(p.chatId), Number(p.threadId));
        return ok(`${close ? 'Closed' : 'Reopened'} topic ${p.threadId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  // Raw Bot API access for the OWNER: any method the bot token can call. Operator only.
  ctx.registerTool(defineTool({
    name: 'TelegramApi', label: 'Telegram Bot API',
    description: 'Call any Telegram Bot API method by name with a JSON params object — full bot surface (sendMessage, getChat, restrictChatMember, exportChatInviteLink, …). Operator only.',
    parameters: Type.Object({
      method: Type.String({ description: 'Bot API method name, e.g. "sendMessage" or "getChat"' }),
      params: Type.Optional(Type.String({ description: 'JSON object of the method parameters (snake_case keys), e.g. {"chat_id":123,"text":"hi"}' })),
    }),
    execute: async (_id, p) => {
      try {
        ownerGate('TelegramApi');
        let params;
        if (p.params) {
          try { params = JSON.parse(p.params); } catch { return ok('Error: params is not valid JSON.'); }
        }
        const res = await adapter.callApi(p.method, params);
        const text = res === undefined || res === null ? '(no content)' : JSON.stringify(res, null, 2);
        return ok(text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text);
      } catch (e) { return fail(e); }
    },
  }));
}
