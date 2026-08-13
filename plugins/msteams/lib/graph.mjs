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
const PERM_INSTALL_APP = 'TeamsAppInstallation.ReadWriteSelfForUser.All';

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
}

function user(raw) {
  return {
    id: String(raw.id),
    displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
    userPrincipalName: (typeof raw.mail === 'string' && raw.mail) || (typeof raw.userPrincipalName === 'string' ? raw.userPrincipalName : ''),
  };
}
