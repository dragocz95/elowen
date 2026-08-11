import { describe, it, expect } from 'vitest';
import { execOfLabels } from '../../../../plugins/agents/src/usage/byModel.js';

describe('execOfLabels', () => {
  it('extracts the exec spec, or empty string', () => {
    expect(execOfLabels(['exec:sonnet', 'agent:x'])).toBe('sonnet');
    expect(execOfLabels(['exec:codex:gpt-5.5'])).toBe('codex:gpt-5.5');
    expect(execOfLabels(['agent:x'])).toBe('');
    expect(execOfLabels(undefined)).toBe('');
  });
});
