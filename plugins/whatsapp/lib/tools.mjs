// Admin/owner-gated Whatsapp* tools: outbound messaging and group management.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { toJid } from './jid.mjs';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

export function registerTools(ctx, adapter) {
  const adminGate = () => { if (!ctx.isAdminSession()) throw new Error('available only in an admin session'); };

  // Send a message to any chat — OWNER only (it can message anyone the account can reach).
  ctx.registerTool(defineTool({
    name: 'WhatsappSend', label: 'WhatsApp send message',
    description: 'Send a WhatsApp text message to a chat: a phone number in international format (e.g. 420777123456), a user JID (…@s.whatsapp.net) or a group JID (…@g.us). Operator only.',
    parameters: Type.Object({
      to: Type.String({ description: 'Recipient: phone number, user JID or group JID' }),
      text: Type.String({ description: 'Message text' }),
    }),
    execute: async (_id, p) => {
      try {
        if (ctx.currentIdentity?.()?.owner !== true) throw new Error('WhatsappSend is only available to the operator');
        const sock = adapter.requireSock();
        const jid = toJid(p.to);
        if (!jid) return ok('Error: no recipient.');
        await sock.sendMessage(jid, { text: String(p.text ?? '') });
        return ok(`Sent to ${jid}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WhatsappGroupList', label: 'List WhatsApp groups',
    description: 'List the groups the bot is a participant of (JID, subject, member count) so you can pick one to inspect or message.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const groups = await sock.groupFetchAllParticipating();
        const lines = Object.values(groups ?? {}).map((g) => `${g.id}  ${g.subject ?? ''}  (${g.participants?.length ?? 0} members)`);
        return ok(lines.join('\n') || '(no groups)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WhatsappGroupInfo', label: 'WhatsApp group info',
    description: 'Details of one group by JID (…@g.us): subject, description, owner and the participant list (JID + admin flag).',
    parameters: Type.Object({ groupJid: Type.String({ description: 'Group JID (…@g.us)' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const g = await sock.groupMetadata(p.groupJid);
        const members = (g.participants ?? []).map((m) => `${m.id}${m.admin ? `  [${m.admin}]` : ''}`);
        return ok([
          `id: ${g.id}`, `subject: ${g.subject ?? ''}`,
          g.desc ? `desc: ${g.desc}` : null, g.owner ? `owner: ${g.owner}` : null,
          `participants (${members.length}):`, ...members,
        ].filter(Boolean).join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WhatsappGroupCreate', label: 'Create WhatsApp group',
    description: 'Create a WhatsApp group with a subject and initial members (phone numbers or JIDs). Returns the new group JID.',
    parameters: Type.Object({
      subject: Type.String({ description: 'Group name' }),
      members: Type.Array(Type.String(), { description: 'Phone numbers or user JIDs to add' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const jids = (p.members ?? []).map(toJid).filter(Boolean);
        if (!jids.length) return ok('Error: at least one member is required.');
        const g = await sock.groupCreate(String(p.subject ?? 'Group'), jids);
        return ok(`Created group ${g.id} "${g.subject ?? p.subject}".`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WhatsappGroupAdd', label: 'Add WhatsApp group member',
    description: 'DESTRUCTIVE. Add members (phone numbers or JIDs) to a group by JID. The bot must be a group admin.',
    parameters: Type.Object({
      groupJid: Type.String({ description: 'Group JID (…@g.us)' }),
      members: Type.Array(Type.String(), { description: 'Phone numbers or user JIDs to add' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const jids = (p.members ?? []).map(toJid).filter(Boolean);
        const res = await sock.groupParticipantsUpdate(p.groupJid, jids, 'add');
        return ok(`add → ${JSON.stringify(res)}`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WhatsappGroupRemove', label: 'Remove WhatsApp group member',
    description: 'DESTRUCTIVE. Remove members (phone numbers or JIDs) from a group by JID. The bot must be a group admin.',
    parameters: Type.Object({
      groupJid: Type.String({ description: 'Group JID (…@g.us)' }),
      members: Type.Array(Type.String(), { description: 'Phone numbers or user JIDs to remove' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const jids = (p.members ?? []).map(toJid).filter(Boolean);
        const res = await sock.groupParticipantsUpdate(p.groupJid, jids, 'remove');
        return ok(`remove → ${JSON.stringify(res)}`);
      } catch (e) { return fail(e); }
    },
  }));
}
