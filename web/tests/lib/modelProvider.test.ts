import { describe, it, expect } from 'vitest';
import { execProvider, execModel, buildExec, brainModelId, brainModelLabel, type ProviderId } from '../../lib/modelProvider';
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
    it('keeps the bare-spec heuristic (slash → opencode, plain → claude)', () => {
      expect(execProvider('a/b')).toBe('opencode');
      expect(execProvider('sonnet')).toBe('claude-code');
    });
    // Mirrors the daemon guard: the embedded brain is named by its prefix (or, on the wire, by the
    // model's `program` field) — never by a slash, which belongs to the OpenCode contract.
    it('never reads a bare provider/model as the embedded brain', () => {
      expect(execProvider('ollama-cloud/glm-5.2')).toBe('opencode');
      expect(execProvider('relay/ollama/kimi-k2.7-code')).toBe('opencode');
      expect(execProvider('elowen:anthropic/claude-opus-5')).toBe('elowen');
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
  });

  describe('execModel', () => {
    it('strips the provider prefix for the new CLIs', () => {
      expect(execModel('kilo:anthropic/claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5');
      expect(execModel('pi:sonnet')).toBe('sonnet');
      expect(execModel('omp:opus')).toBe('opus');
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
