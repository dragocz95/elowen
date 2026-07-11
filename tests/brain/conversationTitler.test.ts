import { describe, it, expect, vi } from 'vitest';
import { ConversationTitler } from '../../src/brain/conversationTitler.js';

function titlerWith(reply: string | Error | null) {
  const setTitleIfCurrent = vi.fn(() => true);
  const inference = reply === null
    ? () => null
    : () => ({ model: 'cheap', decide: vi.fn(async () => { if (reply instanceof Error) throw reply; return { text: reply }; }) });
  const titler = new ConversationTitler({ store: { setTitleIfCurrent } as never, inference: inference as never });
  return { titler, setTitleIfCurrent };
}

describe('ConversationTitler — names a new conversation from its first message', () => {
  it('sets a sanitized title (drops "Title:", wrapping quotes, trailing dot, extra lines)', async () => {
    const { titler, setTitleIfCurrent } = titlerWith('Title: "Brake pads for a Cadillac".\nsome rambling');
    await titler.run('sess-1', 'what are these brake pads for?', 'what are these brake pads for?');
    expect(setTitleIfCurrent).toHaveBeenCalledWith('sess-1', 'what are these brake pads for?', 'Brake pads for a Cadillac');
  });

  it('keeps a non-latin (e.g. Czech) title as-is', async () => {
    const { titler, setTitleIfCurrent } = titlerWith('Brzdové destičky Bosch');
    await titler.run('sess-2', 'na co jsou tyhle brzdové destičky?', 'na co jsou tyhle brzdové destičky?');
    expect(setTitleIfCurrent).toHaveBeenCalledWith('sess-2', 'na co jsou tyhle brzdové destičky?', 'Brzdové destičky Bosch');
  });

  it('no-ops when no titling model is configured (provisional title stays)', async () => {
    const { titler, setTitleIfCurrent } = titlerWith(null);
    await titler.run('sess-3', 'hello', 'hello');
    expect(setTitleIfCurrent).not.toHaveBeenCalled();
    expect(titler.configured()).toBe(false);
  });

  it('no-ops on an empty first message', async () => {
    const { titler, setTitleIfCurrent } = titlerWith('Whatever');
    await titler.run('sess-4', '   ', '');
    expect(setTitleIfCurrent).not.toHaveBeenCalled();
  });

  it('swallows a relay error (best-effort, never throws into the turn)', async () => {
    const { titler, setTitleIfCurrent } = titlerWith(new Error('relay down'));
    await expect(titler.run('sess-5', 'hi there', 'hi there')).resolves.toBeUndefined();
    expect(setTitleIfCurrent).not.toHaveBeenCalled();
  });

  it('never sets an empty title when the model returns only decorations', async () => {
    const { titler, setTitleIfCurrent } = titlerWith('""');
    await titler.run('sess-6', 'hi', 'hi');
    expect(setTitleIfCurrent).not.toHaveBeenCalled();
  });

  it('does not overwrite a manual rename that landed while inference was running', async () => {
    let current = 'provisional';
    let release!: (value: { text: string }) => void;
    const decide = vi.fn(() => new Promise<{ text: string }>((resolve) => { release = resolve; }));
    const setTitleIfCurrent = vi.fn((_id: string, expected: string, title: string) => {
      if (current !== expected) return false;
      current = title;
      return true;
    });
    const titler = new ConversationTitler({
      store: { setTitleIfCurrent } as never,
      inference: (() => ({ model: 'cheap', decide })) as never,
    });

    const pending = titler.run('sess-7', 'opening message', 'provisional');
    current = 'My manual title';
    release({ text: 'Generated title' });
    await pending;

    expect(current).toBe('My manual title');
    expect(setTitleIfCurrent).toHaveBeenCalledWith('sess-7', 'provisional', 'Generated title');
  });
});
