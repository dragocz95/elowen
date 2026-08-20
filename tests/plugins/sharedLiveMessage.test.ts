import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Lm = {
  onEvent: (e: Record<string, unknown>) => void;
  finalize: (reply?: string) => Promise<void>;
  fail: (message: string) => Promise<boolean>;
};

/** The trace-line separator the shared engine joins tool rows with. Every surface so far treats a bare
 *  "\n" as a line break; Microsoft Teams renders a bot message as markdown, where a single newline is a
 *  soft wrap, so its whole tool trace arrived as one run-on paragraph. `style.lineBreak` lets that
 *  surface ask for "\n\n" without every other one changing. */
describe('shared LiveMessage trace separator', () => {
  const load = async () => (await import(join(repoRoot, 'packages/plugin-shared/liveMessage.mjs'))) as {
    createLiveMessage: (deps: Record<string, unknown>) => new (adapter: unknown, channelId: string) => Lm;
  };

  const style = {
    mentionSafe: (s: string) => s,
    fenceSafe: (s: string) => s,
    bold: (s: string) => `**${s}**`,
    strike: (s: string) => `~~${s}~~`,
    italic: (s: string) => `_${s}_`,
    subtext: (s: string) => s,
    summaryLine: (s: string) => `  ↳ ${s}`,
  };

  /** Records whatever the progress bubble last rendered. */
  async function render(lineBreak?: string) {
    const { createLiveMessage } = await load();
    let content = '';
    const transport = {
      create: async (_a: unknown, _c: string, text: string) => { content = text; return 'mid-1'; },
      edit: async (_a: unknown, _c: string, _id: string, text: string) => { content = text; return true; },
      remove: async () => {},
      replyRef: (replyToId: string) => ({ replyToId }),
      hasImages: () => false,
      postImages: async () => {},
    };
    const LiveMessage = createLiveMessage({
      transport,
      style: lineBreak === undefined ? style : { ...style, lineBreak },
      CHUNK: 4000,
      splitContent: (t: string) => [t],
      postWithImages: async () => {},
      footerLine: () => '',
    });
    const lm = new LiveMessage({ cfg: { runtimeFooter: false } }, 'chan-1');
    lm.onEvent({ type: 'tool', id: 'a', name: 'Skill', detail: 'skills', icon: '📚' });
    lm.onEvent({ type: 'tool', id: 'b', name: 'CronAdd', detail: 'every minute', icon: '⏰' });
    await new Promise((r) => setTimeout(r, 20));
    return content;
  }

  it('joins tool rows with a bare newline by default', async () => {
    const content = await render();
    expect(content).toContain('Skill');
    expect(content).toContain('CronAdd');
    expect(content).not.toContain('\n\n');
  });

  it('honours a surface that needs a blank line between rows', async () => {
    const content = await render('\n\n');
    expect(content).toContain('Skill');
    expect(content).toContain('CronAdd');
    // Two rows that share a line are exactly the Teams bug: each must stand on its own.
    expect(content.split('\n\n').length).toBeGreaterThan(1);
    expect(content.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(1);
  });
});

/** How a display card (the todo checklist) is set apart from the tool trace. A surface with real block
 *  quoting renders the card as a quoted block and needs no drawn divider; a plain-text surface such as
 *  Telegram, where `> ` would be shown literally, keeps the divider. */
describe('shared LiveMessage card separation', () => {
  const load = async () => (await import(join(repoRoot, 'packages/plugin-shared/liveMessage.mjs'))) as {
    createLiveMessage: (deps: Record<string, unknown>) => new (adapter: unknown, channelId: string) => Lm;
  };

  const style = {
    mentionSafe: (s: string) => s,
    fenceSafe: (s: string) => s,
    bold: (s: string) => `**${s}**`,
    strike: (s: string) => `~~${s}~~`,
    italic: (s: string) => `_${s}_`,
    subtext: (s: string) => `-# ${s}`,
    summaryLine: (s: string) => `  ↳ ${s}`,
  };

  async function render(opts: { quoteBlock?: (lines: string[]) => string; lineBreak?: string; items?: Array<{ text: string; status: string }> } = {}) {
    const { createLiveMessage } = await load();
    let content = '';
    const transport = {
      create: async (_a: unknown, _c: string, text: string) => { content = text; return 'mid-1'; },
      edit: async (_a: unknown, _c: string, _id: string, text: string) => { content = text; return true; },
      remove: async () => {},
      replyRef: (replyToId: string) => ({ replyToId }),
      hasImages: () => false,
      postImages: async () => {},
    };
    const LiveMessage = createLiveMessage({
      transport,
      style: {
        ...style,
        ...(opts.quoteBlock ? { quoteBlock: opts.quoteBlock } : {}),
        ...(opts.lineBreak ? { lineBreak: opts.lineBreak } : {}),
      },
      CHUNK: 4000,
      splitContent: (t: string) => [t],
      postWithImages: async () => {},
      footerLine: () => '',
    });
    const lm = new LiveMessage({ cfg: { runtimeFooter: false } }, 'chan-1');
    lm.onEvent({ type: 'tool', id: 'a', name: 'TodoWrite', detail: '', icon: '📋' });
    lm.onEvent({
      type: 'card',
      card: {
        id: 'todos',
        title: 'Todos',
        items: opts.items ?? [{ text: 'find records', status: 'in_progress' }, { text: 'link bookings', status: 'pending' }],
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    return content;
  }

  it('falls back to the drawn divider when the surface cannot quote', async () => {
    const content = await render();
    expect(content).toContain('┈┈┈');
    expect(content).toContain('📋 **Todos** (0/2)');
    expect(content).not.toContain('> ');
  });

  it('quotes the checklist and drops the divider when the surface can quote', async () => {
    const content = await render({ quoteBlock: (lines) => lines.map((l) => `> ${l}`).join('\n') });
    expect(content).not.toContain('┈┈┈');
    // Every card line is quoted — a half-quoted block would break the panel look mid-list.
    expect(content).toContain('> 📋 **Todos** (0/2)');
    expect(content).toContain('> 🔸 find records');
    expect(content).toContain('> ⬜ link bookings');
    // The tool trace itself stays unquoted: only the card becomes a block.
    expect(content).toMatch(/^📋 `TodoWrite`/m);
    expect(content).not.toContain('> 📋 `TodoWrite`');
  });

  /** The hook takes the whole block precisely so a surface can wrap it ONCE. Teams separates trace rows
   *  with a blank line, and a per-line quote there would draw one full-width frame per checklist item. */
  it('lets a surface wrap the whole card in a single quote, not one per line', async () => {
    const content = await render({
      lineBreak: '\n\n',
      quoteBlock: (lines) => `<blockquote>${lines.join('<br>')}</blockquote>`,
    });
    expect(content.match(/<blockquote>/g)).toHaveLength(1);
    expect(content).toContain('📋 **Todos** (0/2)<br>🔸 find records<br>⬜ link bookings');
    expect(content).not.toContain('┈┈┈');
  });

  it('removes an emptied card instead of leaving an empty quoted block', async () => {
    const content = await render({ quoteBlock: (lines) => lines.map((l) => `> ${l}`).join('\n'), items: [] });
    expect(content).toContain('TodoWrite');
    expect(content).not.toContain('>');
  });
});

/** Tool activity may be ephemeral, but the final answer must land before its progress messages disappear. */
describe('shared LiveMessage tool activity cleanup', () => {
  const style = {
    mentionSafe: (s: string) => s,
    fenceSafe: (s: string) => s,
    bold: (s: string) => s,
    strike: (s: string) => s,
    italic: (s: string) => s,
    subtext: (s: string) => s,
    summaryLine: (s: string) => s,
  };

  async function run(
    cfg: Record<string, unknown>,
    mode: 'finalize' | 'fail' = 'finalize',
    editFails = false,
    collapseStillOrdered?: () => boolean,
    askMidTurn = false,
  ) {
    const { createLiveMessage } = await import(join(repoRoot, 'packages/plugin-shared/liveMessage.mjs')) as {
      createLiveMessage: (deps: Record<string, unknown>) => new (
        adapter: unknown,
        channelId: string,
        replyToId?: string,
        askerId?: string,
        display?: unknown,
        options?: { collapseStillOrdered?: () => boolean },
      ) => Lm;
    };
    const events: string[] = [];
    let nextId = 0;
    const transport = {
      create: async (_a: unknown, _channel: string, _content: string, extra: { replyToId?: string }) => {
        const id = `progress-${++nextId}`;
        events.push(`create:${id}:${extra.replyToId ?? 'plain'}`);
        return id;
      },
      edit: async (_a: unknown, _channel: string, _id: string, content: string) => { events.push(`edit:${content}`); return !editFails; },
      remove: async (_a: unknown, _channel: string, id: string) => { events.push(`remove:${id}`); },
      replyRef: (replyToId: string) => ({ replyToId }),
      hasImages: () => false,
      postImages: async () => {},
    };
    const LiveMessage = createLiveMessage({
      transport,
      style,
      CHUNK: 4000,
      splitContent: (text: string) => [text],
      postWithImages: async (_a: unknown, _channel: string, _content: string, replyToId?: string) => {
        events.push(`answer:${replyToId ?? 'plain'}`);
      },
      footerLine: () => '',
    });
    const lm = new LiveMessage(
      {
        cfg: { runtimeFooter: false, ...cfg },
        postAsk: async () => { events.push('ask-card'); },
      },
      'channel',
      'trigger',
      undefined,
      undefined,
      { collapseStillOrdered },
    );
    lm.onEvent({ type: 'tool', id: 'one', name: 'Read' });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the live progress create land before finalize
    lm.onEvent({ type: 'tool', id: 'two', name: 'Bash' });
    if (askMidTurn) {
      lm.onEvent({ type: 'ask', id: 'q1', questions: [{ question: 'Which one?' }] });
      await new Promise((resolve) => setTimeout(resolve, 0)); // postAsk is fire-and-forget
    }
    if (mode === 'fail') events.push(`handled:${await lm.fail('boom')}`);
    else await lm.finalize('Done.');
    return events;
  }

  it('keeps tool progress and posts a separate answer by default', async () => {
    expect(await run({})).toEqual(['create:progress-1:plain', 'edit:🔧 `Read`\n🔧 `Bash`', 'answer:trigger']);
  });

  it('replaces the replied progress message with the final answer without deleting it', async () => {
    expect(await run({ deleteToolActivityAfterTurn: true })).toEqual([
      'create:progress-1:trigger',
      'edit:Done.',
    ]);
  });

  it('posts a new anchored final reply when a newer user message made the progress bubble stale', async () => {
    expect(await run({ deleteToolActivityAfterTurn: true }, 'finalize', false, () => false)).toEqual([
      'create:progress-1:trigger',
      'edit:🔧 `Read`\n🔧 `Bash`',
      'answer:trigger',
    ]);
  });

  it('posts a new anchored error when a newer user message made the progress bubble stale', async () => {
    expect(await run({ deleteToolActivityAfterTurn: true }, 'fail', false, () => false)).toEqual([
      'create:progress-1:trigger',
      'edit:🔧 `Read` — boom\n🔧 `Bash` — boom',
      'handled:false',
    ]);
  });

  // The turn's OWN AskUserQuestion card is posted as a new message below the progress bubble, so by the
  // time the answer is ready the bubble is no longer the last thing in the chat. Overwriting it would put
  // the reply above the question the user just answered — the same wrong order a newer user message causes,
  // except no inbound message ever arrives to move the order marker (a card answer is a component
  // interaction, not a chat message).
  it('keeps the progress bubble when its own question card landed below it', async () => {
    expect(await run({ deleteToolActivityAfterTurn: true }, 'finalize', false, () => true, true)).toEqual([
      'create:progress-1:trigger',
      'ask-card',
      'edit:🔧 `Read`\n🔧 `Bash`',
      'answer:trigger',
    ]);
  });

  it('posts a new anchored error under its own question card too', async () => {
    expect(await run({ deleteToolActivityAfterTurn: true }, 'fail', false, () => true, true)).toEqual([
      'create:progress-1:trigger',
      'ask-card',
      'edit:🔧 `Read` — boom\n🔧 `Bash` — boom',
      'handled:false',
    ]);
  });

  it('does not evaluate collapse ordering outside the collapse mode', async () => {
    let checks = 0;
    expect(await run({}, 'finalize', false, () => { checks++; return false; })).toEqual([
      'create:progress-1:plain',
      'edit:🔧 `Read`\n🔧 `Bash`',
      'answer:trigger',
    ]);
    expect(checks).toBe(0);
  });

  it('normalizes per-tool/live settings to one collapsible bubble and handles failures in place', async () => {
    const cfg = { deleteToolActivityAfterTurn: true, toolMessageMode: 'per_tool', answerMode: 'live' };
    expect(await run(cfg)).toEqual(['create:progress-1:trigger', 'edit:Done.']);
    expect(await run(cfg, 'fail')).toEqual(['create:progress-1:trigger', 'edit:boom', 'handled:true']);
  });

  it('posts a fallback answer when replacing the progress activity fails twice', async () => {
    expect(await run({ deleteToolActivityAfterTurn: true }, 'finalize', true)).toEqual([
      'create:progress-1:trigger',
      'edit:Done.',
      'edit:Done.',
      'answer:trigger',
    ]);
  });

  it('does not duplicate delivered leading chunks when a continuation cannot be created', async () => {
    const { createLiveMessage } = await import(join(repoRoot, 'packages/plugin-shared/liveMessage.mjs')) as {
      createLiveMessage: (deps: Record<string, unknown>) => new (adapter: unknown, channelId: string, replyToId?: string) => Lm;
    };
    const events: string[] = [];
    let creates = 0;
    const LiveMessage = createLiveMessage({
      transport: {
        create: async () => { creates++; events.push(`create:${creates}`); return creates === 1 ? 'progress' : null; },
        edit: async (_a: unknown, _c: string, _id: string, content: string) => { events.push(`edit:${content}`); return true; },
        remove: async () => {},
        replyRef: () => ({}),
        hasImages: () => false,
        postImages: async () => {},
      },
      style,
      CHUNK: 10,
      splitContent: (text: string) => text === 'FirstSecond' ? ['First', 'Second'] : [text],
      postWithImages: async (_a: unknown, _c: string, text: string) => { events.push(`fallback:${text}`); },
      footerLine: () => '',
    });
    const lm = new LiveMessage({ cfg: { runtimeFooter: false, deleteToolActivityAfterTurn: true } }, 'channel', 'trigger');
    lm.onEvent({ type: 'tool', id: 'one', name: 'Read' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await lm.finalize('FirstSecond');

    expect(events).toEqual(['create:1', 'edit:First', 'create:2', 'create:3', 'fallback:Second']);
  });
});

describe('conversation order tracker', () => {
  it('invalidates an older marker when another visible user message arrives', async () => {
    const { createConversationOrderTracker } = await import(join(repoRoot, 'packages/plugin-shared/liveMessage.mjs')) as {
      createConversationOrderTracker: () => {
        mark: (key: string) => { key: string; sequence: number };
        isCurrent: (marker: { key: string; sequence: number }) => boolean;
      };
    };
    const tracker = createConversationOrderTracker();
    const first = tracker.mark('channel');
    expect(tracker.isCurrent(first)).toBe(true);
    const second = tracker.mark('channel');
    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
  });

  it('fails closed for expired and LRU-evicted markers', async () => {
    const { createConversationOrderTracker } = await import(join(repoRoot, 'packages/plugin-shared/liveMessage.mjs')) as {
      createConversationOrderTracker: (options: { maxEntries: number; ttlMs: number; now: () => number }) => {
        mark: (key: string) => { key: string; sequence: number };
        isCurrent: (marker: { key: string; sequence: number }) => boolean;
      };
    };
    let time = 0;
    const tracker = createConversationOrderTracker({ maxEntries: 1, ttlMs: 10, now: () => time });
    const evicted = tracker.mark('one');
    const current = tracker.mark('two');
    expect(tracker.isCurrent(evicted)).toBe(false);
    expect(tracker.isCurrent(current)).toBe(true);
    time = 11;
    expect(tracker.isCurrent(current)).toBe(false);
  });
});
