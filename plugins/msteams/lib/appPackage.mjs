// The sideloadable Teams app package: manifest.json + the two required icons, zipped in-process.
// Hand-rolled on purpose — a stored (uncompressed) ZIP is ~60 lines of framing and the icons are
// generated solid-color PNGs, so no archiver or image dependency is worth carrying for this.
import { deflateSync } from 'node:zlib';

// ── CRC-32 (the standard reflected polynomial) — needed by both ZIP entries and PNG chunks ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── minimal PNG encoder: one solid RGBA color ──

function pngChunk(type, data) {
  const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(head.length + 8);
  out.writeUInt32BE(data.length, 0);
  head.copy(out, 4);
  out.writeUInt32BE(crc32(head), head.length + 4);
  return out;
}

function solidPng(size, [r, g, b, a]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 4)]); // filter byte + pixels
  for (let x = 0; x < size; x++) row.set([r, g, b, a], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── minimal stored (method 0) ZIP writer ──

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);  // compressed = raw (stored)
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── the Teams app manifest ──

const TEAMS_PURPLE = [0x62, 0x64, 0xa7, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const SCOPES = ['personal', 'team', 'groupChat'];
/** Where a slash command is offered at all: Teams builds the `/` menu out of targeted messaging, which
 *  exists only in the shared conversations (channel, group chat, meeting chat). A personal chat has
 *  nobody to hide the message from, so its commands stay on the @mention trigger. */
const GROUP_SCOPES = ['team', 'groupChat'];

/** 1.29 is the first GENERALLY AVAILABLE schema carrying `supportsTargetedMessages` and
 *  `commandLists[].triggers` (1.28 has neither) — verified against the published schema documents, not
 *  the prose. Every property this manifest emits already existed in 1.16, and both schemas set
 *  `additionalProperties: false`, so the version bump is safe in both directions. */
const MANIFEST_VERSION = '1.29';
/** Schema cap per command list (it was 10 before 1.24). */
const MAX_COMMANDS = 12;

const HOME_URL = 'https://github.com/dragocz95/elowen';

/** The instance's own address when it has one — a company catalogue entry that points its developer
 *  links at the upstream project tells the people approving it nothing about who runs this bot. */
function siteUrl() {
  const domain = typeof process.env.ELOWEN_DOMAIN === 'string' ? process.env.ELOWEN_DOMAIN.trim() : '';
  return domain ? `https://${domain}` : HOME_URL;
}

/**
 * The package version, as a build stamp: `1.<YYMMDD>.<HHMM>` in UTC.
 *
 * Teams refuses to update a custom app whose manifest version is not HIGHER than the one already in
 * the catalogue ("This update needs a new app version number"), so a constant `1.0.0` made the package
 * uploadable exactly once — every later fix to the name, the icon or the command list was rejected at
 * the door. A timestamp is monotonic by construction, needs no stored counter, and tells whoever is
 * approving the app in the admin centre exactly which build they are looking at.
 *
 * UTC on purpose: on the autumn DST change a local clock repeats an hour, which would emit a version
 * LOWER than one already uploaded — the exact failure this replaces.
 */
export function packageVersion(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  // Years since 2000 rather than the last two digits: `00` would wrap BELOW `99` at the turn of the
  // century and break the one property this whole scheme exists for.
  const date = `${now.getUTCFullYear() - 2000}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  return `1.${Number(date)}.${Number(`${p(now.getUTCHours())}${p(now.getUTCMinutes())}`)}`;
}

/** The manifest's own shape for a command list. Names travel WITHOUT the leading slash — Teams draws the
 *  `/` itself and inserts the bare title as the message text, so a stored "/help" would reach the bot as
 *  "//help". The schema caps a list at 12 commands and a title at 128 characters. */
function commandEntries(commands) {
  return commands.slice(0, MAX_COMMANDS).map((c) => ({
    title: String(c.name).replace(/^\/+/, '').slice(0, 32),
    description: String(c.description ?? c.name).slice(0, 128),
  }));
}

function appManifest(cfg, commands, now) {
  const name = typeof cfg.agentName === 'string' && cfg.agentName.trim() ? cfg.agentName.trim() : 'Elowen';
  const product = typeof cfg.productName === 'string' && cfg.productName.trim() ? cfg.productName.trim() : name;
  const site = siteUrl();
  return {
    $schema: `https://developer.microsoft.com/en-us/json-schemas/teams/v${MANIFEST_VERSION}/MicrosoftTeams.schema.json`,
    manifestVersion: MANIFEST_VERSION,
    version: packageVersion(now),
    id: String(cfg.appId),
    developer: {
      name: product,
      websiteUrl: site,
      privacyUrl: site,
      termsOfUseUrl: site,
    },
    name: { short: name.slice(0, 30), full: `${name} — personal AI agent` },
    description: {
      short: `${name}, your AI agent`,
      full: `Chat with ${name}, the ${product} AI agent: ask questions, run tasks in your projects and get live progress right in Teams.`,
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#6264A7',
    // REQUIRED from manifest 1.25 for anything claiming the `team` scope — the admin centre refuses the
    // upload without it ("must include the 'supportsChannelFeatures' property"), even though the JSON
    // schema marks it optional, so schema validation alone does not prove a package is installable.
    //
    // `tier1` states that the app treats a channel as its own audience: it never assumes team membership
    // equals channel membership, and reads membership per conversation. That is already how this adapter
    // works — the roster it caches, the history it records and the policies it matches are all keyed on
    // the conversation the message came from — so the claim is true rather than convenient. Declaring the
    // capability does NOT opt the app into shared or private channels; that needs supportedChannelTypes,
    // which stays absent until the behaviour there is actually tested.
    supportsChannelFeatures: 'tier1',
    bots: [{
      botId: String(cfg.appId),
      scopes: SCOPES,
      // Teams refuses to carry a file either way for a bot that does not declare this — it gates both
      // the consent card the bot sends and the download info on a file a person sends it.
      supportsFiles: true,
      isNotificationOnly: false,
      // The switch that puts this bot in the `/` menu at all. Without it Teams offers no targeted
      // messaging, and `triggers: ['slash']` below is quietly ignored — the commands then only ever
      // appear in the older @mention menu, which is exactly the state this replaces.
      supportsTargetedMessages: true,
      commandLists: [
        // `triggers` defaults to ['mention'], so a list that omits it is mention-only. The group scopes
        // take both: the same command is worth having in the `/` menu (private, discoverable) and after
        // an @mention (how people already address the bot).
        { scopes: GROUP_SCOPES, triggers: ['slash', 'mention'], commands: commandEntries(commands) },
        { scopes: ['personal'], triggers: ['mention'], commands: commandEntries(commands) },
      ],
    }],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: cfg.accountLinking === true ? ['token.botframework.com'] : [],
    // Resource-specific consent, declared only when the operator asks for it. ChannelMessage.Read.Group
    // is what Teams accepts INSTEAD of the tenant-wide ChannelMessage.Read.All, and it buys two things
    // at once: the bot starts receiving every message in the channels of a team it is installed in
    // (no @mention needed), and Microsoft Graph starts answering reads of that team's messages —
    // the 403 names this permission itself, under "Resource specific consent grants on the request".
    //
    // Consent is given by a TEAM OWNER when the app is installed or updated in that team, not by a
    // tenant Global Administrator, which is the whole reason this route exists. It follows that
    // turning the setting back off changes nothing on its own: the grant lives with the installed
    // app, so it is withdrawn by re-uploading a package without it (or removing the app).
    //
    // `webApplicationInfo.resource` is required by the schema and otherwise unused — Teams rejects the
    // manifest when it is absent, and ignores what it says.
    ...(cfg.channelMessagesRsc === true
      ? {
        webApplicationInfo: { id: String(cfg.appId), resource: siteUrl() },
        authorization: {
          permissions: {
            resourceSpecific: [{ type: 'Application', name: 'ChannelMessage.Read.Group' }],
          },
        },
      }
      : {}),
  };
}

/** The uploadable app package ZIP for this bot: Teams manifest (compose-box command list included)
 *  plus the required 192px color and 32px outline icons. A branded deployment uses its validated
 *  192px theme artwork; the generated icon remains the safe fallback. */
export function buildAppPackage(cfg, commands = [], now = new Date()) {
  const color = Buffer.isBuffer(cfg.brandIcon) && cfg.brandIcon.length ? cfg.brandIcon : solidPng(192, TEAMS_PURPLE);
  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(appManifest(cfg, commands, now), null, 2), 'utf8') },
    { name: 'color.png', data: color },
    { name: 'outline.png', data: solidPng(32, WHITE) },
  ]);
}
