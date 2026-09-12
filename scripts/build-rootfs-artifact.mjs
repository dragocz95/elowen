#!/usr/bin/env node
/** Build a published root filesystem artifact, or prove that a rebuild still produces the pinned one.
 *
 *  The machine runtime never builds a root filesystem on the host it serves: it downloads a tarball and
 *  verifies it against a digest pinned in `plugins/sandbox/lib/rootfsArtifacts.json`. This script is what
 *  produces those tarballs and that pin file. It is the only writer of the pin file, which is why the
 *  file says so in its own header.
 *
 *  The whole value of the arrangement rests on one property: the same recipe revision, built on a
 *  different day on a different machine, must produce the same bytes. Otherwise the digest is a record
 *  of one particular afternoon rather than of a recipe, `--verify` can never pass, and nobody can tell a
 *  rebuild from a substitution. Every normalization below exists for that reason and says which drift it
 *  removes, because the failure it prevents is invisible: drop one and the build still succeeds, still
 *  produces a working root filesystem, and simply stops being reproducible.
 *
 *  This script holds no secret and performs no upload. It writes a tarball and a manifest to an output
 *  directory and prints what an operator would publish. Publishing is a separate, owner-approved step.
 *
 *    node scripts/build-rootfs-artifact.mjs --all
 *    node scripts/build-rootfs-artifact.mjs --recipe site-base --out /tmp/rootfs
 *    node scripts/build-rootfs-artifact.mjs --all --verify
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, copyFileSync, createReadStream, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ARTIFACT_BASE_URL, MAX_ARTIFACT_BYTES, ROOTFS_ARTIFACTS, ROOTFS_RECIPES, artifactReference, recipeDigest,
} from '../plugins/sandbox/lib/rootfsCatalog.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Named in the generated file so a reader who opens it knows what to run instead of editing it. */
export const GENERATOR = 'scripts/build-rootfs-artifact.mjs';
export const PIN_FILE = 'plugins/sandbox/lib/rootfsArtifacts.json';
export const MANIFEST_FILE = 'publish-manifest.json';

/** The mirror, pinned to an instant rather than to a suite.
 *
 *  `deb.debian.org` serves whatever bookworm contains today. A recipe built against it is reproducible
 *  for as long as nobody uploads a package, which is to say not at all: the same recipe yields a
 *  different package set tomorrow, a different tree, a different digest, and no way to tell that from a
 *  tampered artifact. `snapshot.debian.org` serves the archive as it stood at one timestamp, so the
 *  package set is a property of this constant instead of a property of the calendar.
 *
 *  Changing this constant changes the bytes every recipe produces. It is therefore a recipe change in
 *  everything but name, and `--verify` is what catches it: a rebuild against a moved snapshot no longer
 *  matches the pin, and CI fails before anything is published. */
export const SNAPSHOT = '20250901T000000Z';

/** Security updates come from the same instant. A shipped root filesystem that people run code inside
 *  should not omit them, and pinning both archives to one timestamp keeps the set deterministic. */
const SECURITY_SUITE = (suite) => `${suite}-security`;

/** The build's notion of "now", derived from the snapshot rather than set separately, so the two cannot
 *  drift apart. `SOURCE_DATE_EPOCH` is the reproducible-builds convention that mmdebstrap documents as
 *  the switch which makes its output reproducible; it clamps file modification times, so a file written
 *  during the build stops carrying the moment it was written. */
export function snapshotEpoch(snapshot = SNAPSHOT) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(snapshot);
  if (!match) throw new Error(`Invalid snapshot timestamp: ${snapshot}`);
  const [, year, month, day, hour, minute, second] = match;
  return Math.floor(Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`) / 1000);
}

export const NODE_DIST = 'https://nodejs.org/dist';

/** Where a built artifact is published, and therefore what `path` in the pin file has to say. One
 *  release per artifact revision: the tag names the recipe and its version, so an older revision stays
 *  downloadable after a newer one exists. */
export function releaseTagFor(name, version) { return `rootfs-${name}-v${version}`; }
export function assetNameFor(name, version) { return `${name}-v${version}.tar.gz`; }
export function releasePathFor(name, version) { return `${releaseTagFor(name, version)}/${assetNameFor(name, version)}`; }

/** A recipe with its base folded in.
 *
 *  `site-static` and `site-node` declare `base: 'site-base'`, and each artifact is a COMPLETE root
 *  filesystem rather than a layer over one: a host unpacks exactly one tarball onto a disk and boots it.
 *  So a based recipe is built as the base's package set plus its own, in one tree, in one pass. Layering
 *  would mean a second unpack, an ordering rule, and a partial state where the base is present and the
 *  overlay is not. */
export function resolveRecipe(name, recipes = ROOTFS_RECIPES) {
  const recipe = Object.hasOwn(recipes, name) ? recipes[name] : null;
  if (!recipe) throw new Error(`Unknown root filesystem recipe: ${name}`);
  if (!recipe.base) {
    return {
      name,
      version: recipe.version,
      suite: recipe.suite,
      variant: recipe.variant,
      packages: [...recipe.packages],
      node: recipe.node ?? null,
      masked: [...(recipe.masked ?? [])],
      enabled: [...(recipe.enabled ?? [])],
      directories: [...(recipe.directories ?? [])],
      base: null,
    };
  }
  const base = resolveRecipe(recipe.base, recipes);
  const union = (left, right) => [...new Set([...left, ...right])];
  return {
    name,
    // The revision is the recipe's OWN, because that is what the reference `site-static@1` names.
    version: recipe.version,
    suite: recipe.suite ?? base.suite,
    variant: recipe.variant ?? base.variant,
    packages: union(base.packages, recipe.packages ?? []),
    node: recipe.node ?? base.node,
    masked: union(base.masked, recipe.masked ?? []),
    enabled: union(base.enabled, recipe.enabled ?? []),
    directories: union(base.directories, recipe.directories ?? []),
    base: recipe.base,
  };
}

// ---------------------------------------------------------------------------------------------------
// Host dependencies
// ---------------------------------------------------------------------------------------------------

/** What a build needs on the host, and the Debian package that supplies each.
 *
 *  `mmdebstrap` rather than `debootstrap`: the recipes declare `variant: 'important'`, which is an
 *  mmdebstrap variant and not one debootstrap has, and mmdebstrap is the one that documents
 *  `SOURCE_DATE_EPOCH` as making its output reproducible. `uidmap` supplies `newuidmap`/`newgidmap`,
 *  without which `--mode=unshare` cannot map the subordinate ids and the build has to run as root. */
export const BUILD_TOOLS = Object.freeze([
  Object.freeze({ command: 'mmdebstrap', package: 'mmdebstrap' }),
  Object.freeze({ command: 'newuidmap', package: 'uidmap' }),
  Object.freeze({ command: 'systemctl', package: 'systemd' }),
  Object.freeze({ command: 'tar', package: 'tar' }),
  Object.freeze({ command: 'gzip', package: 'gzip' }),
]);

/** Whether a bare command name resolves to something executable on PATH. */
export function onPath(command, path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    try { accessSync(join(directory, command), constants.X_OK); return true; }
    catch { /* keep looking */ }
  }
  return false;
}

/** The tools a build needs and this host does not have, with the exact command that installs them.
 *
 *  Named rather than discovered halfway through: a build that starts without `mmdebstrap` gets several
 *  minutes in, fails inside a hook, and leaves a partial tree behind. The operator's next question is
 *  always which package supplies the missing binary, so the answer is the message. */
export function missingBuildTools(present = onPath, tools = BUILD_TOOLS) {
  return tools.filter((tool) => !present(tool.command));
}

export function installHint(missing) {
  const packages = [...new Set(missing.map((tool) => tool.package))].sort();
  return `sudo apt-get install -y ${packages.join(' ')}`;
}

/** Refuse to start a build this host cannot finish.
 *
 *  Checked immediately before the first build rather than at startup, because `--verify` over a
 *  catalogue with nothing published rebuilds nothing and therefore needs none of these. Demanding them
 *  anyway would make the CI check fail on every runner for a build it was never going to run. */
export function ensureBuildTools(present = onPath) {
  const missing = missingBuildTools(present);
  if (missing.length === 0) return;
  const names = missing.map((tool) => tool.command).join(', ');
  throw Object.assign(
    new Error(`This host cannot build a root filesystem: ${names} ${missing.length === 1 ? 'is' : 'are'} not installed.\n\n  ${installHint(missing)}`),
    { code: 'missing_build_tools' },
  );
}

// ---------------------------------------------------------------------------------------------------
// Reading an archive
// ---------------------------------------------------------------------------------------------------

const BLOCK = 512;

/** tar's type flags, as the inspection wants to talk about them. */
const ENTRY_TYPES = new Map([
  ['0', 'file'], ['\0', 'file'], ['7', 'file'],
  ['1', 'hardlink'], ['2', 'symlink'], ['3', 'char'], ['4', 'block'], ['5', 'directory'], ['6', 'fifo'],
]);

/** A tar header field that may be octal text or, for values too large for it, base-256. */
function numericField(block, offset, length) {
  if ((block[offset] & 0x80) !== 0) {
    let value = 0n;
    for (let at = offset; at < offset + length; at += 1) {
      value = (value << 8n) | BigInt(at === offset ? block[at] & 0x7f : block[at]);
    }
    return Number(value);
  }
  const text = block.toString('ascii', offset, offset + length).replace(/\0/g, ' ').trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function textField(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.toString('utf8', 0, end === -1 ? field.length : end);
}

/** pax extended header records: `"<length> <key>=<value>\n"`, repeated. */
function paxRecords(buffer) {
  const records = new Map();
  let at = 0;
  while (at < buffer.length) {
    const space = buffer.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(buffer.toString('ascii', at, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > buffer.length) break;
    const record = buffer.toString('utf8', space + 1, at + length - 1);
    const separator = record.indexOf('=');
    if (separator > 0) records.set(record.slice(0, separator), record.slice(separator + 1));
    at += length;
  }
  return records;
}

/** Read an uncompressed tar stream and report what is in it.
 *
 *  A real parser over the format's own fixed-width binary headers rather than the text of `tar -tv`,
 *  which loses the distinction between a zero-length name and an absent one, reformats modes, and
 *  localizes dates. Member DATA is skipped, so memory stays bounded no matter how large the archive is;
 *  `capture` names the few members whose contents the caller actually needs.
 *
 *  Handles GNU long names, pax path overrides and base-256 numeric fields, because a Debian root
 *  filesystem contains paths past the 100-byte header field and archivers differ in how they spell that. */
export async function readTar(source, options = {}) {
  const capture = options.capture ?? (() => false);
  const captureLimit = options.captureLimit ?? 8 * 1024 * 1024;
  const entries = [];
  const captured = new Map();

  let pending = Buffer.alloc(0);
  let awaitingData = null;
  let remaining = 0;
  let padding = 0;
  let longName = null;
  let longLink = null;
  let pax = null;

  for await (const chunk of source) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (remaining > 0) {
        const take = Math.min(remaining, pending.length);
        if (awaitingData) {
          awaitingData.bytes += take;
          // Refused rather than truncated. A silently short capture would be parsed as a valid but
          // incomplete package list, and an artifact's provenance would understate what is inside it.
          if (awaitingData.bytes > captureLimit) {
            throw new Error(`${awaitingData.name} is larger than the ${captureLimit} byte capture bound`);
          }
          awaitingData.chunks.push(pending.subarray(0, take));
        }
        pending = pending.subarray(take);
        remaining -= take;
        if (remaining > 0) break;
        if (awaitingData) { awaitingData.finish(Buffer.concat(awaitingData.chunks)); awaitingData = null; }
      }
      if (padding > 0) {
        const take = Math.min(padding, pending.length);
        pending = pending.subarray(take);
        padding -= take;
        if (padding > 0) break;
      }
      if (pending.length < BLOCK) break;
      const header = pending.subarray(0, BLOCK);
      pending = pending.subarray(BLOCK);
      // Two all-zero blocks end the archive; one is enough to stop reading members.
      if (header.every((byte) => byte === 0)) return { entries, captured };

      const type = String.fromCharCode(header[156]);
      const size = numericField(header, 124, 12);
      const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;

      if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
        // Metadata members: their data describes the NEXT member, so it is always read in full.
        awaitingData = {
          name: `a ${type} metadata member`,
          chunks: [],
          bytes: 0,
          finish: (body) => {
            if (type === 'L') longName = body.toString('utf8').replace(/\0+$/, '');
            else if (type === 'K') longLink = body.toString('utf8').replace(/\0+$/, '');
            else if (type === 'x') pax = paxRecords(body);
            // A 'g' global header is read and discarded: nothing here depends on archive-wide defaults.
          },
        };
        remaining = size;
        padding = dataBlocks - size;
        continue;
      }

      const prefix = textField(header, 345, 155);
      const rawName = textField(header, 0, 100);
      const name = longName ?? pax?.get('path') ?? (prefix ? `${prefix}/${rawName}` : rawName);
      const linkName = longLink ?? pax?.get('linkpath') ?? textField(header, 157, 100);
      const paxMtime = pax?.get('mtime');
      const entry = {
        name,
        type: ENTRY_TYPES.get(type) ?? 'other',
        mode: numericField(header, 100, 8) & 0o7777,
        uid: numericField(header, 108, 8),
        gid: numericField(header, 116, 8),
        size: pax?.has('size') ? Number(pax.get('size')) : size,
        mtime: paxMtime === undefined ? numericField(header, 136, 12) : Math.floor(Number(paxMtime)),
        // Empty is what `--numeric-owner` writes. A name here is a build-host lookup baked into the bytes.
        uname: textField(header, 265, 32),
        gname: textField(header, 297, 32),
        linkName,
      };
      longName = null;
      longLink = null;
      pax = null;
      entries.push(entry);

      if (entry.type === 'file' && size > 0 && capture(entry.name)) {
        awaitingData = { name: entry.name, chunks: [], bytes: 0, finish: (body) => captured.set(entry.name, body) };
      }
      remaining = size;
      padding = dataBlocks - size;
    }
  }
  return { entries, captured };
}

// ---------------------------------------------------------------------------------------------------
// Pack inspection
// ---------------------------------------------------------------------------------------------------

/** A member name as a path relative to the archive root, or null when it escapes the archive. */
function archivePath(name) {
  if (name.startsWith('/')) return null;
  const parts = [];
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (parts.length === 0) return null; parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}

/** Where a link target lands, with the archive root standing in for `/`.
 *
 *  An ABSOLUTE target is normal and safe inside a root filesystem: `/usr/bin/awk` pointing at
 *  `/etc/alternatives/awk` resolves inside the tree once the tree is `/`, and every Debian rootfs is
 *  full of them. What escapes is a RELATIVE target with more `..` components than it has depth, which
 *  reaches the host during any unpack that follows links. Both are resolved here against the same root
 *  so the answer is about the tree rather than about the spelling. */
function linkTarget(fromName, target) {
  if (target.startsWith('/')) return archivePath(target.slice(1));
  const base = archivePath(fromName);
  if (base === null) return null;
  const parent = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  return archivePath(parent ? `${parent}/${target}` : target);
}

/** Whether a systemd unit is masked: `/etc/systemd/system/<unit>` is a symlink to `/dev/null`. */
function maskedUnits(byPath) {
  const masked = new Set();
  for (const [path, entry] of byPath) {
    if (entry.type !== 'symlink' || entry.linkName !== '/dev/null') continue;
    if (!path.startsWith('etc/systemd/system/')) continue;
    const unit = path.slice('etc/systemd/system/'.length);
    if (!unit.includes('/')) masked.add(unit);
  }
  return masked;
}

/** Whether a unit is enabled: some `.wants` or `.requires` directory under `/etc/systemd/system` holds
 *  a symlink named after it. That is what `systemctl enable` writes, and it is what systemd reads. */
function enabledUnits(byPath) {
  const enabled = new Set();
  for (const [path, entry] of byPath) {
    if (entry.type !== 'symlink' || !path.startsWith('etc/systemd/system/')) continue;
    const rest = path.slice('etc/systemd/system/'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) continue;
    const directory = rest.slice(0, slash);
    if (!directory.endsWith('.wants') && !directory.endsWith('.requires')) continue;
    enabled.add(rest.slice(slash + 1));
  }
  return enabled;
}

/** Everything that has to be true of an archive before its digest is allowed to become a pin.
 *
 *  A digest certifies bytes, not usability. Without this, a recipe that silently failed to install
 *  systemd, or a tree whose root came out at 0700, would be pinned exactly as confidently as a good one,
 *  and the failure would surface as a machine that will not boot on whoever created the next
 *  environment. Every check below is a defect that has either happened or is one flag away.
 *
 *  Returns the problems rather than throwing, so a build reports all of them at once instead of one per
 *  attempt, and so the rules can be tested against fixtures. */
export function inspectPack(entries, recipe, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  const sourceDateEpoch = options.sourceDateEpoch ?? null;
  const problems = [];
  const problem = (code, detail) => problems.push({ code, detail });

  const byPath = new Map();
  let unpackedBytes = 0;
  let root = null;
  let previousName = null;
  let sorted = true;

  for (const entry of entries) {
    if (previousName !== null && entry.name < previousName) sorted = false;
    previousName = entry.name;

    const path = archivePath(entry.name);
    if (path === null) { problem('name_escapes', entry.name); continue; }
    if (path === '') { root = entry; continue; }
    byPath.set(path, entry);
    unpackedBytes += entry.size;

    if (entry.type === 'char' || entry.type === 'block' || entry.type === 'fifo') {
      problem('device_node', `${entry.name} is a ${entry.type} node`);
    }
    if (entry.type === 'symlink' && linkTarget(entry.name, entry.linkName) === null) {
      problem('symlink_escapes', `${entry.name} -> ${entry.linkName}`);
    }
    if (entry.type === 'hardlink' && archivePath(entry.linkName) === null) {
      problem('hardlink_escapes', `${entry.name} -> ${entry.linkName}`);
    }
    if (entry.uname !== '' || entry.gname !== '') {
      problem('owner_name_recorded', `${entry.name} records ${entry.uname || '-'}:${entry.gname || '-'}`);
    }
    if (sourceDateEpoch !== null && entry.mtime > sourceDateEpoch) {
      problem('mtime_not_clamped', `${entry.name} is stamped ${entry.mtime}, after ${sourceDateEpoch}`);
    }
  }

  // The root member, and its mode. An archive whose `./` entry is 0700 rewrites the mode of the
  // directory it is unpacked into, and nothing about what follows looks like a permission problem:
  // root traverses anyway so the machine boots, then dbus-daemon drops to `messagebus`, cannot resolve
  // a single path, never sends its readiness notification, times out after ninety seconds with a live
  // process and a live socket, and restarts forever. See the long comment in `nspawnMaterialize` in
  // scripts/elowen-site-gateway.mjs, which is where that was paid for.
  if (!root) problem('root_missing', 'the archive carries no root member');
  else if (root.type !== 'directory') problem('root_missing', `the root member is a ${root.type}`);
  else if (root.mode !== 0o755) problem('root_mode', `the root member is ${root.mode.toString(8).padStart(4, '0')}, not 0755`);

  for (const directory of recipe.directories ?? []) {
    const path = archivePath(directory.replace(/^\//, ''));
    const entry = path === null ? undefined : byPath.get(path);
    if (!entry || entry.type !== 'directory') problem('missing_directory', directory);
  }

  const masked = maskedUnits(byPath);
  for (const unit of recipe.masked ?? []) if (!masked.has(unit)) problem('unit_not_masked', unit);
  const enabled = enabledUnits(byPath);
  for (const unit of recipe.enabled ?? []) if (!enabled.has(unit)) problem('unit_not_enabled', unit);

  const machineId = byPath.get('etc/machine-id');
  if (!machineId) problem('machine_id_missing', '/etc/machine-id is absent');
  // Empty rather than merely different: systemd reads an empty machine-id as "first boot" and generates
  // one per machine. A populated file would give every environment on every host the same identity, and
  // would put a random value into the digest.
  else if (machineId.size !== 0) problem('machine_id_not_empty', `/etc/machine-id holds ${machineId.size} bytes`);

  if (!sorted) problem('unsorted', 'members are not in ascending name order');
  if (unpackedBytes > maxBytes) problem('too_large', `${unpackedBytes} unpacked bytes exceed the ${maxBytes} bound`);

  return { problems, unpackedBytes, memberCount: entries.length };
}

/** The same inspection, as the build's hard gate. A failed inspection pins nothing. */
export function assertPack(entries, recipe, options = {}) {
  const report = inspectPack(entries, recipe, options);
  if (report.problems.length === 0) return report;
  const listed = report.problems.slice(0, 40).map((item) => `  ${item.code}: ${item.detail}`).join('\n');
  const more = report.problems.length > 40 ? `\n  ... and ${report.problems.length - 40} more` : '';
  throw Object.assign(
    new Error(`The built root filesystem for ${recipe.name} is not usable as a machine root:\n${listed}${more}`),
    { code: 'pack_inspection_failed', problems: report.problems },
  );
}

/** Which packages the archive actually contains, read out of the dpkg database it shipped with.
 *
 *  Taken from the archive rather than from what the build host believed it installed, because the
 *  archive is what gets published and the two can differ. The format is dpkg's own: stanzas separated by
 *  a blank line, `Field: value` within one. */
export function installedPackages(statusFile) {
  if (!statusFile) return [];
  const packages = [];
  for (const stanza of statusFile.toString('utf8').split('\n\n')) {
    if (!stanza.trim()) continue;
    const fields = new Map();
    for (const line of stanza.split('\n')) {
      if (line.startsWith(' ') || line.startsWith('\t')) continue;
      const separator = line.indexOf(':');
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    if (fields.get('Status') !== 'install ok installed') continue;
    const name = fields.get('Package');
    const version = fields.get('Version');
    if (name && version) packages.push({ name, version });
  }
  return packages.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------------------------------

/** Fetch a Node release and verify it against the checksum Node publishes for that release.
 *
 *  The catalogue deliberately carries no checksum for Node: one written into a source file by hand is a
 *  value nobody re-derives and everybody trusts. The authority is `SHASUMS256.txt` in the release
 *  directory, and what this actually used is recorded in the artifact's provenance so a later rebuild
 *  can be compared against it rather than against a hope. */
export async function fetchVerifiedNode(version, directory, options = {}) {
  const get = options.fetchImpl ?? globalThis.fetch;
  const base = `${options.dist ?? NODE_DIST}/v${version}`;
  const file = `node-v${version}-linux-x64.tar.gz`;

  const sumsUrl = `${base}/SHASUMS256.txt`;
  const sumsResponse = await get(sumsUrl);
  if (!sumsResponse.ok) throw new Error(`Could not fetch ${sumsUrl}: HTTP ${sumsResponse.status}`);
  const sums = await sumsResponse.text();
  // `<sha256>  <filename>`, one per line, for every asset of the release.
  const line = sums.split('\n').map((text) => text.trim()).find((text) => text.endsWith(` ${file}`));
  const expected = line?.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`${sumsUrl} carries no sha256 for ${file}`);
  }

  const tarballUrl = `${base}/${file}`;
  const tarballResponse = await get(tarballUrl);
  if (!tarballResponse.ok) throw new Error(`Could not fetch ${tarballUrl}: HTTP ${tarballResponse.status}`);
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`${tarballUrl} hashed to ${actual} where ${sumsUrl} publishes ${expected}`);
  }

  const path = join(directory, file);
  writeFileSync(path, bytes, { mode: 0o644 });
  return { version, file, sha256: actual, source: tarballUrl, checksums: sumsUrl, path };
}

// ---------------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------------

function run(command, args, options = {}) {
  const stdout = options.capture ? 'pipe' : options.stdout ?? 'inherit';
  const result = spawnSync(command, args, {
    stdio: ['ignore', stdout, options.capture ? 'pipe' : 'inherit'],
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.toString('utf8').slice(-4000)}` : '';
    throw new Error(`${command} exited with ${result.status ?? `signal ${result.signal}`}${stderr}`);
  }
  return result.stdout ? result.stdout.toString('utf8') : '';
}

/** sha256 of a file, read as a stream. These archives are measured in gigabytes; reading one into a
 *  Buffer to hash it would need as much memory as the artifact is large. */
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

/** The hook mmdebstrap runs inside its own namespace once the packages are installed.
 *
 *  It exists for the things mmdebstrap does not do and the things only this project knows: the two files
 *  its manual explicitly says are copied from the build host, the recipe's own directories and units,
 *  Node, and the handful of files that record when or where a build happened. Written as a script rather
 *  than an inline command so nothing here depends on how a shell would split it. */
function hookScript(recipe, nodeTarball, sourceDateEpoch) {
  const lines = [
    '#!/bin/sh',
    '# Generated by scripts/build-rootfs-artifact.mjs. $1 is the chroot, seen from inside the build',
    '# namespace, so ids here are the guest\'s own.',
    'set -eu',
    'root="$1"',
    '',
    '# mmdebstrap copies both of these from the build host; its manual names them as the reason two',
    '# otherwise identical builds differ. systemd-nspawn supplies both to the machine at boot anyway.',
    'printf \'localhost\\n\' > "$root/etc/hostname"',
    ': > "$root/etc/resolv.conf"',
    '',
    '# What mmdebstrap\'s own cleanup/run stage would do, done here instead because that stage is',
    '# skipped: it runs after this hook and would take the recipe\'s /run directories with it.',
    'rm -rf "$root/run"/* "$root/run"/.[!.]* 2>/dev/null || true',
    '',
  ];

  for (const directory of recipe.directories) {
    lines.push(`mkdir -p "$root${directory}"`, `chmod 0755 "$root${directory}"`);
  }
  lines.push('');

  // `systemctl --root` is systemd's own offline mode: it reads the unit's [Install] section out of the
  // tree and writes the same symlinks a running system would. Deriving the .wants directory by hand
  // would mean re-implementing that and getting `systemd-networkd.socket` (sockets.target) wrong.
  for (const unit of recipe.masked) lines.push(`systemctl --root="$root" mask ${unit}`);
  for (const unit of recipe.enabled) lines.push(`systemctl --root="$root" enable ${unit}`);
  lines.push('');

  if (nodeTarball) {
    lines.push(
      '# Node is not in Debian at the version this project needs. Ownership is forced to 0:0 numerically',
      '# because the upstream tarball records the ids of whoever built it.',
      `tar --extract --file "${nodeTarball}" --directory "$root/usr/local" --strip-components=1 \\`,
      '  --owner=0 --group=0 --numeric-owner --no-same-owner',
      '',
    );
  }

  lines.push(
    '# The shadow databases record the day each account last changed its password, as days since the',
    '# epoch. That is the build date, so an untouched shadow file alone makes every build differ.',
    `day=$(( ${sourceDateEpoch} / 86400 ))`,
    'for file in shadow shadow- gshadow gshadow-; do',
    '  [ -f "$root/etc/$file" ] || continue',
    '  awk -F: -v OFS=: -v day="$day" \'NF>2 { $3=day } { print }\' "$root/etc/$file" > "$root/etc/$file.tmp"',
    '  cat "$root/etc/$file.tmp" > "$root/etc/$file"',
    '  rm -f "$root/etc/$file.tmp"',
    'done',
    '',
    '# Caches keyed by the build host rather than by its contents. aux-cache stores device and inode',
    '# numbers; random-seed is random by definition; __pycache__ embeds the source mtime it was built',
    '# from. All three are regenerated on the guest at runtime.',
    'rm -f "$root/var/cache/ldconfig/aux-cache"',
    'rm -f "$root/var/lib/systemd/random-seed"',
    'find "$root" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true',
    'find "$root/var/log" -type f -exec sh -c \': > "$1"\' _ {} \\; 2>/dev/null || true',
  );
  return `${lines.join('\n')}\n`;
}

/** Build one recipe and return everything a manifest needs to say about it. */
async function buildRecipe(name, options) {
  const recipe = resolveRecipe(name);
  const reference = artifactReference(name);
  const sourceDateEpoch = snapshotEpoch();
  const workspace = mkdtempSync(join(tmpdir(), `elowen-rootfs-${name}-`));
  const log = options.log;

  try {
    let node = null;
    if (recipe.node) {
      log(`  fetching node v${recipe.node.version} and verifying it against SHASUMS256.txt`);
      node = await fetchVerifiedNode(recipe.node.version, workspace, options);
      log(`  node v${node.version} sha256 ${node.sha256}`);
    }

    const hookPath = join(workspace, 'customize-hook.sh');
    writeFileSync(hookPath, hookScript(recipe, node?.path ?? null, sourceDateEpoch), { mode: 0o755 });

    const mirror = `${options.snapshotBase ?? 'https://snapshot.debian.org/archive'}/debian/${SNAPSHOT}/`;
    const security = `deb ${options.snapshotBase ?? 'https://snapshot.debian.org/archive'}/debian-security/${SNAPSHOT}/ ${SECURITY_SUITE(recipe.suite)} main`;
    const tarPath = join(workspace, `${name}.tar`);

    const args = [
      // Unprivileged, in user and mount namespaces, so the build needs no root and the tree still
      // records the guest's own ids rather than the builder's.
      '--mode=unshare',
      // A plain tar, written by mmdebstrap after its own cleanup stage. The extension deliberately
      // carries no compression: gzip is applied separately below, where its header can be controlled.
      '--format=tar',
      `--variant=${recipe.variant}`,
      '--components=main',
      // A snapshot's Release file is long past its Valid-Until by the time it is useful. Refusing it
      // would make a pinned mirror unusable, which is the opposite of what pinning is for.
      '--aptopt=Acquire::Check-Valid-Until "false"',
      // Retries are off: a mirror that answers differently on the second attempt is exactly the drift
      // this build exists to exclude, and a half-answered download must fail rather than be patched up.
      '--aptopt=Acquire::Retries "0"',
      // The customize hook runs BEFORE cleanup, and cleanup/run empties /run. A recipe that declares
      // /run/elowen would have it created and then removed, and the inspection would refuse the result
      // on every build. The hook does that stage's work itself, in an order that survives.
      '--skip=cleanup/run',
      `--customize-hook=${hookPath}`,
    ];
    if (recipe.packages.length > 0) args.push(`--include=${recipe.packages.join(',')}`);
    args.push(recipe.suite, tarPath, mirror, security);

    log(`  mmdebstrap ${recipe.suite} (${recipe.variant}) from ${mirror}`);
    run('mmdebstrap', args, {
      env: {
        ...process.env,
        // The documented switch that makes mmdebstrap's output reproducible: it clamps modification
        // times so nothing in the tree records the moment it was written.
        SOURCE_DATE_EPOCH: String(sourceDateEpoch),
        // C collation and UTC, so anything that sorts or prints a date inside the build does it the
        // same way on a host with a different locale or timezone.
        LC_ALL: 'C',
        LANG: 'C',
        TZ: 'UTC',
      },
    });

    log('  inspecting the archive');
    const { entries, captured } = await readTar(createReadStream(tarPath), {
      capture: (member) => archivePath(member) === 'var/lib/dpkg/status',
    });
    const report = assertPack(entries, recipe, { sourceDateEpoch });
    const status = [...captured.entries()].find(([member]) => archivePath(member) === 'var/lib/dpkg/status');
    const packages = installedPackages(status?.[1]);

    // gzip, with the two header fields that would otherwise differ turned off: `-n` writes neither the
    // original file name nor a modification time, and a fixed level keeps the deflate stream itself
    // stable. gzip rather than zstd because tar detects both but Debian installs only one.
    mkdirSync(options.outDir, { recursive: true });
    const gzPath = join(workspace, assetNameFor(name, recipe.version));
    const target = openSync(gzPath, 'w', 0o644);
    try { run('gzip', ['-n', '-9', '-c', tarPath], { stdout: target }); }
    finally { closeSync(target); }

    const published = join(options.outDir, assetNameFor(name, recipe.version));
    copyFileSync(gzPath, published);

    const digest = await digestFile(published);
    // The digest of the UNCOMPRESSED tar as well, so a mismatch can be attributed. Identical trees
    // compressed by different gzip builds differ in `digest` and agree in `treeDigest`, which is a
    // compressor difference; a differing `treeDigest` is a genuinely different root filesystem.
    const treeDigest = await digestFile(tarPath);

    return {
      reference,
      recipe: name,
      version: recipe.version,
      base: recipe.base,
      recipeDigest: recipeDigest(name),
      baseRecipeDigest: recipe.base ? recipeDigest(recipe.base) : null,
      digest,
      treeDigest,
      sizeBytes: statSync(published).size,
      unpackedBytes: report.unpackedBytes,
      memberCount: report.memberCount,
      path: releasePathFor(name, recipe.version),
      releaseTag: releaseTagFor(name, recipe.version),
      asset: assetNameFor(name, recipe.version),
      suite: recipe.suite,
      variant: recipe.variant,
      snapshot: SNAPSHOT,
      sourceDateEpoch,
      packages,
      node,
      output: published,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------
// Manifest and pins
// ---------------------------------------------------------------------------------------------------

/** One document per build run, recording what was produced and from what.
 *
 *  This is the provenance a person consults a year later to answer whether a rebuild matches: the recipe
 *  revision and fingerprint it came from, the snapshot it resolved against, every package version that
 *  ended up inside, the Node checksum that was actually verified, and the exact bytes and length that
 *  were published. The pin file is derived from it, never the other way round. */
export function publishManifest(artifacts, context = {}) {
  return {
    $generator: GENERATOR,
    builtAt: context.builtAt ?? new Date().toISOString(),
    baseUrl: context.baseUrl ?? ARTIFACT_BASE_URL,
    snapshot: SNAPSHOT,
    sourceDateEpoch: snapshotEpoch(),
    toolchain: context.toolchain ?? {},
    artifacts: artifacts.map(({ output: _output, ...artifact }) => artifact),
  };
}

/** The pin table, derived from a manifest and merged over what is already pinned.
 *
 *  Merged rather than replaced, because a run that builds one recipe must not unpin the other three. An
 *  entry a run did not produce keeps whatever it had. */
export function pinsFrom(manifest, existing = ROOTFS_ARTIFACTS) {
  const artifacts = {};
  for (const [reference, entry] of Object.entries(existing)) {
    artifacts[reference] = { digest: entry.digest, sizeBytes: entry.sizeBytes, path: entry.path };
  }
  for (const artifact of manifest.artifacts) {
    artifacts[artifact.reference] = { digest: artifact.digest, sizeBytes: artifact.sizeBytes, path: artifact.path };
  }
  return {
    $generated: 'Generated file. Do not edit by hand. Every digest here was produced by a build that inspected the archive it hashed; a digest typed in by a person is a pin nobody can reproduce and nothing can check.',
    $generator: GENERATOR,
    $consumer: 'plugins/sandbox/lib/rootfsCatalog.mjs',
    artifacts: Object.fromEntries(Object.keys(artifacts).sort().map((reference) => [reference, artifacts[reference]])),
  };
}

// ---------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------

/** Rebuild each recipe and compare what comes out against what is pinned.
 *
 *  `build` is injected so the comparison can be exercised without a root filesystem: this is the part
 *  that has to be right, and it is the part that a real build makes expensive to test. It needs no
 *  credential of any kind, which is why CI can run it.
 *
 *  An unpublished pin is skipped rather than compared: a recipe this release declares but has never
 *  published has no recorded digest to differ from, and that is the catalogue's ordinary state before the
 *  first release.
 *
 *  Skipped is NOT passed, and `ok` says so. Every pin in this release is unpublished today, so a verify
 *  that treated "nothing to compare" as success rebuilt nothing, never reached `ensureBuildTools`, and
 *  exited 0 — a green CI line standing for no verification at all, which is worse than a missing one
 *  because it is believed. `verified` is what the gate is: a run that compared nothing did not pass. */
export async function verifyArtifacts({ names, pins = ROOTFS_ARTIFACTS, build, log = () => {} }) {
  const matched = [];
  const differing = [];
  const unpublished = [];
  const missing = [];

  for (const name of names) {
    const reference = artifactReference(name);
    const pin = Object.hasOwn(pins, reference) ? pins[reference] : null;
    if (!pin) {
      missing.push({ reference, detail: 'the pin file carries no entry for this recipe' });
      log(`  ${reference}: NO PIN ENTRY`);
      continue;
    }
    if (!pin.digest || !pin.sizeBytes) {
      unpublished.push({ reference });
      log(`  ${reference}: declared but never published, nothing to compare against`);
      continue;
    }
    const built = await build(name);
    if (built.digest === pin.digest && built.sizeBytes === pin.sizeBytes) {
      matched.push({ reference, digest: built.digest });
      log(`  ${reference}: matches ${pin.digest}`);
      continue;
    }
    differing.push({
      reference,
      pinned: { digest: pin.digest, sizeBytes: pin.sizeBytes },
      built: { digest: built.digest, sizeBytes: built.sizeBytes },
      treeDigest: built.treeDigest ?? null,
    });
    log(`  ${reference}: REBUILD DIFFERS — pinned ${pin.digest} (${pin.sizeBytes} bytes), built ${built.digest} (${built.sizeBytes} bytes)`);
  }

  return {
    matched,
    differing,
    unpublished,
    missing,
    verified: matched.length,
    ok: matched.length > 0 && differing.length === 0 && missing.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------

export function parseArguments(argv) {
  const options = { recipes: [], all: false, verify: false, outDir: null, help: false };
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    if (argument === '--all') options.all = true;
    else if (argument === '--verify') options.verify = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--recipe') options.recipes.push(argv[++at]);
    else if (argument.startsWith('--recipe=')) options.recipes.push(argument.slice('--recipe='.length));
    else if (argument === '--out' || argument.startsWith('--out=')) {
      options.outDir = argument === '--out' ? argv[++at] : argument.slice('--out='.length);
      if (!options.outDir) throw new Error('--out needs a directory');
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (options.all && options.recipes.length > 0) throw new Error('Pass either --all or --recipe, not both');
  if (!options.all && options.recipes.length === 0) throw new Error('Pass --all or --recipe <name>');
  for (const name of options.recipes) {
    if (name === undefined) throw new Error('--recipe needs a recipe name');
    if (!Object.hasOwn(ROOTFS_RECIPES, name)) {
      throw new Error(`Unknown recipe ${name}; this release declares ${Object.keys(ROOTFS_RECIPES).join(', ')}`);
    }
  }
  return options;
}

const USAGE = `Build a published root filesystem artifact, or verify a rebuild against its pin.

  node ${GENERATOR} --all [--out <dir>]
  node ${GENERATOR} --recipe <name> [--out <dir>]
  node ${GENERATOR} --all --verify

  --recipe <name>   Build one recipe (${Object.keys(ROOTFS_RECIPES).join(', ')}). Repeatable.
  --all             Build every recipe this release declares.
  --out <dir>       Where the tarball and manifest are written. Default .artifacts/rootfs.
  --verify          Rebuild and compare against the recorded pin. Exits non-zero on any difference, and
                    on a run that compared nothing because no recipe has a published pin.

This script never uploads anything and holds no credential. Publishing a built artifact is a separate,
owner-approved step.
`;

async function main(argv = process.argv.slice(2)) {
  try { return await dispatch(argv); }
  catch (cause) {
    if (cause.code !== 'missing_build_tools') throw cause;
    process.stderr.write(`${cause.message}\n\n`);
    return 1;
  }
}

async function dispatch(argv) {
  const log = (message) => process.stdout.write(`${message}\n`);
  let options;
  try { options = parseArguments(argv); }
  catch (cause) { process.stderr.write(`${cause.message}\n\n${USAGE}`); return 2; }
  if (options.help) { log(USAGE); return 0; }

  const names = options.all ? Object.keys(ROOTFS_RECIPES) : options.recipes;
  const outDir = resolve(options.outDir ?? join(repositoryRoot, '.artifacts', 'rootfs'));
  const build = (name) => { ensureBuildTools(); return buildRecipe(name, { outDir, log }); };

  if (options.verify) {
    log(`Verifying ${names.length} recipe(s) against ${PIN_FILE}`);
    const result = await verifyArtifacts({ names, build, log });
    if (result.ok) {
      log(`\n${result.verified} verified against their pin, ${result.unpublished.length} unpublished and skipped.`);
      return 0;
    }
    if (result.verified === 0) {
      // Stated as the whole outcome rather than as a footnote, because this is the run that used to read
      // as a pass: nothing was rebuilt, nothing was compared, and the exit code said the artifacts were
      // good. Publishing a recipe and pinning its digest is what makes the gate able to answer at all.
      process.stderr.write(`\nVERIFIED NOTHING: none of the ${names.length} recipe(s) has a published pin to compare a rebuild against.\n`);
      for (const item of result.unpublished) process.stderr.write(`  ${item.reference}: declared but never published\n`);
    }
    if (result.differing.length > 0 || result.missing.length > 0) {
      process.stderr.write(`\n${result.differing.length} rebuild(s) differ from their pin and ${result.missing.length} have no pin entry.\n`);
    }
    for (const item of result.differing) {
      process.stderr.write(
        `  ${item.reference}: pinned ${item.pinned.digest}, built ${item.built.digest}`
        + `${item.treeDigest ? ` (uncompressed tree ${item.treeDigest})` : ''}\n`,
      );
    }
    return 1;
  }

  // Eager here, unlike verify: a build always builds, and learning about a missing package after the
  // first recipe has already run for several minutes helps nobody.
  ensureBuildTools();

  const toolchain = {
    mmdebstrap: run('mmdebstrap', ['--version'], { capture: true }).trim(),
    tar: run('tar', ['--version'], { capture: true }).split('\n')[0].trim(),
    gzip: run('gzip', ['--version'], { capture: true }).split('\n')[0].trim(),
  };

  const artifacts = [];
  for (const name of names) {
    log(`Building ${artifactReference(name)}`);
    artifacts.push(await build(name));
  }

  const manifest = publishManifest(artifacts, { toolchain });
  const manifestPath = join(outDir, MANIFEST_FILE);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(repositoryRoot, PIN_FILE), `${JSON.stringify(pinsFrom(manifest), null, 2)}\n`);

  log('\nBuilt:');
  for (const artifact of artifacts) {
    log(`  ${artifact.reference}  ${artifact.digest}  ${artifact.sizeBytes} bytes  ${artifact.packages.length} packages`);
  }
  log(`\nManifest: ${manifestPath}`);
  log(`Pins:     ${join(repositoryRoot, PIN_FILE)}`);
  log('\nNot uploaded. Publishing is a separate, owner-approved step; for each artifact it means a');
  log(`release tagged as below under ${ARTIFACT_BASE_URL.replace('/releases/download', '')}:`);
  for (const artifact of artifacts) {
    log(`  ${artifact.releaseTag}  <-  ${artifact.output}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
