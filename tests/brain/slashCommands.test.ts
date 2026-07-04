import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS, commandsFor, findCommand } from '../../src/brain/slashCommands.js';

describe('slash command registry', () => {
  it('exposes the core commands', () => {
    for (const n of ['new', 'stop', 'status', 'compact', 'model', 'think', 'restart', 'help']) {
      expect(findCommand(n), n).toBeDefined();
    }
  });

  it('hides admin-only commands from non-operators', () => {
    const restart = findCommand('restart')!;
    expect(restart.adminOnly).toBe(true);
    expect(commandsFor('web', false).some((c) => c.name === 'restart')).toBe(false);
    expect(commandsFor('web', true).some((c) => c.name === 'restart')).toBe(true);
  });

  it('scopes the CLI conversation pickers to the CLI surface only', () => {
    for (const n of ['sessions', 'resume', 'delete', 'quit']) {
      expect(commandsFor('cli', true).some((c) => c.name === n), `cli ${n}`).toBe(true);
      expect(commandsFor('discord', true).some((c) => c.name === n), `discord ${n}`).toBe(false);
      expect(commandsFor('web', true).some((c) => c.name === n), `web ${n}`).toBe(false);
    }
  });

  it('publishes stop/status/compact to every surface', () => {
    for (const surface of ['cli', 'discord', 'web'] as const) {
      for (const n of ['stop', 'status', 'compact']) {
        expect(commandsFor(surface, true).some((c) => c.name === n), `${surface} ${n}`).toBe(true);
      }
    }
  });

  it('scopes /think to the CLI (the only surface that wires the reasoning picker)', () => {
    expect(commandsFor('cli', true).some((c) => c.name === 'think')).toBe(true);
    expect(commandsFor('web', true).some((c) => c.name === 'think')).toBe(false);
    expect(commandsFor('discord', true).some((c) => c.name === 'think')).toBe(false);
  });

  it('every command has a non-empty English description', () => {
    for (const c of SLASH_COMMANDS) expect(c.description.trim().length, c.name).toBeGreaterThan(0);
  });
});
