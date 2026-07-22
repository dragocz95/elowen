import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { BrainModelOption } from '../../../lib/types';
import { CompactThresholdsDrawer } from '../../../modules/account/CompactThresholdsDrawer';

const MODELS: BrainModelOption[] = [
  { provider: 'relay', providerLabel: 'Relay', model: 'gpt-x', exec: 'elowen:relay/gpt-x', source: 'relay', contextWindow: 32000, contextWindowSet: false },
  { provider: 'ant', providerLabel: 'Anthropic', model: 'claude-x', exec: 'elowen:ant/claude-x', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
];

const renderDrawer = (props: Partial<ComponentProps<typeof CompactThresholdsDrawer>> = {}) => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <CompactThresholdsDrawer models={MODELS} thresholds={{ 'relay/gpt-x': 65 }} defaultPct={80} onChange={onChange} onClose={onClose} {...props} />,
    { wrapper: createWrapper().wrapper },
  );
  return { onChange, onClose };
};

describe('CompactThresholdsDrawer', () => {
  it('shows the override percentage for a tuned model and the default label for an untuned one', () => {
    renderDrawer();
    expect(screen.getByText('65%')).toBeTruthy(); // relay/gpt-x has an override
    expect(screen.getByText(en.cli.compactByModelDefault)).toBeTruthy(); // ant/claude-x inherits the global default
  });

  it('dragging a slider sets an override keyed provider/model; reset clears it', () => {
    const { onChange } = renderDrawer();
    // Row order follows MODELS: [0] relay/gpt-x (tuned), [1] ant/claude-x (untuned).
    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[1]!, { target: { value: '70' } });
    expect(onChange).toHaveBeenCalledWith('ant/claude-x', 70);
    // The tuned row exposes a reset control that clears its override (null → inherit the global).
    fireEvent.click(screen.getByRole('button', { name: `${en.cli.compactByModelReset}: Relay gpt-x` }));
    expect(onChange).toHaveBeenCalledWith('relay/gpt-x', null);
  });
});
