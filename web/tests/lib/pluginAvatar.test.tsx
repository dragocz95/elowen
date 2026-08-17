import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';

type AvatarProps = {
  name?: string;
  user?: { id: number; username: string; name?: string; avatar?: string };
  size?: number | 'sm' | 'md' | 'lg';
};

describe('plugin Avatar runtime adapter', () => {
  it('renders a directory person from only a name without using the account-only user contract', () => {
    ensurePluginUiRuntime();
    const Avatar = window.ElowenUiRuntime!.components.Avatar as ComponentType<AvatarProps>;

    render(<Avatar name="Alex Rivera" size="lg" />);

    const avatar = screen.getByLabelText('Alex Rivera');
    expect(avatar).toHaveTextContent('AL');
    expect(avatar).toHaveStyle({ width: '44px', height: '44px' });
  });
});
