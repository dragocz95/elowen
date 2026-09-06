import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { first } from '../../first.js';

/** A long edit's diff is previewed and the rest folds behind the shared expander, rather than being cut
 *  off with no way back: the transcript is the only place the change is shown, so the reader checking what
 *  was edited has to be able to reach all of it — without the block swallowing the screen when they do. */

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

/** 80 rows, each individually identifiable — the preview shows 60, so 20 stay folded. A row is queried by
 *  its SOURCE text: the sign and the line number are rendered as their own gutter columns. */
const TOTAL_ROWS = 80;
const PREVIEW_ROWS = 60;
const LONG_DIFF = Array.from({ length: TOTAL_ROWS }, (_, i) => `+ ${i + 1} line ${i + 1} of the edit`).join('\n');

async function renderWithDiff(diff: string): Promise<void> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="compact" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  const es = first(FakeES.instances, 'EventSource');
  act(() => {
    es.emit({ type: 'tool', name: 'Edit', id: 'e1', detail: 'a.ts' });
    es.emit({ type: 'diff', id: 'e1', diff });
  });
  await screen.findByTestId('chat-diff');
}

const expander = (): HTMLElement => screen.getByRole('button', { name: /lines of the diff/ });
/** The source column of every rendered row. A row's text is split into syntax spans, so it is read off
 *  the code cell rather than queried as one string. */
const sources = (): string[] => screen.getAllByTestId('chat-diff-code').map((cell) => cell.textContent ?? '');

describe('a long diff in the transcript', () => {
  it('previews the first rows and folds the rest behind the expander', async () => {
    await renderWithDiff(LONG_DIFF);

    expect(sources()).toContain(`line ${PREVIEW_ROWS} of the edit`);
    expect(sources()).not.toContain(`line ${TOTAL_ROWS} of the edit`);
    expect(expander()).toHaveTextContent(`+${TOTAL_ROWS - PREVIEW_ROWS} more`);
  });

  it('shows every remaining row once expanded, and folds them away again', async () => {
    await renderWithDiff(LONG_DIFF);

    fireEvent.click(expander());
    expect(sources()).toContain(`line ${TOTAL_ROWS} of the edit`);
    // Bounded rather than unbounded: the whole edit is reachable, but by scrolling the block, not the page.
    expect(screen.getByTestId('chat-diff').className).toContain('overflow-y-auto');

    fireEvent.click(expander());
    expect(sources()).not.toContain(`line ${TOTAL_ROWS} of the edit`);
  });

  it('announces the toggle and the region it controls', async () => {
    await renderWithDiff(LONG_DIFF);
    const button = expander();
    const body = screen.getByTestId('chat-diff');

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', body.id);
    expect(body.id).toBeTruthy();

    fireEvent.click(button);
    expect(expander()).toHaveAttribute('aria-expanded', 'true');
    // Expanded it scrolls, and a scrollable region has to be reachable with the keyboard alone.
    expect(screen.getByTestId('chat-diff')).toHaveAttribute('tabindex', '0');
  });

  it('leaves a diff that fits without an expander at all', async () => {
    await renderWithDiff('+ 1 only line');

    expect(sources()).toEqual(['only line']);
    expect(screen.queryByRole('button', { name: /lines of the diff/ })).toBeNull();
  });
});
