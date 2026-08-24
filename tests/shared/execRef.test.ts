import { describe, it, expect } from 'vitest';
import {
  parseExecRef,
  execRefSpec,
  execSpecProgram,
  isElowenExec,
  isExecAllowedForUser,
  isModelVisibleForUser,
  elowenExec,
  type ExecRef,
} from '../../src/shared/execs.js';
import { resolveExecutor } from '../../src/shared/execRouting.js';
/** The brain providers this installation has configured. A brain exec only skips the global
 *  allow-list when its provider is one of these — see isOfferableExec. */
const PROVIDERS = ['x', 'any', 'relay', 'other', 'anthropic', 'oauth-anthropic', 'prov']
  .map((id) => ({ id, models: [] as string[] }));


/**
 * The identity contract after the `elowen:` prefix removal. Exactly ONE program may own the bare
 * `provider/model` shape, because nothing in the string itself distinguishes two programs that both
 * spell a model that way. That shape now belongs to the embedded brain — which is what lets stored
 * identities read `anthropic/claude-opus-5` instead of `elowen:anthropic/claude-opus-5` — and OpenCode,
 * which held it historically, names itself explicitly. Every other program is decided by its prefix
 * (legacy string) or by its explicit field (structured form), never by the value's shape.
 */
describe('exec identity', () => {
  describe('routing table — four input shapes, four programs', () => {
    const cases: Array<[string, Parameters<typeof parseExecRef>[0], ExecRef]> = [
      ['legacy elowen string', 'elowen:anthropic/claude-opus-5', { program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' }],
      ['structured elowen', { program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' }, { program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' }],
      ['canonical bare provider/model is the brain', 'anthropic/claude-opus-5', { program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' }],
      ['explicitly prefixed OpenCode', 'opencode:ollama-cloud/glm-5.2', { program: 'opencode', model: 'ollama-cloud/glm-5.2' }],
      ['bare model is Claude Code', 'sonnet', { program: 'claude-code', model: 'sonnet' }],
    ];
    for (const [name, input, expected] of cases) {
      it(`${name} → ${expected.program}`, () => {
        expect(parseExecRef(input)).toEqual(expected);
      });
    }

    // THE mutation guard, in the direction that is now dangerous: another program's explicit prefix
    // must NEVER be swallowed by the brain just because the rest of the value contains a slash. Drop
    // the prefix check in parseElowenExec and `opencode:ollama-cloud/glm-5.2` starts running in-process
    // on a provider called "opencode:ollama-cloud".
    it('an explicit prefix always wins over the bare-slash shape', () => {
      expect(parseExecRef('opencode:ollama-cloud/glm-5.2')).toEqual({ program: 'opencode', model: 'ollama-cloud/glm-5.2' });
      expect(isElowenExec('opencode:ollama-cloud/glm-5.2')).toBe(false);
      expect(execSpecProgram('opencode:vendor/model')).toBe('opencode');
      expect(execSpecProgram('codex:gpt-5.5')).toBe('codex');
      // …and a value with no slash at all is still Claude Code, never a provider-less brain exec.
      expect(execSpecProgram('sonnet')).toBe('claude-code');
      expect(isElowenExec('sonnet')).toBe(false);
    });

    it('routes the same shapes identically through resolveExecutor (the spawn path)', () => {
      const program = (spec: string) => resolveExecutor([`exec:${spec}`], { program: 'x', model: 'x' }).program;
      expect(program('elowen:anthropic/claude-opus-5')).toBe('elowen');
      expect(program('anthropic/claude-opus-5')).toBe('elowen');
      expect(program('opencode:ollama-cloud/glm-5.2')).toBe('opencode');
      expect(program('sonnet')).toBe('claude-code');
      expect(program('codex:gpt-5.5')).toBe('codex');
      // the spawn shape is unchanged: the brain is still handed `<provider>/<model>`
      expect(resolveExecutor(['exec:elowen:anthropic/claude-opus-5'], { program: 'x', model: 'x' }))
        .toEqual({ program: 'elowen', model: 'anthropic/claude-opus-5' });
      expect(resolveExecutor(['exec:anthropic/claude-opus-5'], { program: 'x', model: 'x' }))
        .toEqual({ program: 'elowen', model: 'anthropic/claude-opus-5' });
    });
  });

  describe('backwards compatibility — values already stored by an older release', () => {
    // This is the test that makes F1/F2 deployable on their own: nothing in the database changes, so
    // every prefixed value written by the previous release must still resolve to the same identity.
    const stored = [
      'elowen:oauth-anthropic/claude-sonnet-4',
      'elowen:relay/ollama/kimi-k2.7-code',
      'elowen|relay|ollama%2Fkimi-k2.7-code', // the interim composite, read-only
      'codex:gpt-5.5',
      'opencode:ollama-cloud/glm-5.2',
      'sonnet',
    ];
    it('reads every legacy spec and writes the one canonical spelling', () => {
      for (const spec of stored) {
        const ref = parseExecRef(spec);
        expect(ref, spec).not.toBeNull();
        const formatted = execRefSpec(ref!);
        expect(parseExecRef(formatted), spec).toEqual(ref);
        if (ref!.program === 'elowen') {
          // the whole point: no prefix survives into what we persist
          expect(formatted).not.toContain('elowen:');
          expect(formatted).not.toContain('elowen|');
          expect(formatted).toBe(`${ref!.provider}/${ref!.model}`);
        } else expect(formatted).toBe(spec);
      }
    });
    it('round-trips an explicitly prefixed OpenCode spec unchanged', () => {
      const ref = parseExecRef('opencode:vendor/model')!;
      expect(ref).toEqual({ program: 'opencode', model: 'vendor/model' });
      expect(execRefSpec(ref)).toBe('opencode:vendor/model');
    });
    it('keeps the provider of a stored brain exec whose model itself contains slashes', () => {
      expect(parseExecRef('elowen:relay/ollama/kimi-k2.7-code'))
        .toEqual({ program: 'elowen', provider: 'relay', model: 'ollama/kimi-k2.7-code' });
      expect(parseExecRef('relay/ollama/kimi-k2.7-code'))
        .toEqual({ program: 'elowen', provider: 'relay', model: 'ollama/kimi-k2.7-code' });
    });
    it('elowenExec produces the unprefixed identity', () => {
      expect(elowenExec('anthropic', 'claude-opus-5')).toBe('anthropic/claude-opus-5');
      expect(parseExecRef('anthropic/claude-opus-5')).toEqual({ program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' });
    });
    it('rejects a value that names no runnable model', () => {
      expect(parseExecRef('elowen:relay')).toBeNull();      // brain exec without a model
      expect(parseExecRef('elowen:/model')).toBeNull();     // …without a provider
      expect(parseExecRef({ program: 'elowen', model: 'm' })).toBeNull(); // structured, provider missing
      expect(parseExecRef({ program: 'nope', model: 'm' })).toBeNull();   // unknown program
      expect(parseExecRef('')).toBeNull();
    });
  });

  describe('permissions decide on the program, not on the text', () => {
    const globalExecs = ['sonnet']; // the CLI allow-list; brain execs are bounded by providers instead
    const structured = { program: 'elowen', provider: 'relay', model: 'kimi' } as const;

    it('non-admin with an allow-list: the structured form is judged like the legacy string', () => {
      const bob = { is_admin: false, allowed_execs: ['elowen:relay/kimi'] };
      expect(isExecAllowedForUser(bob, globalExecs, 'elowen:relay/kimi', PROVIDERS)).toBe(true);
      // A `startsWith('elowen:')` check cannot see this value's program — it has no prefix to match.
      expect(isExecAllowedForUser(bob, globalExecs, structured, PROVIDERS)).toBe(true);
      expect(isExecAllowedForUser(bob, globalExecs, { program: 'elowen', provider: 'other', model: 'kimi' }, PROVIDERS)).toBe(false);
    });
    it('an empty personal list still skips the global bound for a structured brain exec', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, structured, PROVIDERS)).toBe(true);
      // …while a CLI exec stays bounded by it, in both forms.
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'opus', PROVIDERS)).toBe(false);
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, { program: 'claude-code', model: 'opus' }, PROVIDERS)).toBe(false);
    });
    it('admin grant is unrestricted in both forms', () => {
      expect(isExecAllowedForUser({ is_admin: true, allowed_execs: [] }, globalExecs, structured, PROVIDERS)).toBe(true);
      expect(isExecAllowedForUser(null, globalExecs, structured, PROVIDERS)).toBe(true);
    });
    it('the picker filter follows the same program test', () => {
      expect(isModelVisibleForUser({ allowed_execs: [] }, globalExecs, structured, PROVIDERS)).toBe(true);
      expect(isModelVisibleForUser({ allowed_execs: ['sonnet'] }, globalExecs, structured, PROVIDERS)).toBe(false);
    });
    // Dropping the prefix widened what parses as a brain exec from "starts with elowen:" to "contains a
    // slash". The global allow-list bypass must therefore ask the narrower question — is this provider
    // CONFIGURED — or every typo becomes a brain exec and walks straight past the bound. Mutation: use
    // isElowenExec instead of the provider-set test in either gate and `bogus/model` is granted.
    it('a slash-shaped string only skips the global bound when its provider is configured', () => {
      const bob = { is_admin: false, allowed_execs: [] };
      expect(isExecAllowedForUser(bob, globalExecs, 'relay/kimi', PROVIDERS)).toBe(true);
      expect(isExecAllowedForUser(bob, globalExecs, 'bogus/model', PROVIDERS)).toBe(false);
      expect(isModelVisibleForUser({ allowed_execs: [] }, globalExecs, 'bogus/model', PROVIDERS)).toBe(false);
      // …and the same holds for the structured form, which cannot be judged by text at all.
      expect(isExecAllowedForUser(bob, globalExecs, { program: 'elowen', provider: 'bogus', model: 'm' }, PROVIDERS)).toBe(false);
    });
    it('refuses a structured value that names no runnable model', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, { program: 'elowen', model: 'kimi' }, PROVIDERS)).toBe(false);
    });
  });
});
