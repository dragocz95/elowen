import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelIcon } from '../../../components/ui/ModelIcon';
import { ProviderIcon, providerMeta } from '../../../modules/settings/providers';

describe('ModelIcon', () => {
  it('uses the shipped WebP directly for Xiaomi MiMo without a failing SVG request first', () => {
    const { container } = render(<ModelIcon name="xiaomi/mimo" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/models/xiaomimimo-color.webp');
  });

  it('renders monochrome model marks through currentColor instead of a root-theme invert', () => {
    const { container } = render(<ModelIcon name="openai/gpt-5.6" />);
    const mark = container.querySelector('[data-brand-mark="monochrome"]');
    expect((mark as HTMLElement).style.backgroundColor.toLowerCase()).toBe('currentcolor');
    expect((mark as HTMLElement).style.maskImage).toBe('url("/models/openai.svg")');
    expect(container.querySelector('.invert')).toBeNull();
  });

  it('keeps real color model marks as images', () => {
    const { container } = render(<ModelIcon name="claude-opus-5" />);
    expect(container.querySelector('[data-brand-mark="color"]')).toHaveAttribute('src', '/models/claude-color.svg');
  });

  it('uses the same adaptive mark in every provider-logo surface', () => {
    const codex = providerMeta('codex');
    const claude = providerMeta('claude-code');
    expect(codex).toBeDefined();
    expect(claude).toBeDefined();

    const { container, rerender } = render(<ProviderIcon meta={codex!} size={14} />);
    const mark = container.querySelector('[data-brand-mark="monochrome"]') as HTMLElement;
    expect(mark.style.backgroundColor.toLowerCase()).toBe('currentcolor');

    rerender(<ProviderIcon meta={claude!} size={14} />);
    expect(container.querySelector('[data-brand-mark="color"]')).toHaveAttribute('src', '/providers/anthropic.png');
  });
});
