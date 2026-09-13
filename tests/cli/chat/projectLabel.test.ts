import { describe, it, expect } from 'vitest';
import { projectStatusLabel } from '../../../src/cli/chat/projectLabel.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The project line the composer footer and the start screen share: the client's own cwd and branch —
 *  what `/cd` moves. */
describe('projectStatusLabel', () => {
  it('renders cwd and branch', () => {
    expect(strip(projectStatusLabel({ cwd: '~/elowen', branch: 'main' }))).toBe('~/elowen · main');
    expect(strip(projectStatusLabel({ cwd: '~/elowen', branch: '' }))).toBe('~/elowen');
  });
});
