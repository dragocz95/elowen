// Admin/owner-gated Teams* tools: outbound messaging, conversation/member inspection and raw
// connector access. All of them ride the Bot Connector API only — no Graph permissions involved,
// except TeamsMessagePerson's optional last resort, which stays behind a config switch that is off.
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
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
  // Two tiers, matching how the Discord plugin splits the same problem.
  //
  // CURATED tools — look up a person, read a roster, send a message, hand over a file — are ordinary
  // work a trusted colleague does, so an admin role reaches them. What a given role may actually call is
  // then narrowed by that role's own tool allowlist, which is where per-person scoping belongs.
  //
  // RAW connector access is the exception and stays with the operator: TeamsApi drives the bot
  // credentials directly and can reconfigure or drain anything they touch. An admin-mapped role is not
  // the same thing as the instance operator — a role is granted in plugin config, the operator is one
  // account — so deriving one from the other would quietly widen the blast radius of every role policy.
  //
  // Both messages say what the caller is missing AND who can grant it; a bare "not allowed" leaves the
  // person guessing which of the two tiers they hit, which is exactly the confusion this replaced.
  const adminGate = (name) => {
    if (ctx.isAdminSession()) return;
    throw new Error(`${name} needs an admin role. The operator grants it by setting "admin": true on your entry in the Microsoft Teams plugin's role policies, and by making sure ${name} is not excluded by that role's tool list.`);
  };
  const ownerGate = (name) => {
    if (ctx.currentIdentity?.()?.owner === true) return;
    throw new Error(`${name} is reserved for the instance operator — a single account (the first admin), not a role. An "admin": true role policy does NOT grant it, because this tool drives the raw bot credentials. Ask the operator to run it, or use TeamsSend / TeamsMessagePerson / TeamsSendFile, which an admin role may call.`);
  };

  // Send a message into any conversation the bot can reach — OWNER only.
  ctx.registerTool(defineTool({
    name: 'TeamsSend', label: 'Teams send message',
    description: 'Send a Microsoft Teams message into a conversation by its conversation id (a chat the bot has already seen). Requires an admin role.',
    parameters: Type.Object({
      conversationId: Type.String({ description: 'Teams conversation id, e.g. "19:…@thread.tacv2" or "a:…"' }),
      text: Type.String({ description: 'Message text (markdown)' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate('TeamsSend');
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
    description: 'Send a Microsoft Teams message directly to a PERSON — addressed by e-mail/UPN, Entra object id, "29:…" account id or display name, no conversation id needed. The bot opens (or reuses) the 1:1 chat itself. Use it for "tell Michal the build broke". An ambiguous name is refused with the candidates rather than guessed — check first with TeamsFindPerson. Requires an admin role.',
    parameters: Type.Object({
      text: Type.String({ description: 'Message text (markdown)' }),
      email: Type.Optional(Type.String({ description: 'The person\'s e-mail / UPN' })),
      aadObjectId: Type.Optional(Type.String({ description: 'The person\'s Entra object id (a GUID)' })),
      userId: Type.Optional(Type.String({ description: 'The person\'s Teams account id ("29:…")' })),
      name: Type.Optional(Type.String({ description: 'The person\'s display name — must match exactly one known person' })),
    }),
    execute: async (_id, p) => {
      try {
        adminGate('TeamsMessagePerson');
        const target = {
          email: p.email ? String(p.email) : undefined,
          aadObjectId: p.aadObjectId ? String(p.aadObjectId) : undefined,
          userId: p.userId ? String(p.userId) : undefined,
          name: p.name ? String(p.name) : undefined,
        };
        if (!target.email && !target.aadObjectId && !target.userId && !target.name) {
          return ok('Error: name the recipient with one of email, aadObjectId, userId or name.');
        }
        const identity = ctx.currentIdentity?.();
        const sender = identity?.elowenUsername || identity?.userId || 'another Elowen agent';
        const { person, conversationId, relay, delivery, deliveredParts, totalParts } = await adapter.messagePerson(target, String(p.text ?? ''), {
          relay: { sender, senderUserId: identity?.elowenUserId },
        });
        const recipient = person.name || person.upn || person.aad || person.id;
        if (delivery === 'agent') return ok(`Delivered to ${recipient} through the recipient’s Elowen agent (chat ${conversationId}).`);
        if (delivery === 'partial') return ok(`The recipient agent ran for ${recipient}, but its Teams reply was incomplete: ${relay.error}`);
        if (delivery === 'direct-partial') return ok(`Teams accepted only ${deliveredParts} of ${totalParts} direct message parts for ${recipient} (chat ${conversationId}); the message was not recorded as fully delivered.`);
        const fallback = relay?.error
          ? ` The recipient agent handoff failed before delivering a reply, so the original message was sent directly: ${relay.error}`
          : relay?.sameAccount
            ? ' The recipient uses the same Elowen account, so the message was sent directly without another agent wake.'
            : relay?.woken
              ? ' The recipient agent produced no reply, so the original message was sent directly.'
              : ' No mapped recipient Elowen account was available, so the message was sent directly.';
        return ok(`Sent to ${recipient} (chat ${conversationId}).${fallback}`);
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
        adminGate('TeamsFindPerson');
        const query = String(p.query ?? '').trim();
        if (!query) return ok('Error: give something to look for.');
        const found = await adapter.lookupPeople(query);
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
        adminGate('TeamsChatInfo');
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
        adminGate('TeamsMembers');
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
        adminGate('TeamsMemberInfo');
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
        adminGate('TeamsListConversations');
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

  // Hand a file to a PERSON — the current Teams sender by default, or an explicit recipient.
  ctx.registerTool(defineTool({
    name: 'TeamsSendFile', label: 'Teams send a file',
    description: 'Send a file from disk to a PERSON in their 1:1 Teams chat. After creating a file for the user in a Teams turn, call this tool with its absolute path instead of returning a sandbox link; with no recipient it automatically targets the current Teams sender. To send elsewhere, address the person by e-mail/UPN, Entra object id, "29:…" account id or display name. Teams shows a consent card first (the file lands in their OneDrive), and the upload happens when they accept, so this tool returns as soon as the offer is posted, not when the file arrives. Files cannot be posted directly into a channel or group chat; omitting the recipient there sends the file privately to the sender. Requires an admin role.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path of the file to send' }),
      email: Type.Optional(Type.String({ description: 'The recipient\'s e-mail / UPN; omit all recipient fields to send to the current Teams sender' })),
      aadObjectId: Type.Optional(Type.String({ description: 'The recipient\'s Entra object id (a GUID)' })),
      userId: Type.Optional(Type.String({ description: 'The recipient\'s Teams account id ("29:…")' })),
      name: Type.Optional(Type.String({ description: 'The recipient\'s display name — must match exactly one known person' })),
      description: Type.Optional(Type.String({ description: 'One line shown on the consent card; defaults to the file name' })),
    }),
    execute: async (_id, p) => {
      try {
        adminGate('TeamsSendFile');
        const target = {
          email: p.email ? String(p.email) : undefined,
          aadObjectId: p.aadObjectId ? String(p.aadObjectId) : undefined,
          userId: p.userId ? String(p.userId) : undefined,
          name: p.name ? String(p.name) : undefined,
        };
        if (!target.email && !target.aadObjectId && !target.userId && !target.name) {
          const identity = ctx.currentIdentity?.();
          if (identity?.platform !== 'msteams' || !identity.userId) {
            return ok('Error: name the recipient with one of email, aadObjectId, userId or name.');
          }
          if (String(identity.userId).startsWith('29:')) target.userId = String(identity.userId);
          else target.aadObjectId = String(identity.userId);
        }
        const filePath = String(p.path);
        if (!isAbsolute(filePath)) return ok('Error: give an absolute path.');
        let data;
        try { data = await readFile(filePath); } catch (e) { return ok(`Error: cannot read ${filePath}: ${e?.message ?? e}`); }
        const person = await adapter.findPerson(target);
        const conversationId = await adapter.conversationForPerson(person);
        await adapter.offerFile(conversationId, basename(filePath), data, p.description ? String(p.description) : undefined);
        return ok(`Offered ${basename(filePath)} (${data.length} bytes) to ${person.name || person.upn || person.aad || person.id}; it uploads once they accept.`);
      } catch (e) { return fail(e); }
    },
  }));

  // Raw Bot Connector access for the OWNER: any method+path the bot credentials can call.
  ctx.registerTool(defineTool({
    name: 'TeamsApi', label: 'Teams Bot Connector API',
    description: 'Call the Bot Connector REST API directly: an HTTP method plus a path like "/v3/conversations/{id}/members", with an optional JSON body — full connector surface. Reserved for the instance operator, because it drives the raw bot credentials; an admin role cannot call it. For sending a message use TeamsSend or TeamsMessagePerson instead.',
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
