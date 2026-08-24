#!/usr/bin/env node
/*
 * Convert the `users.allowed_tools` wildcard into an explicit per-account tool grant.
 *
 * WHY THIS EXISTS
 * The column is added with a `*` default so that migrating an instance cannot strip its accounts of every
 * plugin tool. `*` means "unrestricted", so until this script runs, the new allow-list changes nothing:
 * a newly installed plugin or MCP server is still granted to everyone the moment it loads. Replacing the
 * wildcard with the explicit set an account can reach TODAY is what actually starts the fail-closed
 * behaviour, without anybody gaining or losing a tool on the day it happens.
 *
 * WHAT IT WRITES
 *   allowed_tools := <catalogue of every enabled plugin's declared tools> minus <that account's deny-list>
 *
 * Admins are skipped: they bypass the grant entirely (see toolAuthorityForUser), so writing one would be
 * noise that goes stale on every plugin install.
 *
 * Accounts whose allow-list is ALREADY explicit are skipped too. Only the `*` marker is converted, so an
 * admin's deliberate narrowing is never overwritten by a later re-run — the script is safe to run twice.
 *
 * KNOWN AND DELIBERATE: bridged MCP tools are minted at runtime as `mcp__<server>__<tool>` and appear in
 * no manifest, so they are NOT carried into the grant. Non-admin accounts therefore lose MCP access here
 * and an admin must grant it back deliberately. That was the explicit decision — MCP is the surface where
 * new tools appear most often, so it is exactly the one that should not auto-grant. Writing `mcp__*` into
 * the grant would preserve access but permanently defeat the point.
 *
 * USAGE
 *   node scripts/migrate-tool-allowlist.mjs --db <path> --plugins <bundled dir> --plugins <user dir>
 *   node scripts/migrate-tool-allowlist.mjs ... --apply
 *
 * Dry run by default: it prints the exact before/after per account and writes nothing.
 * TAKE A BACKUP BEFORE `--apply`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function parseArgs(argv) {
  const out = { db: process.env.ELOWEN_DB || '', pluginDirs: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') { out.apply = true; continue; }
    if (arg === '--db') { out.db = argv[++i] ?? ''; continue; }
    if (arg === '--plugins') { out.pluginDirs.push(argv[++i] ?? ''); continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.db) throw new Error('--db is required (or set ELOWEN_DB)');
  if (out.pluginDirs.length === 0) throw new Error('at least one --plugins directory is required');
  for (const dir of out.pluginDirs) {
    if (!dir || !fs.existsSync(dir)) throw new Error(`plugin directory does not exist: ${dir}`);
  }
  return out;
}

/** Tool names a plugin manifest DECLARES. `provides.tools` holds either bare names or `{ name }` entries;
 *  anything else is ignored rather than guessed at. */
function manifestTools(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`unreadable plugin manifest ${manifestPath}: ${error.message}`);
  }
  const tools = manifest?.provides?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (typeof t === 'string' ? t : typeof t?.name === 'string' ? t.name : null))
    .filter((name) => typeof name === 'string' && name.length > 0)
    // A manifest may declare a PATTERN rather than a tool — the mcp plugin lists `mcp__*` because its real
    // names are minted at runtime per server. Copying that into a grant would hand every account every
    // bridged tool, present and future, which is precisely the auto-granting this migration exists to end.
    // A pattern is a statement about naming, not a tool anyone decided to give somebody.
    .filter((name) => !name.includes('*'));
}

/** The catalogue: every declared tool of every ENABLED plugin. Directories are searched in the order given
 *  and the FIRST manifest found for a name wins, mirroring the daemon's own bundled-beats-user precedence.
 *  A plugin that is enabled but has no manifest on disk is reported, never silently treated as empty. */
function buildCatalogue(enabled, pluginDirs) {
  const tools = new Set();
  const missing = [];
  for (const name of enabled) {
    const found = pluginDirs
      .map((dir) => path.join(dir, name, 'elowen-plugin.json'))
      .find((file) => fs.existsSync(file));
    if (!found) { missing.push(name); continue; }
    for (const tool of manifestTools(found)) tools.add(tool);
  }
  return { tools: [...tools].sort(), missing };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Meant to be runnable after being copied OUT of a checkout, so the native binding is looked up where a
  // deployment actually keeps it rather than only relative to wherever this file was dropped.
  const require = createRequire(import.meta.url);
  const Database = (() => {
    for (const id of ['better-sqlite3', '/opt/elowen/node_modules/better-sqlite3', '/var/www/elowen/node_modules/better-sqlite3']) {
      try { return require(id); } catch { /* try the next location */ }
    }
    throw new Error('better-sqlite3 not found — copy this next to an Elowen install, or run it from one');
  })();
  const db = new Database(args.db, { readonly: !args.apply });

  const settingsRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  if (!settingsRow) throw new Error('no settings row: this does not look like an Elowen database');
  const enabled = JSON.parse(settingsRow.data)?.plugins?.enabled;
  if (!Array.isArray(enabled) || enabled.length === 0) {
    throw new Error('no enabled plugins in settings — refusing to write an empty grant');
  }

  const { tools: catalogue, missing } = buildCatalogue(enabled, args.pluginDirs);
  // THE CRITICAL GUARD. An empty catalogue means the plugin directories are wrong, not that the instance
  // has no tools — and writing it would lock every non-admin out of everything.
  if (catalogue.length === 0) {
    throw new Error('the catalogue came back EMPTY — check --plugins paths; refusing to write');
  }
  console.log(`catalogue: ${catalogue.length} tool(s) from ${enabled.length} enabled plugin(s)`);
  if (missing.length) console.log(`WARNING: no manifest on disk for: ${missing.join(', ')}`);

  const users = db.prepare('SELECT id, username, name, is_admin, disabled_tools, allowed_tools FROM users ORDER BY id').all();
  const update = db.prepare('UPDATE users SET allowed_tools = ? WHERE id = ?');
  let changed = 0;

  for (const u of users) {
    const label = `#${u.id} ${u.name || u.username}`;
    if (u.is_admin) { console.log(`${label}: admin — skipped (admins bypass the grant)`); continue; }
    if (u.allowed_tools !== '*') {
      console.log(`${label}: already explicit (${u.allowed_tools ? u.allowed_tools.split(',').length : 0} tool(s)) — skipped`);
      continue;
    }
    const denied = new Set((u.disabled_tools || '').split(',').filter(Boolean));
    const granted = catalogue.filter((tool) => !denied.has(tool));
    console.log(`${label}: * -> ${granted.length} tool(s) (catalogue ${catalogue.length} minus ${denied.size} denied)`);
    if (args.apply) { update.run(granted.join(','), u.id); changed += 1; }
  }

  console.log(args.apply ? `applied to ${changed} account(s)` : 'dry run — nothing written (pass --apply)');
  db.close();
}

try {
  main();
} catch (error) {
  console.error(`migrate-tool-allowlist: ${error.message}`);
  process.exit(1);
}
