/**
 * Remove stored references to brain models this installation no longer has.
 *
 * A model reference goes stale in two ways: its PROVIDER was deleted in Settings -> Brain, or the provider
 * survives and the operator removed that one MODEL from its manual list. Neither deletion rewrites the rows
 * that still name the model, so they linger in the global allow-list, in the pinned context windows and in
 * per-user permission lists. The daemon now refuses them at every gate (shared/execs.ts), which makes them
 * inert -- this script is what actually removes them.
 *
 * WHAT IT TOUCHES
 *   settings.allowedExecs                 (global exec allow-list)
 *   settings.brain.modelContextWindows    (operator-pinned context windows, keyed `provider/model`)
 *   users.allowed_execs                   (per-user model whitelist)
 *   users.default_exec / users.advisor_exec
 *
 * WHAT IT DOES NOT TOUCH, EVER
 *   brain_sessions, brain_messages, brain_provider_requests, memory_embeddings, memory_events -- history.
 *   Rewriting which model answered a past turn falsifies the record; a stale model there is a true
 *   statement about the past. Those rows are also self-healing: a session respawns onto a live model.
 *   Execs of OTHER agent programs (`codex:gpt-5.5`, `opus`, `sonnet`, `opencode:*`, ...) are a different
 *   registry entirely and are never judged against the brain provider set.
 *
 * SAFETY
 *   Dry run is the default and opens the database READ-ONLY, so it physically cannot write. `--apply` is
 *   required to change anything, and every write is verified by RE-READING the row: SQLite reports a
 *   successful UPDATE for zero matched rows, so a statement count proves nothing. The settings row is
 *   addressed by `id = 1` -- `rowid` is not selectable on that table and an `UPDATE ... WHERE rowid = ?`
 *   silently matches nothing.
 *
 *   Idempotent: a second run finds nothing to remove and writes nothing.
 *
 *   RUN IT ONLY AFTER THE CODE THAT UNDERSTANDS THE RESULT IS BUILT AND DEPLOYED. Data must never move
 *   ahead of the running build.
 *
 * USAGE
 *   node --experimental-strip-types scripts/prune-stale-brain-models.mjs --db <path>            # dry run
 *   node --experimental-strip-types scripts/prune-stale-brain-models.mjs --db <path> --apply
 */
import Database from 'better-sqlite3';
// shared/execs.ts is the daemon's own decision point and imports nothing, so it loads here under
// --experimental-strip-types and the script cannot drift from the gate it is cleaning up after.
import { execSpecProgram, isOfferableBrainModel, parseElowenExec } from '../src/shared/execs.ts';

/** Provider ids that can serve models WITHOUT an entry in `brain.providers`: a connected OAuth account is
 *  surfaced under its built-in id, and `relay` is the autopilot fallback. Whether either is live depends on
 *  credentials this script deliberately does not read, so a reference to one is reported and left alone
 *  rather than deleted on a guess. (See configuredBrainProviders: a provider that fails to LOAD is not a
 *  provider that was DELETED, and only the second may cost anyone their configuration.)
 *
 *  Copied from brain/providers.ts OAUTH_BUILTIN rather than imported — that module pulls in the whole
 *  provider registry, which type-stripping alone cannot resolve. Drift here can only ever leave a stale row
 *  behind for a human to look at; it can never delete something live. */
const SYNTHETIC_PROVIDER_IDS = new Set(['anthropic', 'github-copilot', 'openai-codex', 'kimi-coding', 'relay']);

function parseArgs(argv) {
  const args = { db: '', apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i] ?? '';
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/** The configured provider set, read from the settings blob exactly as sanitizeBrainProviders reads it. */
function providersFrom(settings) {
  const raw = settings?.brain?.providers;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id && !p.id.includes('/'))
    .map((p) => ({
      id: p.id,
      models: Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string' && !!m) : [],
    }));
}

/**
 * Verdict for one stored reference: 'keep', 'stale', or 'unknown-provider' (a synthetic id whose liveness
 * this script cannot establish). `provider`/`model` are null for anything that is not a brain reference.
 */
function judge(provider, model, providers) {
  if (isOfferableBrainModel(provider, model, providers)) return 'keep';
  const configured = providers.some((p) => p.id === provider);
  if (!configured && SYNTHETIC_PROVIDER_IDS.has(provider)) return 'unknown-provider';
  return 'stale';
}

/** Judge an exec spec. Only brain execs (`provider/model`, or the legacy `elowen:` spelling) are judged;
 *  every other program's exec is returned as 'keep' untouched. */
function judgeExec(spec, providers) {
  if (execSpecProgram(spec) !== 'elowen') return 'keep';
  const parsed = parseElowenExec(spec);
  if (!parsed) return 'keep'; // not a well-formed brain reference; not this script's to interpret
  return judge(parsed.provider, parsed.model, providers);
}

const diff = [];
const warnings = [];
const note = (field, subject, spec) => diff.push({ field, subject, spec });

function pruneList(list, field, subject, providers) {
  const kept = [];
  for (const spec of list) {
    const verdict = judgeExec(spec, providers);
    if (verdict === 'stale') note(field, subject, spec);
    else {
      if (verdict === 'unknown-provider') warnings.push(`${field}${subject ? ` (${subject})` : ''}: ${spec} — provider may be a connected OAuth account or the relay fallback; left untouched`);
      kept.push(spec);
    }
  }
  return kept;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db) {
    console.log('usage: node --experimental-strip-types scripts/prune-stale-brain-models.mjs --db <path> [--apply]');
    process.exit(args.help ? 0 : 2);
  }

  const db = new Database(args.db, args.apply ? {} : { readonly: true });
  db.pragma('foreign_keys = ON');

  const settingsRow = db.prepare('SELECT id, data FROM settings WHERE id = 1').get();
  if (!settingsRow) throw new Error('no settings row with id = 1 — refusing to guess which row holds the config');
  const settings = JSON.parse(settingsRow.data);
  const providers = providersFrom(settings);
  if (providers.length === 0) throw new Error('settings.brain.providers is empty — refusing to treat every stored model as stale');

  console.log(`database: ${args.db}`);
  console.log(`mode:     ${args.apply ? 'APPLY (writes)' : 'dry run (database opened read-only)'}`);
  console.log('configured providers:');
  for (const p of providers) {
    console.log(`  ${p.id}: ${p.models.length ? p.models.join(', ') : '(live catalogue — bounds nothing)'}`);
  }
  console.log('');

  // ---- settings.allowedExecs -------------------------------------------------------------------
  const allowedExecs = Array.isArray(settings.allowedExecs) ? settings.allowedExecs : null;
  const nextAllowedExecs = allowedExecs ? pruneList(allowedExecs, 'settings.allowedExecs', '', providers) : null;

  // ---- settings.brain.modelContextWindows ------------------------------------------------------
  const windows = settings.brain?.modelContextWindows;
  let nextWindows = null;
  if (windows && typeof windows === 'object') {
    nextWindows = {};
    for (const [key, value] of Object.entries(windows)) {
      // The key is `<providerId>/<modelId>` and a provider id can never contain a slash, so the FIRST
      // slash splits it — a model id may carry more of its own.
      const parsed = parseElowenExec(key);
      const verdict = parsed ? judge(parsed.provider, parsed.model, providers) : 'keep';
      if (verdict === 'stale') note('settings.brain.modelContextWindows', '', key);
      else {
        if (verdict === 'unknown-provider') warnings.push(`settings.brain.modelContextWindows: ${key} — provider may be a connected OAuth account or the relay fallback; left untouched`);
        nextWindows[key] = value;
      }
    }
  }

  // ---- users -----------------------------------------------------------------------------------
  const users = db.prepare('SELECT id, username, allowed_execs, default_exec, advisor_exec FROM users ORDER BY id').all();
  const userUpdates = [];
  for (const u of users) {
    const who = `#${u.id} ${u.username}`;
    const update = { id: u.id, who };

    if (u.allowed_execs) {
      // The column is written as CSV but tolerates a JSON array on read (userStore.readAllowedExecs).
      // Whatever shape a row is in, it is written back in the SAME shape — this script prunes, it does
      // not migrate storage formats.
      let asJson = true;
      let list;
      try { list = JSON.parse(u.allowed_execs); if (!Array.isArray(list)) throw new Error('not an array'); }
      catch { asJson = false; list = u.allowed_execs.split(',').filter(Boolean); }
      const kept = pruneList(list, 'users.allowed_execs', who, providers);
      if (kept.length !== list.length) update.allowed_execs = asJson ? JSON.stringify(kept) : kept.join(',');
    }

    for (const column of ['default_exec', 'advisor_exec']) {
      const spec = u[column];
      if (!spec) continue;
      if (judgeExec(spec, providers) !== 'stale') continue;
      note(`users.${column}`, who, spec);
      // Cleared to '' — the column's own "unset" value, which resolves to the instance default. Picking a
      // replacement model on the operator's behalf is not this script's call.
      update[column] = '';
    }

    if (Object.keys(update).length > 2) userUpdates.push(update);
  }

  // ---- report ----------------------------------------------------------------------------------
  if (diff.length === 0) {
    console.log('nothing stale — every stored brain model reference still exists in Settings → Brain.');
  } else {
    console.log(`stale references (${diff.length}):`);
    for (const d of diff) console.log(`  - ${d.field}${d.subject ? ` [${d.subject}]` : ''}: ${d.spec}`);
  }
  if (warnings.length) {
    console.log('');
    console.log('left untouched (provider liveness not decidable from the database alone):');
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (diff.length === 0 || !args.apply) {
    if (diff.length) console.log('\ndry run — nothing written. Re-run with --apply to remove them.');
    db.close();
    return;
  }

  // ---- apply -----------------------------------------------------------------------------------
  const nextSettings = { ...settings };
  if (nextAllowedExecs) nextSettings.allowedExecs = nextAllowedExecs;
  if (nextWindows) nextSettings.brain = { ...settings.brain, modelContextWindows: nextWindows };
  const nextData = JSON.stringify(nextSettings);

  db.transaction(() => {
    // `id = 1` and never `rowid`: the settings table does not expose rowid to a SELECT here, so a
    // rowid-keyed UPDATE matches nothing while still reporting success.
    db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(nextData);
    for (const u of userUpdates) {
      const columns = Object.keys(u).filter((k) => k !== 'id' && k !== 'who');
      db.prepare(`UPDATE users SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...columns.map((c) => u[c]), u.id);
    }
  })();

  // ---- verify by RE-READING, never by trusting a statement count -------------------------------
  const failures = [];
  const writtenSettings = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  if (!writtenSettings || writtenSettings.data !== nextData) failures.push('settings row did not take the new value');
  else {
    const reread = JSON.parse(writtenSettings.data);
    const stillThere = providersFrom(reread);
    if (stillThere.length !== providers.length) failures.push('provider list changed while writing — aborting further verification');
    for (const d of diff) {
      if (d.field === 'settings.allowedExecs' && (reread.allowedExecs ?? []).includes(d.spec)) failures.push(`settings.allowedExecs still contains ${d.spec}`);
      if (d.field === 'settings.brain.modelContextWindows' && d.spec in (reread.brain?.modelContextWindows ?? {})) failures.push(`modelContextWindows still contains ${d.spec}`);
    }
  }
  for (const u of userUpdates) {
    const row = db.prepare('SELECT allowed_execs, default_exec, advisor_exec FROM users WHERE id = ?').get(u.id);
    if (!row) { failures.push(`user ${u.who} disappeared`); continue; }
    for (const column of ['allowed_execs', 'default_exec', 'advisor_exec']) {
      if (u[column] !== undefined && row[column] !== u[column]) failures.push(`user ${u.who}: ${column} did not take the new value`);
    }
  }

  db.close();
  console.log('');
  if (failures.length) {
    for (const f of failures) console.error(`VERIFICATION FAILED: ${f}`);
    process.exit(1);
  }
  console.log(`applied and verified: ${diff.length} stale reference(s) removed, ${userUpdates.length} user row(s) updated.`);
}

main();
