import type { DestructiveWarningId } from '../shared/wireContract.js';

/** An INFORMATIONAL note attached to a shell approval prompt when the command matches a known
 *  destructive shape — ported from Claude Code's `BashTool/destructiveCommandWarning.ts:2-3`, which is
 *  equally explicit that it "doesn't affect permission logic or auto-approval".
 *
 *  IT DECIDES NOTHING. The permission ruleset in toolPermissions.ts remains the only thing that resolves
 *  allow/ask/deny; this table only tells the human staring at an `ask` prompt what the command they are
 *  about to approve can do to them. That separation is the whole design constraint: a second rule engine
 *  beside the rules — one whose patterns are regexes rather than the operator's own glob patterns — would
 *  be a source of truth nobody configured and nobody could override.
 *
 *  Regexes are acceptable HERE, and only here, precisely because nothing hangs on a miss: an unmatched
 *  destructive command simply gets the prompt it would have got anyway. A false positive costs one extra
 *  sentence. Neither outcome can grant or withhold a permission, so the table is allowed to be a cheap
 *  heuristic instead of the shell parser the gate itself needs (splitBashSegments).
 *
 *  Deliberately NOT here: path awareness. The reference keeps "is this rm aimed at something precious"
 *  in a separate check, and reproducing it would mean deciding which paths are precious — a policy
 *  question that belongs to the operator's rules, not to a note. */
interface DestructivePattern { id: DestructiveWarningId; pattern: RegExp }

/** Ordered: the FIRST match wins, so the more specific shape of a family comes before the general one
 *  (`rm -rf` before `rm -r` before `rm -f`), exactly as in the reference. */
const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  // Git — data loss or hard to reverse.
  { id: 'gitResetHard', pattern: /\bgit\s+reset\s+--hard\b/ },
  { id: 'gitForcePush', pattern: /\bgit\s+push\b[^;&|\n]*[ \t](?:--force|--force-with-lease|-f)\b/ },
  { id: 'gitCleanForce', pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/ },
  // Wider than the reference's `git checkout .`, which only catches the whole-tree spelling: `git checkout
  // -- src/a.ts` discards that file's changes just as irreversibly, and `--` is what makes the argument a
  // PATH rather than the branch name of an ordinary, harmless checkout.
  { id: 'gitDiscardWorktree', pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+\S|\.[ \t]*(?:$|[;&|\n]))/ },
  { id: 'gitStashDrop', pattern: /\bgit\s+stash[ \t]+(?:drop|clear)\b/ },
  { id: 'gitBranchForceDelete', pattern: /\bgit\s+branch\s+(?:-D[ \t]|--delete\s+--force|--force\s+--delete)/ },
  { id: 'gitNoVerify', pattern: /\bgit\s+(?:commit|push|merge)\b[^;&|\n]*--no-verify\b/ },
  { id: 'gitCommitAmend', pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/ },

  // File deletion, in the reference's three tiers — the note names what the flags actually do.
  { id: 'rmRecursiveForce', pattern: /(?:^|[;&|\n]\s*)rm\s+-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])/ },
  { id: 'rmRecursive', pattern: /(?:^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/ },
  { id: 'rmForce', pattern: /(?:^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/ },

  // Database.
  { id: 'sqlDropTable', pattern: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i },
  { id: 'sqlDeleteAll', pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(?:;|"|'|\n|$)/i },

  // Infrastructure.
  { id: 'kubectlDelete', pattern: /\bkubectl\s+delete\b/ },
  { id: 'terraformDestroy', pattern: /\bterraform\s+destroy\b/ },

  // Host and filesystem surgery. Not in the reference — its shell runs behind a different sandbox — but
  // these are the shapes an Elowen operator most needs named before they press "Allow once", because each
  // one is unrecoverable at the machine level rather than at the repository level.
  { id: 'mkfs', pattern: /\bmkfs(?:\.\w+)?\s/ },
  { id: 'deviceOverwrite', pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d)/ },
  { id: 'chmodWorldWritable', pattern: /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)?0?777\b/ },
  { id: 'killEveryProcess', pattern: /\bkill\s+-(?:9|KILL)\s+-1\b/ },
  { id: 'forkBomb', pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}\s*;\s*:/ },
];

/** The English note each id renders as. It is what the CLI shows verbatim and what the daemon appends to
 *  the wire question; the web composes its own wording from the id (see the i18n dictionaries), so this
 *  map and the dictionaries must carry the same key set. */
export const DESTRUCTIVE_WARNING_NOTES: Record<DestructiveWarningId, string> = {
  gitResetHard: 'may discard uncommitted changes',
  gitForcePush: 'may overwrite remote history',
  gitCleanForce: 'may permanently delete untracked files',
  gitDiscardWorktree: 'may discard working tree changes',
  gitStashDrop: 'may permanently remove stashed changes',
  gitBranchForceDelete: 'may force-delete a branch',
  gitNoVerify: 'may skip safety hooks',
  gitCommitAmend: 'may rewrite the last commit',
  rmRecursiveForce: 'may recursively force-remove files',
  rmRecursive: 'may recursively remove files',
  rmForce: 'may force-remove files',
  sqlDropTable: 'may drop or truncate database objects',
  sqlDeleteAll: 'may delete all rows from a database table',
  kubectlDelete: 'may delete Kubernetes resources',
  terraformDestroy: 'may destroy Terraform infrastructure',
  mkfs: 'may erase a filesystem',
  deviceOverwrite: 'may overwrite a raw disk device',
  chmodWorldWritable: 'may make files world-writable',
  killEveryProcess: 'may kill every process of this account',
  forkBomb: 'may exhaust the process table',
};

/** The id of the first destructive shape `command` matches, or null. Matched against the RAW command —
 *  several patterns anchor on `;`, `|`, `&` and newlines to find the start of a chained command, and a
 *  whitespace-collapsed copy has already lost the newlines. */
export function destructiveWarningId(command: string): DestructiveWarningId | null {
  for (const { id, pattern } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return id;
  }
  return null;
}
