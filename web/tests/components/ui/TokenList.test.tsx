import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { TokenList } from '../../../components/ui/TokenList';

function ControlledTokenList({ onChange = () => {} }: { onChange?: (value: string[]) => void }) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <LanguageProvider>
      <TokenList
        label="Paths"
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    </LanguageProvider>
  );
}

describe('TokenList', () => {
  it('splits multiline paste by lines, preserves commas, and joins the existing draft to the first line', () => {
    const onChange = vi.fn();
    render(<ControlledTokenList onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Add to Paths' });

    fireEvent.change(input, { target: { value: 'draft-' } });
    fireEvent.paste(input, { clipboardData: { getData: () => 'src/**/*.{ts,tsx}\n/path,with,comma\n/path,with,comma' } });
    expect(onChange).toHaveBeenLastCalledWith(['draft-src/**/*.{ts,tsx}', '/path,with,comma']);
  });

  it('uses comma as a delimiter outside braces but preserves it inside a brace glob', () => {
    const onChange = vi.fn();
    render(<ControlledTokenList onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Add to Paths' });

    fireEvent.change(input, { target: { value: 'src/**/*.{ts' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'src/**/*.{ts,tsx}' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['src/**/*.{ts,tsx}']);

    fireEvent.change(input, { target: { value: 'next' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenLastCalledWith(['src/**/*.{ts,tsx}', 'next']);
  });

  it('does not commit Enter, comma or multiline paste while an IME composition is active', () => {
    const onChange = vi.fn();
    render(<ControlledTokenList onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Add to Paths' });
    fireEvent.change(input, { target: { value: '東京' } });

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: ',', isComposing: true });
    fireEvent.paste(input, { isComposing: true, clipboardData: { getData: () => '東京\n大阪' } });

    expect(onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    expect(input).toHaveValue('東京');
  });

  it('exposes the list and remove affordances by name', () => {
    render(<ControlledTokenList />);
    expect(screen.getByText('No entries yet.')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Add to Paths' });
    fireEvent.paste(input, { clipboardData: { getData: () => '/one\n/two' } });

    expect(screen.getByRole('list', { name: 'Paths entries' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove /one' }));
    expect(screen.queryByText('/one')).toBeNull();
    expect(screen.getByText('/two')).toBeInTheDocument();
  });
});
