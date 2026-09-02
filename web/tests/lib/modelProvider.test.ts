import { describe, it, expect } from 'vitest';
import { execProvider, execModel, buildExec, brainModelId, brainModelLabel, brainModelQualifiedLabel, type ProviderId } from '../../lib/modelProvider';
import type { BrainModelOption } from '../../lib/types';

const brainModel = (over: Partial<BrainModelOption>): BrainModelOption => ({
  provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5',
  exec: 'elowen:anthropic/claude-opus-5', program: 'elowen', legacyExec: 'elowen:anthropic/claude-opus-5',
  source: 'oauth', contextWindow: 200_000, contextWindowSet: false, ...over,
});

describe('modelProvider', () => {
  describe('execProvider', () => {
    it('maps explicit prefixes to their provider', () => {
      expect(execProvider('codex:gpt-5.5')).toBe('codex');
      expect(execProvider('claude:opus')).toBe('claude-code');
      expect(execProvider('opencode:deepseek/x')).toBe('opencode');
      expect(execProvider('kilo:anthropic/claude-sonnet-4-5')).toBe('kilo');
      expect(execProvider('pi:sonnet')).toBe('pi');
      expect(execProvider('omp:opus')).toBe('omp');
    });
    it('keeps the bare-spec heuristic (slash → the brain, plain → claude)', () => {
      expect(execProvider('a/b')).toBe('elowen');
      expect(execProvider('sonnet')).toBe('claude-code');
    });
    // Mirrors the daemon: the brain's identity is stored WITHOUT a prefix, so the bare slash shape is
    // its own. OpenCode names itself, and that explicit prefix must always win over the shape.
    it('reads a bare provider/model as the brain, and never steals an explicit prefix', () => {
      expect(execProvider('relay/ollama/kimi-k2.7-code')).toBe('elowen');
      expect(execProvider('opencode:ollama-cloud/glm-5.2')).toBe('opencode');
      expect(execProvider('elowen:anthropic/claude-opus-5')).toBe('elowen');
      expect(execProvider('elowen|anthropic|claude-opus-5')).toBe('elowen');
    });
  });

  describe('brain model identity vs. label', () => {
    it('identifies two same-named models from different providers distinctly', () => {
      const a = brainModel({ provider: 'anthropic', exec: 'elowen:anthropic/claude-opus-5' });
      const b = brainModel({ provider: 'relay', providerLabel: 'Relay', exec: 'elowen:relay/claude-opus-5' });
      expect(a.model).toBe(b.model);                     // same visible label…
      expect(brainModelId(a)).not.toBe(brainModelId(b)); // …different identity
    });
    it('resolves the display name through the catalog, keeping a model id that contains slashes intact', () => {
      const slashy = brainModel({ provider: 'relay', model: 'ollama/kimi-k2.7-code', exec: 'elowen:relay/ollama/kimi-k2.7-code' });
      expect(brainModelLabel('elowen:relay/ollama/kimi-k2.7-code', [slashy])).toBe('ollama/kimi-k2.7-code');
    });
    // The catalog is what makes a name trustworthy: an exec no catalog entry matches is shown verbatim
    // rather than sliced at a slash, which is what turned a stale pick into a mangled half-name.
    it('falls back to the raw exec so an unknown pick stays visible and whole', () => {
      expect(brainModelLabel('elowen:gone/model', [brainModel({})])).toBe('elowen:gone/model');
      expect(brainModelLabel('sonnet', undefined)).toBe('sonnet');
    });
    // Outside a provider-grouped list the bare name is ambiguous, so the summary label carries the
    // provider. It is COMPOSED from the catalog fields: splitting the exec would cut a model id that
    // contains slashes in the wrong place, which is the bug the plain label already had to avoid.
    it('qualifies the name with its provider where no group header does it', () => {
      const a = brainModel({ provider: 'anthropic', exec: 'anthropic/claude-opus-5' });
      const b = brainModel({ provider: 'relay', providerLabel: 'Relay', exec: 'relay/claude-opus-5' });
      expect(brainModelQualifiedLabel('anthropic/claude-opus-5', [a, b])).toBe('anthropic/claude-opus-5');
      expect(brainModelQualifiedLabel('relay/claude-opus-5', [a, b])).toBe('relay/claude-opus-5');
      // …and the two now READ differently, which is the whole point — plain labels are identical here.
      expect(brainModelLabel('anthropic/claude-opus-5', [a, b])).toBe(brainModelLabel('relay/claude-opus-5', [a, b]));
    });
    it('keeps a slashed model id whole when qualifying it, and falls back to the raw exec', () => {
      const slashy = brainModel({ provider: 'ai-coresynth-io', model: 'deepseek/deepseek-v4-pro', exec: 'ai-coresynth-io/deepseek/deepseek-v4-pro' });
      expect(brainModelQualifiedLabel('ai-coresynth-io/deepseek/deepseek-v4-pro', [slashy]))
        .toBe('ai-coresynth-io/deepseek/deepseek-v4-pro');
      expect(brainModelQualifiedLabel('gone/model', [brainModel({})])).toBe('gone/model');
      expect(brainModelQualifiedLabel('sonnet', undefined)).toBe('sonnet');
      expect(brainModelQualifiedLabel({ provider: 'alibaba', model: 'deepseek-v4-pro' }))
        .toBe('alibaba/deepseek-v4-pro');
    });

    // The structured form is prose for a human, so the operator's own name for the provider wins. The
    // string form is not: it names an exec the reader may have to type or match in an allow-list, so it
    // stays spelled as stored. Mutation: use the label in the string branch too and the exec case fails.
    it('prefers the operator label in the structured form and the stored id in the string form', () => {
      const custom = brainModel({ provider: 'ollama', providerLabel: 'Ollama', model: 'kimi-k2.7-code', exec: 'ollama/kimi-k2.7-code' });
      expect(brainModelQualifiedLabel({ provider: 'ollama', providerLabel: 'Ollama', model: 'kimi-k2.7-code' }))
        .toBe('Ollama/kimi-k2.7-code');
      expect(brainModelQualifiedLabel('ollama/kimi-k2.7-code', [custom])).toBe('ollama/kimi-k2.7-code');
    });

    // A provider deleted from Settings leaves no label behind; its config id is the honest fallback, and
    // it is already the PUBLIC name — PI's internal `elowen-<id>` namespace never reaches a client.
    it('falls back to the provider id when no label is known', () => {
      expect(brainModelQualifiedLabel({ provider: 'ollama', providerLabel: '', model: 'kimi-k2.7-code' }))
        .toBe('ollama/kimi-k2.7-code');
    });
  });

  describe('execModel', () => {
    it('strips the provider prefix for the new CLIs', () => {
      expect(execModel('kilo:anthropic/claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5');
      expect(execModel('pi:sonnet')).toBe('sonnet');
      expect(execModel('omp:opus')).toBe('opus');
      expect(execModel('elowen|relay|ollama%2Fkimi-k2.7-code')).toBe('ollama/kimi-k2.7-code');
    });
  });

  describe('buildExec', () => {
    it('always prefixes the new (provider-agnostic) CLIs', () => {
      expect(buildExec('kilo', 'anthropic/claude-sonnet-4-5')).toBe('kilo:anthropic/claude-sonnet-4-5');
      expect(buildExec('pi', 'sonnet')).toBe('pi:sonnet');
      expect(buildExec('omp', 'opus')).toBe('omp:opus');
    });
    it('round-trips provider/model through build → parse for every new CLI', () => {
      for (const provider of ['kilo', 'pi', 'omp'] as ProviderId[]) {
        const exec = buildExec(provider, 'anthropic/claude-sonnet-4-5');
        expect(execProvider(exec)).toBe(provider);
        expect(execModel(exec)).toBe('anthropic/claude-sonnet-4-5');
      }
    });
  });
});
