import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, TUI } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { ApprovalDock, runApprovalFlow } from '../../../src/cli/chat/components.js';
import { approvalQuestion } from '../../../src/brain/toolPermissions.js';
import type { AskQuestion } from '../../../src/brain/events.js';

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

const fakeTui = (): TUI => ({
  requestRender: vi.fn(),
  setFocus: vi.fn(),
}) as unknown as TUI;

const q = (): AskQuestion =>
  approvalQuestion({ tool: 'run_command', scope: 'bash', command: 'rm -rf build', alwaysPattern: 'rm*' });

describe('ApprovalDock — blocking tool-approval prompt', () => {
  beforeAll(() => { initTheme(); });

  it('renders the command and the three options within the requested width', () => {
    const dock = new ApprovalDock({ tui: fakeTui(), question: q(), onPick: vi.fn() });
    const lines = dock.render(72);
    const text = stripAnsi(lines.join('\n'));
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
    expect(text).toContain('Approval needed');
    expect(text).toContain('rm -rf build');
    expect(text).toContain('1. Allow once');
    expect(text).toContain('2. Always allow');
    expect(text).toContain('3. Deny');
  });

  it('digit keys pick that option instantly', () => {
    const onPick = vi.fn();
    new ApprovalDock({ tui: fakeTui(), question: q(), onPick }).handleInput('2');
    expect(onPick).toHaveBeenCalledWith('Always allow');
  });

  it('arrows + Enter confirm the highlighted option', () => {
    const onPick = vi.fn();
    const dock = new ApprovalDock({ tui: fakeTui(), question: q(), onPick });
    dock.handleInput('\x1b[B'); // down → Always allow
    dock.handleInput('\x1b[B'); // down → Deny
    dock.handleInput('\r');
    expect(onPick).toHaveBeenCalledWith('Deny');
  });

  it('Esc always resolves to Deny — a bail can never approve', () => {
    const onPick = vi.fn();
    const dock = new ApprovalDock({ tui: fakeTui(), question: q(), onPick });
    dock.handleInput('\x1b'); // escape
    expect(onPick).toHaveBeenCalledWith('Deny');
  });
});

describe('runApprovalFlow', () => {
  it('borrows the editor slot, delivers the decision, and restores the editor', () => {
    const tui = fakeTui();
    const slot = new Container();
    const editor = { render: () => [''] } as unknown as Editor;
    slot.addChild(editor as unknown as Component);
    const onDecision = vi.fn();
    runApprovalFlow({ tui, slot, editor, question: q(), onDecision });
    // The dock replaced the editor and took focus.
    expect(slot.children).toHaveLength(1);
    expect(slot.children[0]).not.toBe(editor);
    (slot.children[0] as unknown as ApprovalDock).handleInput('1');
    expect(onDecision).toHaveBeenCalledWith('Allow once');
    // The editor is back and focused.
    expect(slot.children[0]).toBe(editor);
    expect((tui.setFocus as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe(editor);
  });
});
