#!/usr/bin/env node
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { installBrainUsageRollup, rebuildBrainUsageRollup } from '../store/brainUsageRollup.js';
import type { Db } from '../store/db.js';

const pathArg = process.argv[2];
const confirmed = process.argv.includes('--confirmed-backup');
if (!pathArg || !confirmed) {
  console.error('Usage: node dist/cli/rebuildBrainUsageRollup.js <database-copy-or-backed-up-db> --confirmed-backup');
  process.exit(2);
}

const path = resolve(pathArg);
if (!existsSync(path)) {
  console.error(`Database does not exist: ${path}`);
  process.exit(2);
}
const db = new Database(path) as Db;
try {
  installBrainUsageRollup(db);
  const before = db.prepare('SELECT COUNT(*) AS rows FROM brain_messages').get() as { rows: number };
  const started = performance.now();
  const result = rebuildBrainUsageRollup(db);
  console.log(JSON.stringify({ database: path, sourceMessages: before.rows, usageRows: result.rows,
    generation: result.generation, durationMs: Math.round(performance.now() - started) }));
} finally {
  db.close();
}
