import { describe, it, expect } from 'vitest';
import { projectStatusLabel } from '../../../src/cli/chat/projectLabel.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The project line the composer footer and the start screen share: the client's own cwd and branch,
 *  and — only when the daemon says the conversation is bound to a Sandbox workspace — a `[S] <label>`
 *  marker, because the shell then runs in that worktree's container and not where the client sits. */
describe('projectStatusLabel', () => {
  it('renders cwd and branch as before when no workspace is bound', () => {
    expect(strip(projectStatusLabel({ cwd: '~/elowen', branch: 'main', workspace: null }))).toBe('~/elowen · main');
    expect(strip(projectStatusLabel({ cwd: '~/elowen', branch: '', workspace: null }))).toBe('~/elowen');
  });

  it('appends the Sandbox marker with the workspace label when the conversation is confined', () => {
    const line = projectStatusLabel({
      cwd: '~/elowen', branch: 'main',
      workspace: { workspaceId: 'ws_1', label: 'lease-fixes', branch: 'elowen/u1/lease-fixes', path: '/data/ws/lease-fixes', confined: true },
    });
    expect(strip(line)).toBe('~/elowen · main · [S] lease-fixes');
  });
});
