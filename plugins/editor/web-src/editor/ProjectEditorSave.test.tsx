import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { ComponentType, ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { createWrapper } from '../../../../web/tests/test-utils';
import { ToastProvider } from '../../../../web/components/ui/Toast';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// Monaco is browser-only — stub it with a textarea and capture the Cmd+S command the editor
// registers via `onMount`, so a test can save exactly the way a keyboard user does (the toolbar
// Save button is disabled while a write is pending; Cmd+S is not).
const monaco = vi.hoisted(() => ({ save: (() => {}) as () => void }));
vi.mock('./monacoLoader', () => ({
  MonacoEditor: ({ value, onChange, onMount }: {
    value: string;
    onChange: (v: string | undefined) => void;
    onMount: (editor: { addCommand: (key: number, cb: () => void) => void }, m: { KeyMod: { CtrlCmd: number }; KeyCode: { KeyS: number } }) => void;
  }) => {
    onMount({ addCommand: (_key, cb) => { monaco.save = cb; } }, { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } });
    return <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />;
  },
  MonacoDiffEditor: () => null,
}));

// Only the surrounding views are stubbed: the file content itself goes through the real query, so a
// save's cache update is what the pane falls back to when it retires its draft.
vi.mock('./MarkdownPreview', () => ({ MarkdownPreview: () => null }));
vi.mock('../../../../web/lib/queries', async (orig) => ({
  ...(await orig() as object),
  useProjectFiles: () => ({ data: [{ path: 'a.ts', type: 'file' }, { path: 'b.ts', type: 'file' }], isLoading: false }),
  useProjectFileAtHead: () => ({ data: { content: '' }, isLoading: false }),
  useProjectCommit: () => ({ data: undefined, isLoading: false }),
  useProjectCommitFileDiff: () => ({ data: undefined, isLoading: false }),
  useProjectChanged: () => ({ data: { changed: [] }, isLoading: false }),
  useProjectChanges: () => ({ data: undefined, isLoading: false }),
}));

let ProjectEditor: ComponentType<{ projectId: number }>;
beforeAll(async () => {
  ensurePluginUiRuntime();
  ({ ProjectEditor } = await import('./ProjectEditor'));
});

// Server-side file state. Writes are held open (one gate per path) so a test can type — or start a
// second save — while the first one is still in flight.
const INITIAL = new Map([['a.ts', 'line one\n'], ['b.ts', 'other file\n']]);
let stored = new Map(INITIAL);
const gates = new Map<string, () => void>();
let failing = new Set<string>();
// A read can be parked mid-test: it is the only way to tell the write's own cache update apart from
// the refetch that follows it.
let holdReads = false;
let readGates: Array<() => void> = [];
const server = setupServer(
  http.get('*/api/projects/:id/file', async ({ request }) => {
    if (holdReads) await new Promise<void>((resolve) => readGates.push(resolve));
    const path = new URL(request.url).searchParams.get('path') ?? '';
    return HttpResponse.json({ content: stored.get(path) ?? '', truncated: false });
  }),
  http.put('*/api/projects/:id/file', async ({ request }) => {
    const body = (await request.json()) as { path: string; content: string };
    await new Promise<void>((resolve) => gates.set(body.path, resolve));
    gates.delete(body.path);
    if (failing.has(body.path)) return HttpResponse.json({ error: 'boom' }, { status: 500 });
    stored.set(body.path, body.content);
    return HttpResponse.json({ ok: true });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
beforeEach(() => { stored = new Map(INITIAL); gates.clear(); failing = new Set(); holdReads = false; readGates = []; });
afterEach(() => { holdReads = false; for (const open of [...gates.values(), ...readGates]) open(); });
afterAll(() => server.close());

const editorEl = () => screen.getByLabelText('editor') as HTMLTextAreaElement;
const openInTree = (name: string) => fireEvent.click(within(screen.getByRole('tree')).getByRole('button', { name }));
const cachedContent = (client: QueryClient, path: string) =>
  (client.getQueryData(['project-file', 5, path]) as { content: string } | undefined)?.content;

async function renderEditor() {
  const { wrapper: Base, client } = createWrapper();
  const Wrapper = ({ children }: { children: ReactNode }) => <Base><ToastProvider>{children}</ToastProvider></Base>;
  render(<ProjectEditor projectId={5} />, { wrapper: Wrapper });
  openInTree('a.ts');
  await waitFor(() => expect(editorEl().value).toBe('line one\n'));
  return client;
}
const saveNow = async (path: string) => { act(() => monaco.save()); await waitFor(() => expect(gates.has(path)).toBe(true)); };

describe('ProjectEditor save', () => {
  it('keeps edits typed while the save is in flight', async () => {
    const client = await renderEditor();

    fireEvent.change(editorEl(), { target: { value: 'saved text\n' } });
    await saveNow('a.ts');

    // The user keeps typing before the write comes back: the save may only retire a draft that still
    // holds exactly what it sent, or it would swallow these keystrokes.
    fireEvent.change(editorEl(), { target: { value: 'saved text\nstill typing\n' } });
    act(() => { gates.get('a.ts')?.(); });
    await screen.findByText('Saved a.ts');
    await waitFor(() => expect(cachedContent(client, 'a.ts')).toBe('saved text\n'));

    expect(editorEl().value).toBe('saved text\nstill typing\n');
    // …and the file is still dirty, so the newer text can actually be saved.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('keeps the saved text on screen after retiring the draft', async () => {
    await renderEditor();
    // The refetch the save triggers is parked, so what stays on screen can only come from the cache
    // update the write itself made.
    holdReads = true;

    fireEvent.change(editorEl(), { target: { value: 'saved text\n' } });
    await saveNow('a.ts');
    act(() => { gates.get('a.ts')?.(); });
    await screen.findByText('Saved a.ts');

    // Draft retired → the pane falls back to the file cache. Falling back to the pre-save content
    // here would look to the user like the save had been undone.
    expect(editorEl().value).toBe('saved text\n');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('completes every save, not just the most recent one', async () => {
    // Cmd+S does not block, so the user can save a.ts, switch tab and save b.ts before a.ts answers.
    // Both saves must finish their own cleanup — here the older one fails and has to reach its toast
    // and keep its draft, while the newer one is retired as usual.
    failing.add('a.ts');
    await renderEditor();

    fireEvent.change(editorEl(), { target: { value: 'edited a\n' } });
    await saveNow('a.ts');

    openInTree('b.ts');
    await waitFor(() => expect(editorEl().value).toBe('other file\n'));
    fireEvent.change(editorEl(), { target: { value: 'edited b\n' } });
    await saveNow('b.ts');

    act(() => { gates.get('b.ts')?.(); });
    await screen.findByText('Saved b.ts');
    act(() => { gates.get('a.ts')?.(); });
    await screen.findByText(/elowen 500/);

    // b.ts is saved and clean…
    await waitFor(() => expect(editorEl().value).toBe('edited b\n'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // …while the failed a.ts keeps its unsaved text.
    openInTree('a.ts');
    await waitFor(() => expect(editorEl().value).toBe('edited a\n'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
