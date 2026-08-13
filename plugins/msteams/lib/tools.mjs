// Admin/owner-gated Teams* tools: outbound messaging, conversation/member inspection and raw
// connector access. All of them ride the Bot Connector API only — no Graph permissions involved,
// except TeamsMessagePerson's optional last resort, which stays behind a config switch that is off.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { personLine } from './directory.mjs';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

const memberLine = (m) => [
  `id: ${m?.id ?? '?'}`,
  m?.aadObjectId ? `aadObjectId: ${m.aadObjectId}` : null,
  m?.name ? `name: ${m.name}` : null,
  m?.userPrincipalName || m?.email ? `upn: ${m.userPrincipalName || m.email}` : null,
].filter(Boolean).join(' · ');

export function registerTools(ctx, adapter) {
  const adminGate = () => { if (!ctx.isAdminSession()) throw new Error('available only in an admin session'); };
  const ownerGate = (name) => { if (ctx.currentIdentity?.()?.owner !== true) throw new Error(`${name} is only available to the operator`); };

  // Send a message into any conversation the bot can reach — OWNER only.
  ctx.registerTool(defineTool({
    name: 'TeamsSend', label: 'Teams send message',
    description: 'Send a Microsoft Teams message into a conversation by its conversation id (a chat the bot has already seen). Operator only.',
    parameters: Type.Object({
      conversationId: Type.String({ description: 'Teams conversation id, e.g. "19:…@thread.tacv2" or "a:…"' }),
      text: Type.String({ description: 'Message text (markdown)' }),
    }),
    execute: async (_id, p) => {
      try {
        ownerGate('TeamsSend');
        adapter.requireServiceUrl(String(p.conversationId));
        await adapter.send(String(p.conversationId), String(p.text ?? ''));
        return ok(`Sent to ${p.conversationId}.`);
      } catch (e) { return fail(e); }
    },
  }));

  // Write to a PERSON the bot has never had a conversation id for — OWNER only, exactly like
  // TeamsSend: an unsolicited direct message is the most intrusive thing this plugin can do.
  ctx.registerTool(defineTool({
    name: 'TeamsMessagePerson', label: 'Teams message a person',
    description: 'Send a Microsoft Teams message directly to a PERSON — addressed by e-mail/UPN, Entra object id, "29:…" account id or display name, no conversation id needed. The bot opens (or reuses) the 1:1 chat itself. Use it for "tell Michal the build broke". An ambiguous name is refused with the candidates rather than guessed — check first with TeamsFindPerson. Operator only.',
    parameters: Type.Object({
      text: Type.String({ description: 'Message text (markdown)' }),
      email: Type.Optional(Type.String({ description: 'The person\'s e-mail / UPN' })),
      aadObjectId: Type.Optional(Type.String({ description: 'The person\'s Entra object id (a GUID)' })),
      userId: Type.Optional(Type.String({ description: 'The person\'s Teams account id ("29:…")' })),
      name: Type.Optional(Type.String({ description: 'The person\'s display name — must match exactly one known person' })),
    }),
    execute: async (_id, p) => {
      try {
        ownerGate('TeamsMessagePerson');
        const target = {
          email: p.email ? String(p.email) : undefined,
          aadObjectId: p.aadObjectId ? String(p.aadObjectId) : undefined,
          userId: p.userId ? String(p.userId) : undefined,
          name: p.name ? String(p.name) : undefined,
        };
        if (!target.email && !target.aadObjectId && !target.userId && !target.name) {
          return ok('Error: name the recipient with one of email, aadObjectId, userId or name.');
        }
        const { person, conversationId } = await adapter.messagePerson(target, String(p.text ?? ''));
        return ok(`Sent to ${person.name || person.upn || person.aad || person.id} (chat ${conversationId}).`);
      } catch (e) { return fail(e); }
    },
  }));

  // Read-only counterpart: check WHO you would be writing to before writing to them.
  ctx.registerTool(defineTool({
    name: 'TeamsFindPerson', label: 'Teams find person',
    description: 'Look up people the bot can message proactively, by e-mail/UPN, Entra object id, "29:…" account id or (part of) a display name. Shows whether a 1:1 chat is already open. Sends nothing — use it to confirm the recipient before TeamsMessagePerson.',
    parameters: Type.Object({
      query: Type.String({ description: 'E-mail, Entra object id, "29:…" account id, or a display name (or part of one)' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const query = String(p.query ?? '').trim();
        if (!query) return ok('Error: give something to look for.');
        const found = adapter.lookupPeople(query);
        if (!found.length) return ok(adapter.unknownPersonHelp(query));
        const lines = found.slice(0, 25).map((person) => `· ${personLine(person)}`);
        if (found.length > 25) lines.push(`… and ${found.length - 25} more`);
        return ok(`${found.length === 1 ? 'One match' : `${found.length} matches`} for "${query}":\n${lines.join('\n')}`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TeamsChatInfo', label: 'Teams chat info',
    description: 'Details of a Teams conversation the bot participates in: type, tenant and member count.',
    parameters: Type.Object({ conversationId: Type.String({ description: 'Teams conversation id' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const id = String(p.conversationId);
        const ref = adapter.state.get(id).ref ?? {};
        const members = await adapter.readRoster(id);
        return ok([
          `id: ${id}`,
          `type: ${ref.conversationType ?? 'unknown'}`,
          ref.tenantId ? `tenant: ${ref.tenantId}` : null,
          `members: ${members.length}`,
        ].filter(Boolean).join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TeamsMembers', label: 'Teams members',
    description: 'List the members of a Teams conversation (name, id, Entra object id and UPN/email from the roster). To notify one of them, write "<@id>" (or their e-mail, or their exact display name) in your reply — it is turned into a real Teams mention. Reading a roster also teaches the bot who these people are, so they can later be reached directly with TeamsMessagePerson.',
    parameters: Type.Object({ conversationId: Type.String({ description: 'Teams conversation id' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const id = String(p.conversationId);
        const list = await adapter.readRoster(id);
        const lines = list.slice(0, 50).map(memberLine);
        if (list.length > 50) lines.push(`… and ${list.length - 50} more`);
        return ok(lines.join('\n') || '(no members)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TeamsMemberInfo', label: 'Teams member info',
    description: 'Details of one conversation member by their id (the "29:…" account id or Entra object id): name, Entra object id, UPN/email.',
    parameters: Type.Object({
      conversationId: Type.String({ description: 'Teams conversation id' }),
      userId: Type.String({ description: 'Member account id ("29:…") or Entra object id' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const id = String(p.conversationId);
        const m = await adapter.connector.member(adapter.requireServiceUrl(id), id, String(p.userId));
        return ok(memberLine(m));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'TeamsListConversations', label: 'Teams conversations',
    description: 'List the conversations the bot participates in on the current Teams service host (id and member count per conversation).',
    parameters: Type.Object({
      continuationToken: Type.Optional(Type.String({ description: 'Continuation token from a previous page' })),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const out = await adapter.callApi('GET', p.continuationToken
          ? `/v3/conversations?continuationToken=${encodeURIComponent(p.continuationToken)}`
          : '/v3/conversations');
        const list = Array.isArray(out?.conversations) ? out.conversations : [];
        const lines = list.map((c) => `${c.id}${Array.isArray(c.members) ? ` · ${c.members.length} members` : ''}`);
        if (out?.continuationToken) lines.push(`(more — continuationToken: ${out.continuationToken})`);
        return ok(lines.join('\n') || '(no conversations)');
      } catch (e) { return fail(e); }
    },
  }));

  // Raw Bot Connector access for the OWNER: any method+path the bot credentials can call.
  ctx.registerTool(defineTool({
    name: 'TeamsApi', label: 'Teams Bot Connector API',
    description: 'Call the Bot Connector REST API directly: an HTTP method plus a path like "/v3/conversations/{id}/members", with an optional JSON body — full connector surface. Operator only.',
    parameters: Type.Object({
      method: Type.String({ description: 'HTTP method: GET, POST, PUT or DELETE' }),
      path: Type.String({ description: 'Connector path, e.g. "/v3/conversations" (the service host is implied)' }),
      body: Type.Optional(Type.String({ description: 'JSON request body, e.g. {"type":"message","text":"hi"}' })),
    }),
    execute: async (_id, p) => {
      try {
        ownerGate('TeamsApi');
        let body;
        if (p.body) {
          try { body = JSON.parse(p.body); } catch { return ok('Error: body is not valid JSON.'); }
        }
        const res = await adapter.callApi(String(p.method), String(p.path), body);
        const text = res === undefined || res === null ? '(no content)' : JSON.stringify(res, null, 2);
        return ok(text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text);
      } catch (e) { return fail(e); }
    },
  }));
}
