import { describe, expect, it } from 'vitest';
import { TelemetryPanel } from '../../../src/cli/chat/telemetryPanel.js';
import { chatTheme, color, paintRow } from '../../../src/cli/chat/theme.js';

/** Read a painted row the way a terminal does: walk it, keep the SGR background state, and report the
 *  background each printed character actually lands on. `null` = the terminal's own default (black). */
function backgroundsOf(row: string): (string | null)[] {
  const backgrounds: (string | null)[] = [];
  let current: string | null = null;
  // eslint-disable-next-line no-control-regex
  const sgr = /\x1b\[([0-9;]*)m/y;
  for (let i = 0; i < row.length;) {
    sgr.lastIndex = i;
    const match = sgr.exec(row);
    if (match) {
      const params = (match[1] === '' ? '0' : match[1]).split(';');
      for (let p = 0; p < params.length; p++) {
        const code = params[p];
        if (code === '0' || code === '49') current = null;
        else if (code === '48') { current = params.slice(p, p + 5).join(';'); p += 4; }
      }
      i = sgr.lastIndex;
      continue;
    }
    backgrounds.push(current);
    i += 1;
  }
  return backgrounds;
}

const state = {
  usage: { tokens: 1200, contextWindow: 200_000, percent: 12, cost: 0.4 },
  cwd: '/home/user/project', branch: 'main',
  mcp: [{ name: 'chrome-devtools', status: 'connected' as const }],
  lspEnabled: true,
  processes: [], subagents: [], rateLimits: null, goal: null, floatOffset: 0,
};

// SGR has no stack: a reset inside a row wipes the background the row was painted with, so everything
// after it — the padding, the gap between two coloured words — fell through to the terminal's default.
// That is what put a black patch beside the flame and black stripes under the rail's headings.
describe('a painted row', () => {
  it('keeps its background under text that resets its own colour', () => {
    const row = paintRow(chatTheme().panelBg, `  ${color.bold(color.text('Context'))}`, 36);
    const backgrounds = backgroundsOf(row);
    expect(backgrounds).toHaveLength(36); // the row is painted edge to edge…
    expect(backgrounds.every((bg) => bg !== null)).toBe(true); // …and no cell falls back to the terminal's
  });

  it('keeps its background under art that carries a background of its own', () => {
    const cell = '\x1b[38;2;255;82;54m\x1b[48;2;120;20;10m▀\x1b[0m'; // one mascot half-block
    const backgrounds = backgroundsOf(paintRow(chatTheme().panelBg, `  ${cell}  `, 20));
    expect(backgrounds.filter((bg) => bg === null)).toHaveLength(0);
    expect(backgrounds[2]).toBe('48;2;120;20;10'); // the art keeps its own colour where it draws
  });
});

describe('the telemetry rail', () => {
  it('paints every row edge to edge, mascot and headings included', () => {
    const panel = new TelemetryPanel(() => state);
    const rows = panel.render(36);
    expect(rows.length).toBeGreaterThan(10);
    for (const [index, row] of rows.entries()) {
      const backgrounds = backgroundsOf(row);
      expect(backgrounds, `row ${index}`).toHaveLength(36);
      expect(backgrounds.filter((bg) => bg === null), `row ${index}: cells on the terminal's own background`).toHaveLength(0);
    }
  });
});
