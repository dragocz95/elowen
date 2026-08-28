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
    it('builds the four-field descriptor from the policy plus conversation-local model state', () => {
      // The policy deliberately still carries `projectIds` and `tools`: an operator's stored config may
      // hold them for years, and the descriptor must simply not pass them on.
      const access = buildRoleAccess(
        { name: 'Ops', prompt: 'Be terse.', admin: true, projectIds: ['3', 7], tools: ['Bash', 'Read'] },
        { model: { provider: 'anthropic', model: 'claude-x' }, thinkingLevel: 'high', fast: true },
      );
      expect(access).toEqual({
        admin: true,
        prompt: 'The user you are talking to has the "Ops" role.\nBe terse.',
        model: { provider: 'anthropic', model: 'claude-x' },
        thinkingLevel: 'high',
      });
    });

    it('grants nothing by default: a bare policy is non-admin and unconstrained', () => {
      const access = buildRoleAccess({ roleId: 'r1' }, {});
      expect(access).toEqual({
        admin: false,
        prompt: undefined,
        model: undefined,
        thinkingLevel: undefined,
      });
    });

    it('only a literal true is admin, and Fast never enters the role descriptor', () => {
      expect(buildRoleAccess({ admin: 'yes' }, {}).admin).toBe(false);
      expect(buildRoleAccess({ admin: 1 }, {}).admin).toBe(false);
      expect(buildRoleAccess({}, { fast: true })).not.toHaveProperty('fast');
    });

    it('never carries authority: a role cannot grant tools or project scope, however it is written', () => {
      // Both fields used to be built here and read by NOTHING in the host, so narrowing a role in the
      // settings UI changed nothing at all — it failed open while looking like a restriction. Authority
      // now comes from the verified sender's own account, and the descriptor must not carry a field that
      // could be mistaken for a grant.
      for (const policy of [
        { tools: ['Bash'], projectIds: [3] },
        { tools: [], projectIds: [] },
        { tools: 'Bash', projectIds: '3' },
      ]) {
        const access = buildRoleAccess(policy, {});
        expect(access).not.toHaveProperty('tools');
        expect(access).not.toHaveProperty('projectIds');
      }
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
      expect(buildRoleAccess({ roleId: 'r1' })).not.toHaveProperty('fast');
    });
  });

  describe('applyVisionModel', () => {
    const access = { admin: true, projectIds: [1], tools: ['Read'], thinkingLevel: 'high' };

    it('swaps in the vision model and keeps the rest of the descriptor', () => {
      const turn = applyVisionModel(access, { provider: 'openai', model: 'gpt-vision' }, []);
      expect(turn.model).toEqual({ provider: 'openai', model: 'gpt-vision' });
      expect(turn.admin).toBe(true);
      expect(turn.projectIds).toEqual([1]);
      expect(turn.tools).toEqual(['Read']);
      expect(turn.thinkingLevel).toBe('high');
      expect(turn).not.toHaveProperty('fast');
    });

    it('does not derive Fast from model catalog metadata', () => {
      const models = [{ provider: 'openai', model: 'gpt-vision', fastAvailable: true }];
      expect(applyVisionModel(access, { model: 'gpt-vision' }, models)).not.toHaveProperty('fast');
    });

    it('does not mutate the conversation access descriptor', () => {
      const original = { ...access };
      applyVisionModel(access, { model: 'gpt-vision' }, []);
      expect(access).toEqual(original);
    });
  });
});
