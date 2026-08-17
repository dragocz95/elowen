import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Lm = { onEvent: (e: Record<string, unknown>) => void };

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
