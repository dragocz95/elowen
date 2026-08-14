import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { rolePrompt, buildRoleAccess, applyVisionModel } from '../../packages/plugin-shared/access.mjs';

describe('shared plugin access descriptor', () => {
  describe('rolePrompt', () => {
    it('names the role and appends its instructions', () => {
      expect(rolePrompt({ name: 'Support', prompt: 'Answer in Czech.' }))
        .toBe('The user you are talking to has the "Support" role.\nAnswer in Czech.');
    });

    it('carries whichever half the policy actually has', () => {
      expect(rolePrompt({ name: 'Support' })).toBe('The user you are talking to has the "Support" role.');
      expect(rolePrompt({ prompt: 'Answer in Czech.' })).toBe('Answer in Czech.');
    });

    it('is undefined — not an empty string — for a policy with neither, so it splices nothing into the prompt', () => {
      expect(rolePrompt({})).toBeUndefined();
      expect(rolePrompt({ name: '', prompt: '' })).toBeUndefined();
    });
  });

  describe('buildRoleAccess', () => {
    it('builds the seven-field descriptor from the policy plus the conversation state', () => {
      const access = buildRoleAccess(
        { name: 'Ops', prompt: 'Be terse.', admin: true, projectIds: ['3', 7], tools: ['Bash', 'Read'] },
        { model: { provider: 'anthropic', model: 'claude-x' }, thinkingLevel: 'high', fast: true },
      );
      expect(access).toEqual({
        admin: true,
        projectIds: [3, 7],
        prompt: 'The user you are talking to has the "Ops" role.\nBe terse.',
        model: { provider: 'anthropic', model: 'claude-x' },
        thinkingLevel: 'high',
        fast: true,
        tools: ['Bash', 'Read'],
      });
    });

    it('grants nothing by default: a bare policy is non-admin, unscoped and unconstrained', () => {
      const access = buildRoleAccess({ roleId: 'r1' }, {});
      expect(access).toEqual({
        admin: false,
        projectIds: [],
        prompt: undefined,
        model: undefined,
        thinkingLevel: undefined,
        fast: false,
        tools: undefined,
      });
    });

    it('only a literal true is admin or fast — a truthy value is not enough on a trust boundary', () => {
      expect(buildRoleAccess({ admin: 'yes' }, {}).admin).toBe(false);
      expect(buildRoleAccess({ admin: 1 }, {}).admin).toBe(false);
      expect(buildRoleAccess({}, { fast: 'yes' }).fast).toBe(false);
      expect(buildRoleAccess({}, { fast: 1 }).fast).toBe(false);
    });

    it('treats an empty tool allowlist as no allowlist, so it can never lock a session out of every tool', () => {
      expect(buildRoleAccess({ tools: [] }, {}).tools).toBeUndefined();
      expect(buildRoleAccess({ tools: 'Bash' }, {}).tools).toBeUndefined();
    });

    it('keeps only the provider/model pair of the saved model, dropping any other stored fields', () => {
      const access = buildRoleAccess({}, { model: { provider: 'openai', model: 'gpt-x', fastAvailable: true } });
      expect(access.model).toEqual({ provider: 'openai', model: 'gpt-x' });
    });

    it('ignores a non-string thinking level so the model default applies', () => {
      expect(buildRoleAccess({}, { thinkingLevel: 3 }).thinkingLevel).toBeUndefined();
      expect(buildRoleAccess({}, {}).thinkingLevel).toBeUndefined();
    });

    it('works for a conversation with no saved state at all (a first-ever turn)', () => {
      expect(() => buildRoleAccess({ roleId: 'r1' })).not.toThrow();
      expect(buildRoleAccess({ roleId: 'r1' }).fast).toBe(false);
    });
  });

  describe('applyVisionModel', () => {
    const access = { admin: true, projectIds: [1], fast: true, tools: ['Read'], thinkingLevel: 'high' };

    it('swaps in the vision model and keeps the rest of the descriptor', () => {
      const models = [{ provider: 'openai', model: 'gpt-vision', fastAvailable: true }];
      const turn = applyVisionModel(access, { provider: 'openai', model: 'gpt-vision' }, models);
      expect(turn.model).toEqual({ provider: 'openai', model: 'gpt-vision' });
      expect(turn.admin).toBe(true);
      expect(turn.projectIds).toEqual([1]);
      expect(turn.tools).toEqual(['Read']);
      expect(turn.thinkingLevel).toBe('high');
    });

    it('keeps fast only when the vision model has its own fast tier', () => {
      const models = [{ provider: 'openai', model: 'gpt-vision', fastAvailable: true }];
      expect(applyVisionModel(access, { model: 'gpt-vision' }, models).fast).toBe(true);
    });

    it('clears fast for a vision model with no fast tier — an OAuth priority tier must not leak into a non-OAuth hop', () => {
      const models = [{ provider: 'openai', model: 'gpt-vision', fastAvailable: false }];
      expect(applyVisionModel(access, { model: 'gpt-vision' }, models).fast).toBe(false);
      // Same for a model the catalog does not describe at all, and for an unavailable catalog.
      expect(applyVisionModel(access, { model: 'unknown-vision' }, models).fast).toBe(false);
      expect(applyVisionModel(access, { model: 'gpt-vision' }, []).fast).toBe(false);
      expect(applyVisionModel(access, { model: 'gpt-vision' }).fast).toBe(false);
    });

    it('matches a provider-qualified vision model only against that provider', () => {
      const models = [{ provider: 'openai', model: 'shared-name', fastAvailable: true }];
      // Same model name under a different provider is not the entry that grants fast.
      expect(applyVisionModel(access, { provider: 'anthropic', model: 'shared-name' }, models).fast).toBe(false);
      expect(applyVisionModel(access, { provider: 'openai', model: 'shared-name' }, models).fast).toBe(true);
    });

    it('does not mutate the conversation access descriptor — the saved profile survives the hop', () => {
      const original = { ...access };
      applyVisionModel(access, { model: 'gpt-vision' }, []);
      expect(access).toEqual(original);
    });
  });
});
