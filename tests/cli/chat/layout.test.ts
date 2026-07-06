import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { beginAssistant, emptyView, pushUser, reduce } from '../../../src/brain/transcript.js';
import { ChatViewport, mouseWheel, SlashOverlay, TelemetryPanel } from '../../../src/cli/chat/layout.js';

describe('chat layout components', () => {
  beforeAll(() => { initTheme(); });

  it('parses SGR mouse wheel events', () => {
    expect(mouseWheel('\x1b[<64;10;10M')).toBe(3);
    expect(mouseWheel('\x1b[<65;10;10M')).toBe(-3);
    expect(mouseWheel('\x1b[<0;10;10M')).toBe(0);
  });

  it('renders a scrollable chat viewport with a history chip', () => {
    let view = emptyView();
    for (let i = 0; i < 8; i++) {
      view = pushUser(view, `message ${i}`);
      view = reduce(beginAssistant(view), { type: 'text', delta: `answer ${i}` });
      view = reduce(view, { type: 'idle' });
    }
    const viewport = new ChatViewport(
      { view, notice: '', modelName: 'kimi', thinkingSeconds: 0 },
      getMarkdownTheme(),
      () => 6,
      () => 1,
      () => 60,
    );
    const bottom = viewport.render(60);
    expect(bottom).toHaveLength(8);
    expect(bottom.every((line) => visibleWidth(line) === 60)).toBe(true);
    viewport.scroll(3);
    expect(viewport.render(60).join('\n')).toContain('History');
  });

  it('renders slash overlay rows to the full requested width', () => {
    const tui = { requestRender: vi.fn() };
    const overlay = new SlashOverlay(
      tui as never,
      [{ value: '/theme', label: '/theme', description: 'Switch theme' }],
      vi.fn(),
      vi.fn(),
    );
    const rows = overlay.render(48);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((line) => visibleWidth(line) === 48)).toBe(true);
  });

  it('renders telemetry panel with model and theme', () => {
    const panel = new TelemetryPanel(() => ({
      modelName: 'kimi',
      sessionTitle: 'Build CLI',
      usage: { tokens: 10, contextWindow: 100, percent: 10, totalTokens: 20, cost: 0 },
      thinkingLevel: 'low',
      thinkingLevels: ['low', 'high'],
      running: true,
      cards: [],
      themeLabel: 'Orca cyan',
    }));
    const rows = panel.render(36);
    expect(rows.every((line) => visibleWidth(line) === 36)).toBe(true);
    expect(rows.join('\n')).toContain('kimi');
    expect(rows.join('\n')).toContain('Orca cyan');
  });
});
