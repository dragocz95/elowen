// Layer 2 — Microsoft Graph. OPTIONAL and off by default.
//
// The Bot Connector alone can only reach people the bot has already seen. Graph closes that gap: it
// translates an e-mail into an Entra object id and can install the Teams app for that user so a 1:1
// chat may be opened. Both calls need APPLICATION permissions with tenant admin consent, and the
// install additionally needs the app published in the org's Teams catalog — conditions an instance
// may simply not meet. So every failure here is translated into what an admin must actually do,
// rather than a forwarded 403, and layer 1 keeps working with this switched off.
import { TokenSource } from './token.mjs';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/** Application permissions each call needs, quoted back to the operator when Graph refuses. */
const PERM_READ_USERS = 'User.ReadBasic.All';
const PERM_READ_PROFILE_PHOTOS = 'ProfilePhoto.Read.All';
const PERM_INSTALL_APP = 'TeamsAppInstallation.ReadWriteSelfForUser.All';
/** Unlike the two above, this one is NOT granted in the Entra portal: it is resource-specific consent,
 *  which a TEAM OWNER approves when the app is installed into their team. Graph accepts it in place of
 *  the tenant-wide ChannelMessage.Read.All, and it is the least-privileged option the reference lists. */
const PERM_READ_CHANNEL_MESSAGES = 'ChannelMessage.Read.Group';

/** Graph caps a replies page at 50 and rejects most OData parameters on that collection. */
const MAX_REPLIES = 50;

const escapeFilter = (value) => String(value).replace(/'/g, "''");

/** What an admin has to do, in the order they have to do it. */
function consentHelp(appId, permission) {
  return `Entra admin center → App registrations → the bot's app (${appId || 'appId not configured'}) → API permissions → Add a permission → Microsoft Graph → Application permissions → "${permission}" → then Grant admin consent for the tenant.`;
}

export class GraphClient {
  constructor(cfg, logger = console) {
    this.cfg = cfg;
    this.log = logger;
    this.tokens = new TokenSource(cfg, GRAPH_SCOPE);
  }

  /** One Graph call. 401/403 throws the admin instructions for `permission`; every other status is
   *  handed back so the caller can branch (a 404 on a user lookup is a normal outcome). */
  async call(method, path, body, permission) {
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.tokens.token()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Microsoft Graph refused this call (${res.status}). The bot needs the APPLICATION permission "${permission}" with admin consent. ${consentHelp(this.cfg?.appId, permission)}`);
    }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    return { status: res.status, ok: res.ok, data };
  }

  /**
   * An e-mail (or UPN) → the tenant user. Tried as a direct read first, because that is one call and
   * covers the common case where the e-mail IS the UPN; a miss falls back to a filtered search, which
   * also finds users whose `mail` differs from their `userPrincipalName`. Returns null when nobody
   * matches, throws when Graph refuses the call.
   */
  async findUser(email) {
    const address = String(email ?? '').trim();
    if (!address) return null;
    const select = '$select=id,displayName,userPrincipalName,mail';
    const direct = await this.call('GET', `/users/${encodeURIComponent(address)}?${select}`, undefined, PERM_READ_USERS);
    if (direct.ok && direct.data?.id) return user(direct.data);
    const quoted = escapeFilter(address);
    const filter = `$filter=${encodeURIComponent(`mail eq '${quoted}' or userPrincipalName eq '${quoted}'`)}`;
    const search = await this.call('GET', `/users?${filter}&${select}`, undefined, PERM_READ_USERS);
    const hits = Array.isArray(search.data?.value) ? search.data.value : [];
    if (hits.length === 1) return user(hits[0]);
    if (hits.length > 1) throw new Error(`Microsoft Graph matched ${hits.length} tenant users for "${address}" — address the person by their Entra object id instead.`);
    return null;
  }

  /** A small directory photo for the admin workspace. Missing photos and missing optional consent are
   * normal: the browser falls back to the linked Elowen account avatar, then initials. */
  async userPhoto(userId) {
    const id = String(userId ?? '').trim();
    if (!id || Date.now() < (this.profilePhotosDeniedUntil ?? 0)) return null;
    const res = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(id)}/photos/48x48/$value`, {
      headers: { authorization: `Bearer ${await this.tokens.token()}` },
    });
    if (res.status === 401 || res.status === 403) {
      this.profilePhotosDeniedUntil = Date.now() + 5 * 60_000;
      this.log?.warn?.(`msteams Graph profile photos unavailable — grant the APPLICATION permission "${PERM_READ_PROFILE_PHOTOS}" with admin consent; linked Elowen avatars remain available`);
      return null;
    }
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    return body.byteLength > 0 && body.byteLength <= 1024 * 1024 ? { body, contentType } : null;
  }

  /**
   * Install the Teams app for a user so the bot may open a 1:1 chat with them. Requires the app's
   * CATALOG id (`graphCatalogAppId`), which is the org-catalog entry — not the bot's app id. An
   * already-installed app answers 409, which is success for our purposes.
   */
  async installApp(userId, catalogAppId) {
    const catalog = String(catalogAppId ?? '').trim();
    if (!catalog) {
      throw new Error('Microsoft Graph app installation needs the Teams catalog app id — set "Teams catalog app id" in the msteams plugin config (Teams admin center → Manage apps → the uploaded Elowen app → its App ID column).');
    }
    const res = await this.call('POST', `/users/${encodeURIComponent(userId)}/teamwork/installedApps`, {
      'teamsApp@odata.bind': `${GRAPH_BASE}/appCatalogs/teamsApps/${catalog}`,
    }, PERM_INSTALL_APP);
    if (res.ok || res.status === 409) return true; // 409 = the user already has it
    if (res.status === 404) {
      throw new Error(`Microsoft Graph could not install the app: catalog app id "${catalog}" was not found. The Elowen Teams app must be uploaded and approved in the org catalog (Teams admin center → Manage apps) before it can be installed for a user.`);
    }
    throw new Error(`Microsoft Graph could not install the app for this user (${res.status}). ${consentHelp(this.cfg?.appId, PERM_INSTALL_APP)}`);
  }

  /** One channel thread as `{ id, name, text }` rows, oldest-first. See {@link readThread}. */
  async readChannelThread(teamGroupId, channelId, rootMessageId, limit) {
    return readThread(this, teamGroupId, channelId, rootMessageId, limit);
  }
}

/**
 * One channel THREAD, oldest-first: the root post followed by its replies.
 *
 * This is the only way to see what was said in a channel before the bot was mentioned — the Bot
 * Connector delivers a conversation's past to nobody, so without this a thread reads as a single
 * message with no context. Failure is NOT fatal to a turn: the caller falls back to whatever the bot
 * itself witnessed, so a tenant that never granted the consent simply keeps the old behaviour.
 *
 * `teamGroupId` is the team's AAD group id (captured from an inbound activity's channelData) — the
 * conversation id alone cannot address this API.
 */
async function readThread(client, teamGroupId, channelId, rootMessageId, limit = MAX_REPLIES) {
  const team = encodeURIComponent(String(teamGroupId));
  const channel = encodeURIComponent(String(channelId));
  const root = encodeURIComponent(String(rootMessageId));
  const base = `/teams/${team}/channels/${channel}/messages/${root}`;
  const top = Math.min(Math.max(Number(limit) || 0, 1), MAX_REPLIES);
  const [head, replies] = await Promise.all([
    client.call('GET', base, undefined, PERM_READ_CHANNEL_MESSAGES),
    client.call('GET', `${base}/replies?$top=${top}`, undefined, PERM_READ_CHANNEL_MESSAGES),
  ]);
  const rows = [
    ...(head.ok && head.data ? [head.data] : []),
    // Replies come back newest-first; the transcript reads oldest-first like every other history block.
    ...(Array.isArray(replies.data?.value) ? [...replies.data.value].reverse() : []),
  ];
  return rows.map(threadMessage).filter((m) => m && m.text);
}

/** A Graph chatMessage → the shape the transcript wants, or null for anything not worth a line:
 *  a deleted message (tombstone with no body) or a system event ("X added Y to the team"). */
function threadMessage(raw) {
  if (!raw || raw.deletedDateTime || raw.messageType !== 'message') return null;
  const attachments = (Array.isArray(raw.attachments) ? raw.attachments : []).slice(0, 8).map((attachment) => ({
    name: String(attachment?.name ?? '').slice(0, 200),
    mimeType: String(attachment?.contentType ?? '').slice(0, 120),
    kind: String(attachment?.contentType ?? '').startsWith('image/') ? 'image' : 'file',
  }));
  const body = raw.body?.contentType === 'html' ? htmlToText(raw.body?.content) : String(raw.body?.content ?? '').trim();
  if (!body && !attachments.length) return null;
  const application = raw.from?.application;
  const user = raw.from?.user;
  const who = user?.displayName || application?.displayName || 'Unknown';
  return {
    id: raw.id ? String(raw.id) : '',
    role: application ? 'assistant' : 'user',
    authorId: String(user?.id || application?.id || ''),
    name: String(who),
    text: body || '[Attachment]',
    attachments,
    timestamp: raw.createdDateTime ? String(raw.createdDateTime) : '',
  };
}

/** Teams stores message bodies as HTML. The transcript is plain text, and a model reading raw markup
 *  would quote tags back — so block-level tags become line breaks and the rest is dropped. */
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function user(raw) {
  return {
    id: String(raw.id),
    displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
    userPrincipalName: (typeof raw.mail === 'string' && raw.mail) || (typeof raw.userPrincipalName === 'string' ? raw.userPrincipalName : ''),
  };
}
