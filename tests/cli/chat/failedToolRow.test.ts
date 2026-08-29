import { describe, expect, it, beforeAll } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { TOOL_INDENT, TurnRenderer } from '../../../src/cli/chat/turnRenderer.js';
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

/** A schema validation failure, in the exact shape production produces it: the message OPENS with the
 *  cause and CLOSES with the arguments it received. Compaction keeps the last few lines — right for
 *  command output, wrong for a failure — so `text` is a fragment of raw JSON whose first key happens to
 *  be the `_reason` status note, while the sentence naming the cause sits just off the top. Copied from
 *  a real row: the operator read it as "the `_reason` argument broke the call". */
const validationFailure = (reason: string): ToolItem => ({
  name: 'Edit', detail: '/var/www/app/x.ts', id: `call-${reason}`,
  output: {
    title: 'tool result', kind: 'result', tone: 'warning', status: 'needs attention',
    text: `… 4 earlier lines hidden\n{\n  "_reason": "${reason}",\n  "path": "/var/www/app/x.ts",`,
    fullText: 'Validation failed for tool "Edit":\n  - oldText: must have required properties oldText, newText\n\n'
      + `Received arguments:\n{\n  "_reason": "${reason}",\n  "path": "/var/www/app/x.ts",\n  "old_string": "before"\n}`,
  },
});

const turnOf = (...items: ToolItem[]): ChatTurn => ({
  role: 'elowen', streaming: false, segments: [{ kind: 'tools', items }],
});

const render = (turn: ChatTurn, expandedTools: Set<string> = new Set()) =>
  new TurnRenderer(getMarkdownTheme()).render(turn, 0, 96, {
    showThoughts: true, thinkingSeconds: 0, composingMarkerReady: false, spinnerFrame: 0, expandedThoughts: new Set(), expandedTools,
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
    const errorRow = rows.find((row) => row.line.includes('Error'))!;
    // Aligned with the sibling tool rows it belongs to (TOOL_INDENT), not the shallower thought/prose gutter.
    expect(errorRow.line.startsWith(TOOL_INDENT)).toBe(true);
    // A collapsed error stacks like any tool row: only the single turn-closing blank follows it — no extra spacer.
    expect(rows.map((row) => row.line)).toEqual([errorRow.line, '']);
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

  // The headline must name the CAUSE. Reading it from the compacted preview showed the tail of the
  // message instead — a slice of the arguments — and sent the operator hunting the wrong argument.
  it('headlines a validation failure with its cause, not with the arguments it echoed back', () => {
    const rows = render(turnOf(validationFailure('Registruju nový token…')));
    const body = words(rows);
    expect(body).toContain('Validation failed');
    expect(body).toContain('oldText');
    expect(body).not.toContain('_reason');
    expect(body).not.toContain('earlier lines hidden');
  });

  it('keeps the cause visible for every member of a folded group of failures', () => {
    const items = [validationFailure('Srovnávám první snímek OLED…'), validationFailure('Registruju nový token…')];
    const collapsed = words(render(turnOf(...items)));
    expect(collapsed).toContain('2× Error');

    const expanded = words(render(turnOf(...items), new Set(['tool:call-Registruju nový token…'])));
    // Both rows say what actually went wrong; neither leads with the status note the model wrote.
    expect(expanded.match(/Validation failed/g)).toHaveLength(2);
    expect(expanded).not.toContain('_reason');
  });

  // A successful result is content the user asked for, not a complaint they have already read.
  it('leaves a successful result rendering in full', () => {
    const ok: ToolItem = { name: 'Read', detail: 'a.ts', id: 'call-ok',
      output: { title: 'tool result', kind: 'result', tone: 'success', text: 'the file contents' } };
    expect(text(render(turnOf(ok)))).toContain('the file contents');
  });
});
