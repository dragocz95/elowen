import { describe, it, expect } from 'vitest';
import { sessionItems, modelItems, parseModelValue } from '../../../src/cli/chat/picker.js';

describe('picker item builders', () => {
  it('sessionItems marks the active conversation and falls back to (untitled)', () => {
    const items = sessionItems([
      { id: 'a', title: 'Fix the button', model: 'opus', updated_at: '2026-07-02T12:00:00', active: true },
      { id: 'b', title: '', model: 'kimi', updated_at: '', active: false },
    ]);
    expect(items[0]).toMatchObject({ value: 'a', label: '▸ Fix the button' });
    expect(items[0]!.description).toContain('opus');
    expect(items[0]!.description).toContain('2026-07-02');
    expect(items[1]).toMatchObject({ value: 'b', label: '(untitled)', description: 'kimi' });
  });

  it('modelItems floats the current model to the top and encodes provider+model in the value', () => {
    const items = modelItems([
      { provider: 'relay', providerLabel: 'Relay', model: 'kimi' },
      { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-4-8' },
    ], 'claude-opus-4-8');
    expect(items[0]).toMatchObject({ value: 'anthropic claude-opus-4-8', label: '▸ claude-opus-4-8', description: 'Anthropic' });
    expect(items[1]).toMatchObject({ value: 'relay kimi', label: 'kimi' });
  });

  it('parseModelValue splits the picker value back into a selection', () => {
    expect(parseModelValue('relay kimi')).toEqual({ provider: 'relay', model: 'kimi' });
  });
});
