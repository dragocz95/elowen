import { describe, it, expect } from 'vitest';
import {
  approvalDecision,
  approvalQuestion,
  bashAlwaysPattern,
  buildPermissionRuleset,
  matchPermissionPattern,
  mergePermissionSettings,
  resolveToolPermission,
  sanitizePermissionSettings,
  APPROVAL_LABELS,
  type PermissionRule,
} from '../../src/brain/toolPermissions.js';

const settings = (over: Partial<{ tools: Record<string, 'allow' | 'ask' | 'deny'>; bash: Record<string, 'allow' | 'ask' | 'deny'>; yolo: boolean }> = {}) =>
  sanitizePermissionSettings({ tools: {}, bash: {}, yolo: false, ...over });

describe('matchPermissionPattern — opencode wildcard semantics', () => {
  it('* matches zero or more of any character', () => {
    expect(matchPermissionPattern('git status --porcelain', 'git status*')).toBe(true);
    expect(matchPermissionPattern('git status', 'git status*')).toBe(true);
    expect(matchPermissionPattern('git stash pop', 'git status*')).toBe(false);
  });

  it('? matches exactly one character; everything else is literal', () => {
    expect(matchPermissionPattern('rm x', 'rm ?')).toBe(true);
    expect(matchPermissionPattern('rm xy', 'rm ?')).toBe(false);
    // Regex metacharacters in patterns stay literal.
    expect(matchPermissionPattern('a.b', 'a.b')).toBe(true);
    expect(matchPermissionPattern('axb', 'a.b')).toBe(false);
  });

  it('is anchored at both ends', () => {
    expect(matchPermissionPattern('xx git status', 'git status*')).toBe(false);
  });
});

describe('resolveToolPermission — last matching rule in insertion order wins', () => {
  it('a later rule overrides an earlier one', () => {
    const ruleset: PermissionRule[] = [
      { scope: 'bash', pattern: '*', action: 'ask' },
      { scope: 'bash', pattern: 'git *', action: 'allow' },
      { scope: 'bash', pattern: 'git push*', action: 'deny' },
    ];
    expect(resolveToolPermission(ruleset, 'run_command', 'git status').action).toBe('allow');
    expect(resolveToolPermission(ruleset, 'run_command', 'git push origin main').action).toBe('deny');
    expect(resolveToolPermission(ruleset, 'run_command', 'rm -rf x').action).toBe('ask');
  });

  it('user rules (appended after defaults) beat the built-in defaults', () => {
    const ruleset = buildPermissionRuleset(settings({ tools: { write_file: 'allow' }, bash: { '*': 'allow' } }));
    expect(resolveToolPermission(ruleset, 'write_file').action).toBe('allow'); // default was ask
    expect(resolveToolPermission(ruleset, 'run_command', 'rm -rf /').action).toBe('allow'); // default was ask
  });

  it('bash scope resolves against the command; tools scope against the name', () => {
    const ruleset = buildPermissionRuleset(settings());
    // run_command resolves in the bash space — the tools '*'→allow default must not leak in.
    expect(resolveToolPermission(ruleset, 'run_command', 'rm -rf /').action).toBe('ask');
    expect(resolveToolPermission(ruleset, 'run_command', 'git status --porcelain').action).toBe('allow');
    // whitespace is normalized before matching, so "git  status" still hits "git status*"
    expect(resolveToolPermission(ruleset, 'run_command', '  git   status  ').action).toBe('allow');
    // tools space: read-only tools allow by default, edits ask.
    expect(resolveToolPermission(ruleset, 'read_file').action).toBe('allow');
    expect(resolveToolPermission(ruleset, 'write_file').action).toBe('ask');
    expect(resolveToolPermission(ruleset, 'edit_file').action).toBe('ask');
  });

  it('no matching rule → ask (fail closed, opencode default)', () => {
    expect(resolveToolPermission([], 'anything').action).toBe('ask');
    expect(resolveToolPermission([{ scope: 'tools', pattern: '*', action: 'allow' }], 'run_command', 'ls').action).toBe('ask');
  });
});

describe('sanitizePermissionSettings / mergePermissionSettings', () => {
  it('drops invalid actions and empty patterns, defaults yolo to false', () => {
    const s = sanitizePermissionSettings({ tools: { good: 'deny', bad: 'nuke', '': 'allow' }, bash: 'nope', yolo: 'yes' });
    expect(s).toEqual({ tools: { good: 'deny' }, bash: {}, yolo: false });
  });

  it('preserves rule-map insertion order (it decides precedence)', () => {
    const s = sanitizePermissionSettings({ bash: { '*': 'ask', 'git *': 'allow', 'git push*': 'deny' } });
    expect(Object.keys(s.bash)).toEqual(['*', 'git *', 'git push*']);
  });

  it('merge replaces a present rule map wholesale and keeps absent fields', () => {
    const cur = settings({ tools: { a: 'deny' }, bash: { 'x *': 'allow' }, yolo: true });
    const next = mergePermissionSettings(cur, { tools: { b: 'ask' } });
    expect(next).toEqual({ tools: { b: 'ask' }, bash: { 'x *': 'allow' }, yolo: true });
    expect(mergePermissionSettings(cur, { yolo: false }).yolo).toBe(false);
  });
});

describe('bashAlwaysPattern — "Always allow" suggestion', () => {
  it('takes the arity-aware command prefix plus a trailing *', () => {
    expect(bashAlwaysPattern('git status --porcelain')).toBe('git status*');
    expect(bashAlwaysPattern('npm run build --silent')).toBe('npm run build*');
    expect(bashAlwaysPattern('docker compose up -d')).toBe('docker compose up*');
  });

  it('falls back to the first token for unknown commands — never a bare *', () => {
    expect(bashAlwaysPattern('python script.py')).toBe('python*');
    expect(bashAlwaysPattern('rm -rf x')).toBe('rm*');
    expect(bashAlwaysPattern('')).toBe('*');
  });
});

describe('approvalQuestion / approvalDecision', () => {
  it('builds a single-select, no-Other question with the three fixed options', () => {
    const q = approvalQuestion({ tool: 'run_command', scope: 'bash', command: 'rm -rf x', alwaysPattern: 'rm*' });
    expect(q.multiSelect).toBe(false);
    expect(q.custom).toBe(false);
    expect(q.options.map((o) => o.label)).toEqual([APPROVAL_LABELS.once, APPROVAL_LABELS.always, APPROVAL_LABELS.deny]);
    expect(q.question).toContain('rm -rf x');
    // Non-bash tools name the tool instead of a command.
    expect(approvalQuestion({ tool: 'write_file', scope: 'tools', alwaysPattern: 'write_file' }).question).toContain('write_file');
  });

  it('maps answers to decisions, failing closed on anything unexpected', () => {
    expect(approvalDecision([{ header: 'Approval', selected: [APPROVAL_LABELS.once] }])).toBe('once');
    expect(approvalDecision([{ header: 'Approval', selected: [APPROVAL_LABELS.always] }])).toBe('always');
    expect(approvalDecision([{ header: 'Approval', selected: [APPROVAL_LABELS.deny] }])).toBe('deny');
    expect(approvalDecision([{ header: 'Approval', selected: ['[no answer within the time limit]'] }])).toBe('deny');
    expect(approvalDecision([])).toBe('deny');
  });
});
