import { describe, it, expect, vi, beforeEach } from 'vitest';

const launchChat = vi.fn(async () => {});
vi.mock('../../src/cli/chat/launch.js', () => ({ launchChat: (...args: unknown[]) => launchChat(...args as []) }));

const { run } = await import('../../src/cli/index.js');

const env = {} as NodeJS.ProcessEnv;
/** The options `elowen chat …` would hand the TUI launcher. */
const optionsFor = async (args: string[]): Promise<{ model?: string; session?: string; fresh?: boolean }> => {
  await run(['chat', ...args], env);
  return launchChat.mock.calls.at(-1)![2] as { model?: string; session?: string; fresh?: boolean };
};

// Launching the CLI used to silently resume whatever was last said in this directory, which made every
// launch a guess about intent. It now opens a blank conversation; the old thread is never lost, it is just
// asked for explicitly.
describe('elowen chat — which conversation a launch opens', () => {
  beforeEach(() => launchChat.mockClear());

  it('opens a FRESH conversation by default', async () => {
    expect(await optionsFor([])).toMatchObject({ fresh: true, session: undefined });
  });

  it('-c / --continue resumes this directory\'s last conversation instead', async () => {
    expect(await optionsFor(['-c'])).toMatchObject({ fresh: false });
    expect(await optionsFor(['--continue'])).toMatchObject({ fresh: false });
  });

  it('--session <id> reopens that exact conversation and does not mint a fresh one', async () => {
    expect(await optionsFor(['--session', 'brain-1-abc'])).toMatchObject({ fresh: false, session: 'brain-1-abc' });
  });

  it('--new still means fresh, even alongside --continue', async () => {
    expect(await optionsFor(['--new'])).toMatchObject({ fresh: true });
    expect(await optionsFor(['--new', '--continue'])).toMatchObject({ fresh: true });
  });

  it('carries --model through in every case', async () => {
    expect(await optionsFor(['--model', 'anthropic'])).toMatchObject({ model: 'anthropic', fresh: true });
    expect(await optionsFor(['-c', '--model', 'openai'])).toMatchObject({ model: 'openai', fresh: false });
  });
});
