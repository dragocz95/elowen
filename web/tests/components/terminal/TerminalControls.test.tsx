import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalControls } from '../../../components/terminal/TerminalControls';

describe('TerminalControls', () => {
  it('submits typed text as [text, Enter] and clears the input', () => {
    const onSendKeys = vi.fn();
    render(<TerminalControls onSendKeys={onSendKeys} onKill={() => {}} />);
    const input = screen.getByPlaceholderText(/command/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ls -la' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSendKeys).toHaveBeenCalledWith(['ls -la', 'Enter']);
    expect(input.value).toBe('');
  });

  it('quick-key buttons send their tmux key names', () => {
    const onSendKeys = vi.fn();
    render(<TerminalControls onSendKeys={onSendKeys} onKill={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-C' }));
    expect(onSendKeys).toHaveBeenCalledWith(['C-c']);
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    expect(onSendKeys).toHaveBeenCalledWith(['Escape']);
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(onSendKeys).toHaveBeenCalledWith(['Enter']);
  });

  it('Kill calls onKill', () => {
    const onKill = vi.fn();
    render(<TerminalControls onSendKeys={() => {}} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    expect(onKill).toHaveBeenCalled();
  });

  it('busy disables the quick-key and kill buttons', () => {
    render(<TerminalControls onSendKeys={() => {}} onKill={() => {}} busy />);
    expect(screen.getByRole('button', { name: 'Ctrl-C' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Kill' })).toBeDisabled();
  });
});
