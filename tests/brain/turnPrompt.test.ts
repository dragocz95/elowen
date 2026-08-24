import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { composeTurnPrompt } from '../../src/brain/session/turnPrompt.js';

describe('composeTurnPrompt', () => {
  it('puts stable context in front of the user and volatile reminders behind them', () => {
    const prompt = composeTurnPrompt({
      memory: 'MEM\n\n',
      hook: 'HOOK\n\n',
      permissions: 'PERM\n\n',
      beforeUser: 'BEFORE\n\n',
      text: 'what the user typed',
      afterUser: 'AFTER',
      sessionChanges: 'CHANGES',
      postCompaction: 'REORIENT',
      modeReminder: 'MODE',
      runningSubagents: 'CHILDREN',
    });

    // Everything ahead of the message is cacheable prefix; everything behind it flips turn to turn and
    // would invalidate that prefix if it were hoisted in front.
    expect(prompt).toBe(
      'MEM\n\nHOOK\n\nPERM\n\nBEFORE\n\nwhat the user typed'
      + '\n\nAFTER\n\nCHANGES\n\nREORIENT\n\nMODE\n\nCHILDREN',
    );
  });

  it('omits an absent block without leaving its separator behind', () => {
    expect(composeTurnPrompt({ text: 'bare' })).toBe('bare');
    expect(composeTurnPrompt({ memory: 'MEM\n\n', text: 'hi', postCompaction: 'R' }))
      .toBe('MEM\n\nhi\n\nR');
  });

  // A surface that carries fewer blocks must do it by passing fewer arguments, never by growing a second
  // concatenation: that is exactly how the channel path fell behind the owner chat, and the comment left
  // at the time said wiring a block only into the builder "would leave it working in the CLI and silently
  // doing nothing on every channel". A source check is the only thing that keeps that from recurring.
  it('is the only place either surface assembles a turn prompt', () => {
    for (const file of ['src/brain/channels.ts', 'src/brain/service/turnContextBuilder.ts']) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8');
      expect(source, `${file} must compose through the shared helper`).toContain('composeTurnPrompt(');
      // The historic shape: the user's text concatenated with a conditional block.
      expect(source, `${file} still hand-rolls a prompt`).not.toMatch(/\+ \(\w+ \? `\\n\\n\$\{\w+\}` : ''\)/);
    }
  });
});
