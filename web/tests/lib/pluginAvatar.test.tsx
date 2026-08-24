import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';

type AvatarProps = {
  name?: string;
  src?: string;
  user?: { id: number; username: string; name?: string; avatar?: string };
  size?: number | 'sm' | 'md' | 'lg';
};

describe('plugin Avatar runtime adapter', () => {
  it('renders a directory person from only a name without using the account-only user contract', () => {
    ensurePluginUiRuntime();
    const Avatar = window.ElowenUiRuntime!.components.Avatar as ComponentType<AvatarProps>;

    render(<Avatar name="Alex Rivera" size="lg" />);

    const avatar = screen.getByLabelText('Alex Rivera');
    expect(avatar).toHaveTextContent('AR');
    expect(avatar).toHaveStyle({ width: '44px', height: '44px' });
  });

  it('falls back from a plugin image to the linked account avatar contract', () => {
    ensurePluginUiRuntime();
    const Avatar = window.ElowenUiRuntime!.components.Avatar as ComponentType<AvatarProps>;

    render(<Avatar name="Alex Rivera" src="/api/plugins/demo/avatar" user={{ id: 7, username: 'alex' }} />);
    const image = screen.getByRole('img', { name: 'Alex Rivera' });
    expect(image).toHaveAttribute('src', '/api/plugins/demo/avatar');

    fireEvent.error(image);
    expect(screen.getByLabelText('alex')).toHaveTextContent('AL');
  });
});
