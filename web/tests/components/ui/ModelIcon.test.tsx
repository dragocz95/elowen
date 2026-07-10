import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelIcon } from '../../../components/ui/ModelIcon';

describe('ModelIcon', () => {
  it('uses the shipped WebP directly for Xiaomi MiMo without a failing SVG request first', () => {
    const { container } = render(<ModelIcon name="xiaomi/mimo" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/models/xiaomimimo-color.webp');
  });
});
