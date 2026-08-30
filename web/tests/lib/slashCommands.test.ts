import { describe, expect, it } from 'vitest';
import { parseSlashInvocation } from '../../lib/slashCommands';
import type { SlashCommandDef } from '../../lib/types';

const goal: SlashCommandDef = {
  name: 'goal', description: 'Persistent goal', kind: 'action', execution: 'session-control', argument: { kind: 'text' },
};

describe('web slash invocation parsing', () => {
  it('resolves names and arguments only from the daemon-published catalog', () => {
    expect(parseSlashInvocation('/goal Ship parity', [goal])).toEqual({ command: goal, argument: 'Ship parity' });
    expect(parseSlashInvocation('/goal Ship parity', [])).toBeNull();
  });

  it('preserves ordinary slash-prefixed text and plugin prompt commands', () => {
    const prompt: SlashCommandDef = { name: 'review', description: 'Review code', kind: 'prompt', execution: 'plugin-prompt', prompt: 'Review $ARGS' };
    expect(parseSlashInvocation('/var/www/project', [goal])).toBeNull();
    expect(parseSlashInvocation('/unknown text', [goal])).toBeNull();
    expect(parseSlashInvocation('/review auth', [prompt])).toEqual({ command: prompt, argument: 'auth' });
  });
});
