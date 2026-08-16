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

/**
 * The identity contract behind the `elowen:` prefix removal. The prefix is a DISCRIMINATOR, not a
 * label: it says which program runs the model. These tests pin that the program is only ever decided
 * by an explicit prefix (legacy string) or an explicit field (structured form) — never guessed from
 * whether the value happens to contain a slash, which is the OpenCode contract.
 */
describe('exec identity', () => {
  describe('routing table — four input shapes, four programs', () => {
    const cases: Array<[string, Parameters<typeof parseExecRef>[0], ExecRef]> = [
      ['legacy elowen string', 'elowen:anthropic/claude-opus-5', { program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' }],
      ['structured elowen', { program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' }, { program: 'elowen', provider: 'anthropic', model: 'claude-opus-5' }],
      ['bare provider/model is OpenCode', 'ollama-cloud/glm-5.2', { program: 'opencode', model: 'ollama-cloud/glm-5.2' }],
      ['bare model is Claude Code', 'sonnet', { program: 'claude-code', model: 'sonnet' }],
    ];
    for (const [name, input, expected] of cases) {
      it(`${name} → ${expected.program}`, () => {
        expect(parseExecRef(input)).toEqual(expected);
      });
    }

    // THE mutation guard: make the parser infer the program from the value's shape (a slash ⇒ elowen)
    // and this pair flips — a stored OpenCode exec would start running on the embedded brain.
    it('never infers elowen from a slash — a bare provider/model stays OpenCode', () => {
      expect(parseExecRef('ollama-cloud/glm-5.2')?.program).toBe('opencode');
      expect(parseExecRef('relay/ollama/kimi-k2.7-code')?.program).toBe('opencode');
      expect(isElowenExec('ollama-cloud/glm-5.2')).toBe(false);
      expect(execSpecProgram('anthropic/claude-opus-5')).toBe('opencode');
    });

    it('routes the same four shapes identically through resolveExecutor (the spawn path)', () => {
      const program = (spec: string) => resolveExecutor([`exec:${spec}`], { program: 'x', model: 'x' }).program;
      expect(program('elowen:anthropic/claude-opus-5')).toBe('elowen');
      expect(program('ollama-cloud/glm-5.2')).toBe('opencode');
      expect(program('sonnet')).toBe('claude-code');
      expect(program('codex:gpt-5.5')).toBe('codex');
      // the model keeps its historical shape: prefix stripped, `<provider>/<model>` left intact
      expect(resolveExecutor(['exec:elowen:anthropic/claude-opus-5'], { program: 'x', model: 'x' }))
        .toEqual({ program: 'elowen', model: 'anthropic/claude-opus-5' });
    });
  });

  describe('backwards compatibility — values already stored by an older release', () => {
    // This is the test that makes F1/F2 deployable on their own: nothing in the database changes, so
    // every prefixed value written by the previous release must still resolve to the same identity.
    const stored = [
      'elowen:oauth-anthropic/claude-sonnet-4',
      'elowen:relay/ollama/kimi-k2.7-code',
      'codex:gpt-5.5',
      'ollama-cloud/glm-5.2',
      'sonnet',
    ];
    it('round-trips every stored spec through parse → format unchanged', () => {
      for (const spec of stored) {
        const ref = parseExecRef(spec);
        expect(ref, spec).not.toBeNull();
        expect(execRefSpec(ref!), spec).toBe(spec);
      }
    });
    it('keeps the provider of a stored brain exec whose model itself contains slashes', () => {
      expect(parseExecRef('elowen:relay/ollama/kimi-k2.7-code'))
        .toEqual({ program: 'elowen', provider: 'relay', model: 'ollama/kimi-k2.7-code' });
    });
    it('elowenExec still produces the legacy string other releases read', () => {
      expect(elowenExec('anthropic', 'claude-opus-5')).toBe('elowen:anthropic/claude-opus-5');
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
      expect(isExecAllowedForUser(bob, globalExecs, 'elowen:relay/kimi')).toBe(true);
      // A `startsWith('elowen:')` check cannot see this value's program — it has no prefix to match.
      expect(isExecAllowedForUser(bob, globalExecs, structured)).toBe(true);
      expect(isExecAllowedForUser(bob, globalExecs, { program: 'elowen', provider: 'other', model: 'kimi' })).toBe(false);
    });
    it('an empty personal list still skips the global bound for a structured brain exec', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, structured)).toBe(true);
      // …while a CLI exec stays bounded by it, in both forms.
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'opus')).toBe(false);
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, { program: 'claude-code', model: 'opus' })).toBe(false);
    });
    it('admin grant is unrestricted in both forms', () => {
      expect(isExecAllowedForUser({ is_admin: true, allowed_execs: [] }, globalExecs, structured)).toBe(true);
      expect(isExecAllowedForUser(null, globalExecs, structured)).toBe(true);
    });
    it('the picker filter follows the same program test', () => {
      expect(isModelVisibleForUser({ allowed_execs: [] }, globalExecs, structured)).toBe(true);
      expect(isModelVisibleForUser({ allowed_execs: ['sonnet'] }, globalExecs, structured)).toBe(false);
    });
    it('refuses a structured value that names no runnable model', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, { program: 'elowen', model: 'kimi' })).toBe(false);
    });
  });
});
