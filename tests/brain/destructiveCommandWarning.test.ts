import { describe, it, expect } from 'vitest';
import { DESTRUCTIVE_WARNING_NOTES, destructiveWarningId } from '../../src/brain/destructiveCommandWarning.js';
import {
  approvalQuestion,
  buildPermissionRuleset,
  resolveToolPermission,
  sanitizePermissionSettings,
} from '../../src/brain/toolPermissions.js';
import { cs } from '../../web/lib/i18n/dictionaries/cs.js';
import { en } from '../../web/lib/i18n/dictionaries/en.js';
import { sk } from '../../web/lib/i18n/dictionaries/sk.js';

/** The table on its own, one candidate at a time. What `approvalQuestion` actually feeds it — the raw
 *  command plus the canonical form of every simple command in it — is exercised further down. */
const warn = (command: string) => destructiveWarningId([command]);

describe('destructiveWarningId — the informational pattern table', () => {
  // One matching and one deliberately NON-matching command per id. The near-miss is the half that keeps
  // the table honest: a pattern that fires on `git checkout main` would put a data-loss warning on the
  // most ordinary command there is, and the human would learn to ignore every note after it.
  const cases: [string, string, string][] = [
    ['gitResetHard', 'git reset --hard HEAD~1', 'git reset HEAD~1'],
    ['gitForcePush', 'git push --force origin main', 'git push origin main'],
    ['gitCleanForce', 'git clean -fd', 'git clean -nd'],
    ['gitDiscardWorktree', 'git checkout -- src/app.ts', 'git checkout main'],
    ['gitStashDrop', 'git stash drop', 'git stash list'],
    ['gitBranchForceDelete', 'git branch -D feature', 'git branch -d feature'],
    ['gitNoVerify', 'git commit -m x --no-verify', 'git commit -m x'],
    ['gitCommitAmend', 'git commit --amend --no-edit', 'git commit -m amendment'],
    ['rmRecursiveForce', 'rm -rf build', 'rmdir build'],
    ['rmRecursive', 'rm -r build', 'rm build/x'],
    ['rmForce', 'rm -f build/x', 'rm build/x'],
    ['sqlDropTable', 'psql -c "DROP TABLE users"', 'psql -c "SELECT * FROM users"'],
    ['sqlDeleteAll', 'psql -c "DELETE FROM users"', 'psql -c "DELETE FROM users WHERE id = 1"'],
    ['kubectlDelete', 'kubectl delete pod api-0', 'kubectl get pods'],
    ['terraformDestroy', 'terraform destroy -auto-approve', 'terraform plan'],
    ['mkfs', 'mkfs.ext4 /dev/sdb1', 'cat /proc/mounts'],
    ['deviceOverwrite', 'cat image.img > /dev/sda', 'cat image.img > /tmp/sda'],
    ['chmodWorldWritable', 'chmod -R 777 /srv/app', 'chmod -R 755 /srv/app'],
    ['killEveryProcess', 'kill -9 -1', 'kill -9 4321'],
    ['forkBomb', ':(){ :|:& };:', 'echo ":(){ safe }"'],
  ];

  it.each(cases)('flags %s and leaves its near-miss alone', (id, destructive, benign) => {
    expect(warn(destructive)).toBe(id);
    expect(warn(benign)).not.toBe(id);
  });

  it('covers every declared id and every id has a note', () => {
    expect(cases.map(([id]) => id).sort()).toEqual(Object.keys(DESTRUCTIVE_WARNING_NOTES).sort());
  });

  it('returns null for ordinary commands', () => {
    for (const command of ['ls -la', 'npm run build', 'git status --porcelain', 'echo hello', '']) {
      expect(warn(command)).toBeNull();
    }
  });

  it('finds a destructive command hiding behind a chain or a newline', () => {
    // The raw command is what gets matched, so the `[;&|\n]` anchors still work. Collapsing whitespace
    // first would have turned the newline into a space and hidden the second command from `(^|[;&|\n])`.
    expect(warn('cd build\nrm -rf .')).toBe('rmRecursiveForce');
    expect(warn('npm test && git push --force')).toBe('gitForcePush');
  });

  it('prefers the most specific tier of a family', () => {
    // Order is load-bearing: `rm -rf` must not be reported as the milder `rm -r` or `rm -f`.
    expect(warn('rm -rf build')).toBe('rmRecursiveForce');
  });

  it('does not flag a command that merely NAMES a destructive program', () => {
    // A note on `which mkfs.ext4` is worse than no note at all: it teaches the reader that the notes are
    // noise, and the next one they skim is a real one.
    for (const command of ['which mkfs.ext4', 'man 8 mkfs', 'ls -l /sbin/mkfs.ext4', 'echo mkfs is a thing']) {
      expect(warn(command), command).toBeNull();
    }
  });

  it('flags the two spellings that actually destroy a disk', () => {
    expect(warn('cat image.img > /dev/sda')).toBe('deviceOverwrite');
    expect(warn('dd if=/dev/zero of=/dev/sdb bs=1M')).toBe('deviceOverwrite');
  });

  it('matches a long adversarial command in bounded time', () => {
    // The command is model-supplied and can arrive from a page or a repo file, and this runs
    // synchronously on the daemon's only event loop. The obvious spelling of the fork-bomb pattern —
    // several `[^}]*` runs inside the braces — took ~1s on this exact 3 kB input and >20s on 80 kB,
    // holding every other session behind it.
    const inputs = [
      ':(){'.concat(':|:&'.repeat(20_000)),
      'git clean '.concat('-'.repeat(20_000)),
      'rm -'.concat('a'.repeat(20_000)),
      'x'.repeat(200_000),
    ];
    const started = Date.now();
    for (const input of inputs) destructiveWarningId([input]);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('destructive warning i18n', () => {
  it('has every id in en, cs and sk', () => {
    const ids = Object.keys(DESTRUCTIVE_WARNING_NOTES).sort();
    for (const [locale, dict] of [['en', en], ['cs', cs], ['sk', sk]] as const) {
      const translated = dict.brainChat.approvalWarnings as Record<string, string>;
      expect(Object.keys(translated).sort(), `${locale} is missing a destructive-warning note`).toEqual(ids);
      for (const id of ids) expect(translated[id]?.trim(), `${locale}.${id}`).toBeTruthy();
    }
    // The sentence the note is interpolated into must exist in all three too.
    for (const dict of [en, cs, sk]) expect(dict.brainChat.approvalWarningNote).toContain('{note}');
  });
});

describe('the warning is informational — it changes no decision', () => {
  const ruleset = buildPermissionRuleset(sanitizePermissionSettings({}));
  // A pair of commands that resolve the same way, one of which carries a note. If the note ever reached
  // the decision, these would stop agreeing.
  const pairs: [string, string][] = [
    ['rm -rf build', 'rm build'],          // both `ask` under the defaults
    ['git status --porcelain', 'git status'], // both `allow` (no note on either)
  ];

  it.each(pairs)('resolves %s exactly as its unflagged sibling %s', (flagged, plain) => {
    expect(resolveToolPermission(ruleset, 'Bash', flagged).action)
      .toBe(resolveToolPermission(ruleset, 'Bash', plain).action);
  });

  it('resolves an allow-listed command to allow even when it carries a note', () => {
    // `git stash list` is explicitly allow-listed; `git stash drop` carries a note. Neither the presence
    // of a note nor its absence may move the action away from what the RULES say.
    const rules = buildPermissionRuleset(sanitizePermissionSettings({ bash: { 'git stash drop*': 'allow' } }));
    expect(warn('git stash drop')).toBe('gitStashDrop');
    expect(resolveToolPermission(rules, 'Bash', 'git stash drop').action).toBe('allow');
  });

  it('leaves the prompt options and the always-pattern untouched', () => {
    const flagged = approvalQuestion({ tool: 'Bash', scope: 'bash', command: 'rm -rf build', alwaysPattern: 'rm*' });
    const plain = approvalQuestion({ tool: 'Bash', scope: 'bash', command: 'ls -la', alwaysPattern: 'ls*' });
    expect(flagged.options.map((o) => o.id)).toEqual(plain.options.map((o) => o.id));
    expect(flagged.multiSelect).toBe(plain.multiSelect);
    expect(flagged.custom).toBe(plain.custom);
    expect(flagged.approval?.alwaysPattern).toBe('rm*');
  });

  it('sees through the shell wrappers the resolver already sees through', () => {
    // `sudo rm -rf /srv/app` is the single command a human most needs named before pressing "Allow once",
    // and matching the raw string alone misses it — the `rm` patterns anchor at the start of a command.
    // The prompt therefore matches the gate's own canonical segment forms too, rather than growing a
    // second list of shell wrappers here.
    for (const command of ['sudo rm -rf /srv/app', 'env rm -rf /srv/app', '/bin/rm -rf /srv/app', 'nice rm -rf /srv/app']) {
      const q = approvalQuestion({ tool: 'Bash', scope: 'bash', command, alwaysPattern: 'rm*' });
      expect(q.approval?.warning, command).toBe('rmRecursiveForce');
    }
    // …and the raw command is still what the chained/newline anchors work on.
    const chained = approvalQuestion({ tool: 'Bash', scope: 'bash', command: 'cd build\nsudo rm -rf .', alwaysPattern: 'cd*' });
    expect(chained.approval?.warning).toBe('rmRecursiveForce');
  });

  it('carries the note in the English question and the id on the wire', () => {
    const q = approvalQuestion({ tool: 'Bash', scope: 'bash', command: 'git push --force', alwaysPattern: 'git push*' });
    expect(q.question).toContain(`Note: ${DESTRUCTIVE_WARNING_NOTES.gitForcePush}`);
    expect(q.approval?.warning).toBe('gitForcePush');
  });

  it('omits the note entirely when nothing matched, and for non-shell tools', () => {
    const shell = approvalQuestion({ tool: 'Bash', scope: 'bash', command: 'ls -la', alwaysPattern: 'ls*' });
    expect(shell.question).not.toContain('Note:');
    expect(shell.approval?.warning).toBeUndefined();
    const write = approvalQuestion({ tool: 'Write', scope: 'tools', alwaysPattern: 'Write' });
    expect(write.question).not.toContain('Note:');
    expect(write.approval?.warning).toBeUndefined();
  });
});
