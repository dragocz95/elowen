import { describe, expect, it } from 'vitest';
import manifest from '../../plugins/subagent/elowen-plugin.json';

describe('subagent browser access contract', () => {
  it('keeps the Agents navigation admin-only like its management API', () => {
    expect(manifest.web.adminOnly).toBe(true);
  });
});
