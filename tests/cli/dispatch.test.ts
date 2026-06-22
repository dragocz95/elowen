import { describe, it, expect } from 'vitest';
import { run } from '../../src/cli/index.js';
import type { OrcaClient } from '../../src/cli/client.js';

// The API-backed subcommands must keep working unchanged: `run` dispatches them against the client.
describe('cli/index.run (API subcommands unchanged)', () => {
  it('ls prints the task list from the client', async () => {
    const logs: string[] = [];
    const orig = console.log; console.log = (s) => logs.push(String(s));
    const client = { tasks: async () => [{ id: 't1' }] } as unknown as OrcaClient;
    try { await run(['ls'], client, {} as NodeJS.ProcessEnv); } finally { console.log = orig; }
    expect(logs.join('')).toContain('t1');
  });
});
