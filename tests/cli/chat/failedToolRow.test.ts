import { describe, expect, it, beforeAll } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { TurnRenderer } from '../../../src/cli/chat/turnRenderer.js';
import type { ChatTurn, ToolItem } from '../../../src/brain/transcript.js';

beforeAll(() => { initTheme(); });

const refusal = (path: string): ToolItem => ({
  name: 'Write', detail: path, id: `call-${path}`,
  output: {
    title: 'tool result', kind: 'result', tone: 'warning', status: 'needs attention',
    text: `Error: ${path} has not been read in this conversation. Read it first — editing a file you have `
      + 'not seen risks overwriting content you never reviewed.',
  },
});

const turnOf = (...items: ToolItem[]): ChatTurn => ({
  role: 'elowen', streaming: false, segments: [{ kind: 'tools', items }],
});

const render = (turn: ChatTurn, expandedTools: Set<string> = new Set()) =>
  new TurnRenderer(getMarkdownTheme()).render(turn, 0, 96, {
    showThoughts: true, thinkingSeconds: 0, expandedThoughts: new Set(), expandedTools,
  });
const text = (rows: { line: string }[]) => rows.map((row) => row.line).join('\n');
/** The rendered words, free of colour codes and of wherever the terminal happened to wrap them — so an
 *  assertion is about what the user reads, not about the column the sentence broke at. */
// eslint-disable-next-line no-control-regex
const words = (rows: { line: string }[]) => text(rows).replace(/\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();

// Four framed blocks all saying the same thing about four different files buried the actual work. A failed
// tool result is a headline; the paragraph explaining it belongs one click away.
describe('a failed tool result in the transcript', () => {
  it('takes one line, and says which file it was about', () => {
    const rows = render(turnOf(refusal('/docs/routes.md')));
    const body = text(rows);
    expect(rows.filter((row) => row.line.trim()).length).toBe(1);
    expect(body).toContain('Error');
    expect(body).toContain('/docs/routes.md');
    expect(body).not.toContain('needs attention'); // the row already says Error — the status is dead weight
    expect(body).not.toContain('risks overwriting'); // the explanation is behind the click
  });

  it('gives up the whole message when the user asks for it', () => {
    const rows = render(turnOf(refusal('/docs/routes.md')), new Set(['tool:call-/docs/routes.md']));
    expect(words(rows)).toContain('risks overwriting content you never reviewed');
  });

  it('says a repeated refusal once, with the count', () => {
    const rows = render(turnOf(refusal('/docs/routes.md'), refusal('/docs/pricing.md'), refusal('/docs/testing.md')));
    const lines = rows.map((row) => row.line).filter((line) => line.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('3× Error');
  });

  it('lists every file it refused once the folded row is opened', () => {
    const items = [refusal('/docs/routes.md'), refusal('/docs/pricing.md'), refusal('/docs/testing.md')];
    // The folded row is keyed on the run's newest item — the same key a click on it toggles.
    const body = text(render(turnOf(...items), new Set(['tool:call-/docs/testing.md'])));
    for (const path of ['/docs/routes.md', '/docs/pricing.md', '/docs/testing.md']) expect(body).toContain(path);
  });

  it('is clickable — the row carries the toggle the app hit-tests', () => {
    const rows = render(turnOf(refusal('/docs/routes.md')));
    const row = rows.find((r) => r.line.includes('Error'));
    expect(row?.kind).toBe('expandable');
    expect(row?.key).toBe('tool:call-/docs/routes.md');
  });

  // A successful result is content the user asked for, not a complaint they have already read.
  it('leaves a successful result rendering in full', () => {
    const ok: ToolItem = { name: 'Read', detail: 'a.ts', id: 'call-ok',
      output: { title: 'tool result', kind: 'result', tone: 'success', text: 'the file contents' } };
    expect(text(render(turnOf(ok)))).toContain('the file contents');
  });
});
