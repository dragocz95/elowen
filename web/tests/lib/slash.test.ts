import { describe, it, expect } from 'vitest';
import { expandPromptCommand, expandSlashMessage } from '../../lib/slash';
import type { SlashCommandDef } from '../../lib/types';

const commands: SlashCommandDef[] = [
  { name: 'review', description: 'Review code', kind: 'prompt', prompt: 'Review the following: $ARGS' },
  { name: 'greet', description: 'Greet', kind: 'prompt', prompt: 'Say hi to $1 from $2' },
  { name: 'plain', description: 'No placeholders', kind: 'prompt', prompt: 'Run the standard checks.' },
  { name: 'status', description: 'Status', kind: 'info' },
];

describe('expandPromptCommand (mirror of the daemon expansion)', () => {
  it('substitutes $ARGS and positionals literally (no $-reinterpretation)', () => {
    expect(expandPromptCommand('Review: $ARGS', 'auth module')).toBe('Review: auth module');
    expect(expandPromptCommand('Hi $1 and $2', 'a b')).toBe('Hi a and b');
    expect(expandPromptCommand('X $1', '$& $$')).toBe('X $&'); // user args are inserted verbatim
    expect(expandPromptCommand('Missing $3', 'a')).toBe('Missing');
  });
  it('appends args as a trailing paragraph when the template has no placeholders', () => {
    expect(expandPromptCommand('Run the checks.', 'only unit')).toBe('Run the checks.\n\nonly unit');
    expect(expandPromptCommand('Run the checks.', '')).toBe('Run the checks.');
  });
});

describe('expandSlashMessage', () => {
  it('expands a prompt command with and without args', () => {
    expect(expandSlashMessage('/review auth', commands)).toBe('Review the following: auth');
    expect(expandSlashMessage('/plain', commands)).toBe('Run the standard checks.');
  });
  it('passes through built-ins, unknown slashes and plain text (null)', () => {
    expect(expandSlashMessage('/status', commands)).toBeNull();     // built-in — the caller's own path
    expect(expandSlashMessage('/nonexistent x', commands)).toBeNull();
    expect(expandSlashMessage('hello /review', commands)).toBeNull();
  });
});
