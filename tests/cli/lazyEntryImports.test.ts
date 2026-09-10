import { describe, it, expect, vi, beforeEach } from 'vitest';

// The CLI entry is one module for every verb, but only `menu` and `chat`/`login` need the chat TUI. A
// static import of either evaluates their whole graph at load — including the chat application and with
// it `@earendil-works/pi-coding-agent` and its nested undici — so `elowen --version` and `elowen status`
// paid for a TUI they never open. These mocks record whether each module was reached at all; importing
// the entry must reach neither, and each branch must still reach its own.
const reached: string[] = [];

vi.mock('../../src/cli/menu.js', () => {
  reached.push('menu');
  return { menu: vi.fn() };
});
vi.mock('../../src/cli/chat/launch.js', () => {
  reached.push('chat/launch');
  return { launchChat: vi.fn(), interactiveLogin: vi.fn() };
});

beforeEach(() => { reached.length = 0; });

describe('cli/index entry imports', () => {
  it('leaves the launcher and the chat entry unloaded at module load', async () => {
    await import('../../src/cli/index.js');
    expect(reached).toEqual([]);
  });

  it('loads the chat entry only when the chat branch runs', async () => {
    const { run } = await import('../../src/cli/index.js');
    await run(['chat'], {} as NodeJS.ProcessEnv);
    expect(reached).toEqual(['chat/launch']);
  });

  it('loads the launcher only when the menu branch runs', async () => {
    const { main } = await import('../../src/cli/index.js');
    const argv = process.argv;
    try {
      process.argv = ['node', 'elowen', 'menu'];
      await main();
    } finally {
      process.argv = argv;
    }
    expect(reached).toEqual(['menu']);
  });
});
