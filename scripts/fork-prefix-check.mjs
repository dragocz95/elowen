/**
 * Did a fork child actually start from its parent's request?
 *
 * The fork cache line answers that from token counters: how much the child read back against how big the
 * parent's warm prefix was. It cannot say WHERE a prefix broke, so a `prefix mismatch` verdict proves the
 * fork paid full price and names nothing. This does: the request recorder stores every request as digested
 * segments (the system prompt, one per tool, one per message), so the two manifests can simply be compared
 * — the parent's last chat request at or before the fork, against the child's first — and the first
 * differing segment named.
 *
 * WHAT IT TOUCHES
 *   Nothing. The database is opened READ-ONLY, so the process physically cannot write to it, and every
 *   read goes through the same ProviderRequestStore the diagnostics panel reads through.
 *
 * WHAT IT NEEDS
 *   A build (`npm run build`), because it reads the store and the comparison out of `dist/` rather than
 *   re-implementing either. Run it against the build that produced the fork you are asking about.
 *
 * USAGE
 *   node scripts/fork-prefix-check.mjs --parent <session-id> --child <session-id> [--db <path>]
 *
 *   Session ids are the ones on the fork log line: `fork <child> from <parent>: …`.
 *
 * EXIT CODE
 *   0  the child opened with the whole of its parent's prefix
 *   1  it did not, and the first differing segment is named
 *   2  nothing to compare (capture off for one of them, or a session that never sent a request)
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { db: '', parent: '', child: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i] ?? '';
    else if (argv[i] === '--parent') args.parent = argv[++i] ?? '';
    else if (argv[i] === '--child') args.child = argv[++i] ?? '';
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const USAGE = 'usage: node scripts/fork-prefix-check.mjs --parent <session-id> --child <session-id> [--db <path>]';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  if (!args.parent || !args.child) { console.error(USAGE); process.exit(2); }

  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'store', 'providerRequestStore.js'))) {
    console.error(`no build found at ${dist} — run \`npm run build\` first (this reads the store and the comparison out of dist/ rather than re-implementing them).`);
    process.exit(2);
  }
  const { ProviderRequestStore } = await import(join(dist, 'store', 'providerRequestStore.js'));
  const { forkPrefixReading, formatForkPrefixReading } = await import(join(dist, 'brain', 'session', 'forkPrefixDiff.js'));
  const { dbPath } = await import(join(dist, 'shared', 'paths.js'));

  const path = args.db || dbPath(process.env);
  if (!existsSync(path)) { console.error(`database not found: ${path}`); process.exit(2); }
  // READ-ONLY at the SQLite level, not by convention: this runs against a live daemon's database.
  const Database = require('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');

  try {
    const reading = forkPrefixReading(new ProviderRequestStore(db), args.parent, args.child);
    if (!reading) {
      console.error(`nothing to compare: no captured chat request for ${args.child}, or none for ${args.parent} at or before it. Provider request capture may be switched off for this instance.`);
      process.exit(2);
    }
    console.log(formatForkPrefixReading(reading, args.parent, args.child));
    process.exit(reading.comparison.shared ? 0 : 1);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(2);
});
