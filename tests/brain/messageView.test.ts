import { describe, it, expect } from 'vitest';
import { stripInlineReasoning, extractText, toolOutputView } from '../../src/brain/messageView.js';

describe('stripInlineReasoning', () => {
  it('leaves text without reasoning tags untouched', () => {
    expect(stripInlineReasoning('just a normal answer')).toBe('just a normal answer');
  });

  it('removes a complete <think>…</think> block, keeping the answer', () => {
    expect(stripInlineReasoning('<think>let me reason\nabout this</think>\n\nThe answer is 42.')).toBe('The answer is 42.');
    expect(stripInlineReasoning('<thinking>hmm</thinking>Hello')).toBe('Hello');
  });

  it('removes an unclosed trailing reasoning block (stream cut off before the answer)', () => {
    expect(stripInlineReasoning('<think>still reasoning and never closed')).toBe('');
  });

  it('drops reasoning that streamed before a lone closing tag', () => {
    expect(stripInlineReasoning('reasoning with no open tag</think>\n\nFinal answer.')).toBe('Final answer.');
  });

  it('handles multiple blocks and preserves interleaved answer text', () => {
    expect(stripInlineReasoning('<think>a</think>one<think>b</think>two')).toBe('onetwo');
  });
});

describe('extractText strips leaked reasoning', () => {
  it('sanitizes an array-content assistant message', () => {
    const msg = { content: [{ type: 'text', text: '<think>secret</think>visible' }] };
    expect(extractText(msg)).toBe('visible');
  });
  it('sanitizes a string-content message', () => {
    expect(extractText({ content: '<think>x</think>ok' })).toBe('ok');
  });
});

describe('toolOutputView', () => {
  it('shows isError tool results even when the text lacks error keywords', () => {
    const out = toolOutputView('plugin_call', {}, { isError: true, content: [{ type: 'text', text: 'Unauthorized' }] });
    expect(out).toMatchObject({ tone: 'warning', text: 'Unauthorized', status: 'needs attention' });
  });

  it('keeps only a compact tail of long command output', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = toolOutputView('run_command', { command: 'printf' }, { content: [{ type: 'text', text }], details: { exitCode: 0 } });
    expect(out?.text).toContain('6 earlier lines hidden');
    expect(out?.fullText).toContain('line 1');
    expect(out?.text).toContain('line 12');
    expect(out?.text).not.toContain('line 1\n');
  });

  it('always surfaces a shell command on the first line, even when it exited silently', () => {
    const out = toolOutputView('run_command', { command: 'mkdir -p build' }, { content: [{ type: 'text', text: '' }], details: { exitCode: 0 } });
    expect(out).toBeDefined();
    expect(out?.command).toBe('mkdir -p build');
    expect(out?.kind).toBe('console');
    expect(out?.status).toBe('exit 0');
  });

  it('marks a silent successful shell command as done when no exit code is reported', () => {
    const out = toolOutputView('bash', { command: 'cd /tmp' }, { content: [{ type: 'text', text: '' }] });
    expect(out?.command).toBe('cd /tmp');
    expect(out?.status).toBe('done');
  });

  it('still hides a non-console tool that produced no useful output', () => {
    const out = toolOutputView('read_file', { path: 'a.ts' }, { content: [{ type: 'text', text: '' }] });
    expect(out).toBeUndefined();
  });
});
