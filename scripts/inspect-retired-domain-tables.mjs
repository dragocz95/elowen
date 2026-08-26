#!/usr/bin/env node
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const RETIRED_TABLES = [
  'tasks', 'task_deps', 'task_usage',
  'agents', 'missions', 'mission_pr', 'notes',
];

function parseArgs(argv) {
  const out = { db: process.env.ELOWEN_DB || join(process.env.HOME || homedir() || '/', '.config', 'elowen', 'elowen.db'), dropEmpty: false, authorizeNonempty: false, exportDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') out.db = argv[++i];
    else if (arg === '--drop-empty') out.dropEmpty = true;
    else if (arg === '--authorize-delete-nonempty') out.authorizeNonempty = true;
    else if (arg === '--export-dir') out.exportDir = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.db) throw new Error('--db needs a path');
  if (out.authorizeNonempty && !out.exportDir) {
    throw new Error('--authorize-delete-nonempty requires --export-dir so rows are exported before deletion');
  }
  return out;
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.db);
  if (!existsSync(path)) throw new Error(`database not found: ${path}`);
  const db = new Database(path);
  try {
    const inventory = RETIRED_TABLES.filter((table) => tableExists(db, table)).map((table) => ({
      table,
      rows: db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count,
    }));
    console.log(JSON.stringify({ database: path, dryRun: !args.dropEmpty && !args.authorizeNonempty, tables: inventory }, null, 2));

    const nonempty = inventory.filter((item) => item.rows > 0);
    if (!args.dropEmpty && !args.authorizeNonempty) {
      if (nonempty.length > 0) {
        console.error('Refusing deletion: non-empty retired tables require --export-dir and --authorize-delete-nonempty.');
      }
      return;
    }

    let exported = new Map();
    if (args.authorizeNonempty) {
      const exportDir = isAbsolute(args.exportDir) ? args.exportDir : resolve(args.exportDir);
      mkdirSync(exportDir, { recursive: true, mode: 0o700 });
      for (const item of nonempty) {
        const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(item.table)}`).all();
        const file = join(exportDir, `${item.table}.json`);
        writeFileSync(file, JSON.stringify(rows, null, 2), { mode: 0o600, flag: 'wx' });
        exported.set(item.table, file);
      }
    }

    db.transaction(() => {
      for (const item of inventory) {
        const current = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(item.table)}`).get().count;
        if (current !== item.rows) throw new Error(`${item.table} changed during inventory; nothing was dropped`);
        if (current > 0 && !args.authorizeNonempty) continue;
        db.exec(`DROP TABLE ${quoteIdentifier(item.table)}`);
        console.log(`dropped ${item.table}${exported.has(item.table) ? ` after export to ${exported.get(item.table)}` : ''}`);
      }
    }).immediate();

    if (nonempty.length > 0 && !args.authorizeNonempty) {
      throw new Error(`non-empty retired tables were not dropped: ${nonempty.map((item) => item.table).join(', ')}`);
    }
  } finally {
    db.close();
  }
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
