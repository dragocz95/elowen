import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { first } from '../../first.js';

/** A diff in the transcript reads like the diff in the terminal client: the row carries its add/delete
 *  tint, the line number and the sign sit in their own gutter, and the SOURCE is syntax-coloured in the
 *  grammar of the file the edit touched. The two rules that are easy to lose are that a removed row is
 *  never highlighted (a dark token on the red ground is unreadable) and that the gutter never becomes
 *  part of the text — a reader copying a diff wants the code, not a column of numbers. */

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderDiff(detail: string, diff: string): Promise<void> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="compact" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  const es = first(FakeES.instances, 'EventSource');
  act(() => {
    es.emit({ type: 'tool', name: 'Edit', id: 'e1', detail });
    es.emit({ type: 'diff', id: 'e1', diff });
  });
  await screen.findByTestId('chat-diff');
}

const rows = (): HTMLElement[] => Array.from(screen.getByTestId('chat-diff').querySelectorAll<HTMLElement>('[data-diff-sign]'));
const codeCells = (): HTMLElement[] => screen.getAllByTestId('chat-diff-code');
const classesOf = (cell: HTMLElement): string[] =>
  Array.from(cell.querySelectorAll('span')).map((span) => span.className);

const TS_DIFF = [
  '    11 export function total(items: Item[]) {',
  '-   12   return items.length; // old',
  '+   12   const sum = items.reduce((a, b) => a + b.price, 0);',
  '+   13   return sum;',
].join('\n');

describe('a diff in the transcript', () => {
  it('tints the row by its sign and keeps sign and line number out of the source', async () => {
    await renderDiff('src/total.ts (+2 -1)', TS_DIFF);

    expect(rows().map((row) => row.dataset['diffSign'])).toEqual([' ', '-', '+', '+']);
    const [context, removed, added] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(added.className).toContain('bg-diff-add');
    expect(removed.className).toContain('bg-diff-del');
    expect(context.className).not.toContain('bg-diff');

    // The source cell holds the source and nothing else — the gutter columns are aria-hidden siblings.
    expect(codeCells().map((cell) => cell.textContent)).toEqual([
      'export function total(items: Item[]) {',
      '  return items.length; // old',
      '  const sum = items.reduce((a, b) => a + b.price, 0);',
      '  return sum;',
    ]);
    const gutters = Array.from(added.querySelectorAll('[aria-hidden="true"]')).map((n) => n.textContent);
    expect(gutters).toEqual(['12', '+']);
  });

  it('says in words what the marker column says in colour', async () => {
    await renderDiff('src/total.ts (+2 -1)', TS_DIFF);
    // The gutter is aria-hidden, so a screen reader would otherwise hear three identical rows: the
    // sign used to be part of the row's text and has to stay part of what is announced.
    const [context, removed, added] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(added.querySelector('.sr-only')?.textContent).toBe('added line');
    expect(removed.querySelector('.sr-only')?.textContent).toBe('removed line');
    expect(context.querySelector('.sr-only')).toBeNull();
  });

  it('syntax-colours added and context rows in the language of the edited file', async () => {
    await renderDiff('src/total.ts (+2 -1)', TS_DIFF);
    const [contextCell, , addedCell] = codeCells() as [HTMLElement, HTMLElement, HTMLElement];

    expect(classesOf(contextCell)).toContain('text-code-keyword'); // `export`
    expect(classesOf(addedCell)).toContain('text-code-keyword'); // `const`
    expect(classesOf(addedCell)).toContain('text-code-number'); // `0`
  });

  it('never highlights a removed row', async () => {
    await renderDiff('src/total.ts (+2 -1)', TS_DIFF);
    const removedCell = codeCells()[1]!;

    // Plain off-white on the red ground, as one text node: no syntax spans at all.
    expect(classesOf(removedCell)).toEqual([]);
    expect(removedCell.className).toContain('text-diff-del-foreground');
  });

  it('picks the grammar from the edited file, not from the transcript', async () => {
    await renderDiff('web/app/styles/tokens.css', '+   4   --color-diff-add: #005f00;');
    expect(classesOf(codeCells()[0]!)).toContain('text-code-number'); // the hex colour
  });

  it('renders plain when the extension names no grammar', async () => {
    await renderDiff('notes.unknownext', '+   4 const x = 1;');
    // One plain token, exactly like the CLI's fallback when it has no grammar for a file.
    expect(classesOf(codeCells()[0]!)).toEqual(['text-code-plain']);
  });
});
