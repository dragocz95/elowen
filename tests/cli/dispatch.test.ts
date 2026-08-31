import { describe, it, expect } from 'vitest';
import { needsDaemon } from '../../src/cli/index.js';

// Only commands that talk to the daemon may auto-spawn it. Help, lifecycle and unknown commands must not:
// a stray detached daemon would squat the port and starve the systemd service.
describe('cli/index.needsDaemon', () => {
  it('is true for daemon API commands', () => {
    for (const cmd of ['api', 'chat', 'login']) expect(needsDaemon(cmd)).toBe(true);
  });

  it('is false for help, lifecycle and unknown commands', () => {
    for (const cmd of ['--help', '-h', 'help', '--version', 'install', 'up', 'down', 'status', 'restart', 'update', 'wat', undefined]) {
      expect(needsDaemon(cmd)).toBe(false);
    }
  });
});
