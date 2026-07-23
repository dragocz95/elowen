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

function appManifest(cfg, commands) {
  const name = typeof cfg.agentName === 'string' && cfg.agentName.trim() ? cfg.agentName.trim() : 'Elowen';
  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
    manifestVersion: '1.16',
    version: '1.0.0',
    id: String(cfg.appId),
    developer: {
      name: 'Elowen',
      websiteUrl: 'https://github.com/dragocz95/elowen',
      privacyUrl: 'https://github.com/dragocz95/elowen',
      termsOfUseUrl: 'https://github.com/dragocz95/elowen',
    },
    name: { short: name.slice(0, 30), full: `${name} — personal AI agent` },
    description: {
      short: `${name}, your self-hosted AI agent`,
      full: `Chat with ${name}, a self-hosted Elowen AI agent: ask questions, run tasks in your projects and get live progress right in Teams.`,
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#6264A7',
    bots: [{
      botId: String(cfg.appId),
      scopes: SCOPES,
      supportsFiles: false,
      isNotificationOnly: false,
      commandLists: [{
        scopes: SCOPES,
        commands: commands.slice(0, 10).map((c) => ({
          title: String(c.name).slice(0, 32),
          description: String(c.description ?? c.name).slice(0, 128),
        })),
      }],
    }],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [],
  };
}

/** The uploadable app package ZIP for this bot: Teams manifest (compose-box command list included)
 *  plus the required 192px color and 32px outline icons. */
export function buildAppPackage(cfg, commands = []) {
  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(appManifest(cfg, commands), null, 2), 'utf8') },
    { name: 'color.png', data: solidPng(192, TEAMS_PURPLE) },
    { name: 'outline.png', data: solidPng(32, WHITE) },
  ]);
}
