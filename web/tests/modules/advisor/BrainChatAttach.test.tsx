import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider, useBrainChat, useBrainChatStatus } from '../../../modules/advisor/BrainChatProvider';
import { uploadAttachment } from '../../../modules/advisor/brainChatAttachments';

// An attachment is uploaded into the user's project and the message carries its PATH. That replaces the
// base64 staging this file used to cover, and with it every reason the composer had to judge a file:
// there is no format to support or refuse and no size that is too large, because nothing has to fit
// inside the message any more. What still has to hold is that the reference is what travels — the agent
// opens the file itself — and that a failed transfer stages nothing and says so.

class FakeES {
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

let sent: { text: string } | null = null;
let uploaded: string[] = [];
/** Every upload's query, so a test can assert WHAT the browser is allowed to tell the server. */
let uploadQueries: URLSearchParams[] = [];
let uploadStatus = 200;

const server = setupServer(
  http.post('*/api/brain/uploads', ({ request }) => {
    const query = new URL(request.url).searchParams;
    uploadQueries.push(query);
    const name = query.get('name') ?? '';
    uploaded.push(name);
    if (uploadStatus !== 200) return new HttpResponse(null, { status: uploadStatus });
    return HttpResponse.json({
      path: `/data/project/uploads/admin/2026-08-23/${name}`,
      relative: `uploads/admin/2026-08-23/${name}`,
      name,
      size: 1234,
      project: { id: 2, slug: 'sdilene' },
    });
  }),
  http.post('*/api/brain/send', async ({ request }) => {
    sent = await request.json() as { text: string };
    return HttpResponse.json({ ok: true });
  }),
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-08-05', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => { server.listen({ onUnhandledRequest }); });
afterEach(() => { server.resetHandlers(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  sent = null; uploaded = []; uploadQueries = []; uploadStatus = 200;
});

let addFiles: (files: Iterable<File>) => Promise<void>;
let submit: () => Promise<void>;
let setInput: (v: string) => void;
let staged: { name: string; path: string; relative: string }[];

function Probe() {
  const chat = { ...useBrainChat(), ...useBrainChatStatus() };
  addFiles = chat.addFiles;
  submit = chat.submit;
  setInput = chat.setInput;
  staged = chat.attachments.map((a) => ({ name: a.name, path: a.path, relative: a.relative }));
  return null;
}

async function mount() {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><Probe /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(addFiles).toBeTypeOf('function'));
}

const fileOf = (name: string, type = ''): File => new File([new Uint8Array([1, 2, 3]) as BlobPart], name, ...(type ? [{ type }] : []));

describe('attaching a file', () => {
  it('takes any type at all — including the ones the old base64 path refused', async () => {
    await mount();
    await act(async () => {
      await addFiles([
        fileOf('photo.heic', 'image/heic'),   // an image no provider decodes
        fileOf('archive.zip', 'application/zip'), // binary, previously "not inlinable"
        fileOf('notes'),                       // no type reported at all
      ]);
    });
    expect(uploaded).toEqual(['photo.heic', 'archive.zip', 'notes']);
    expect(staged.map((s) => s.name)).toEqual(['photo.heic', 'archive.zip', 'notes']);
  });

  it('does not care how big the file is', async () => {
    await mount();
    const huge = fileOf('dump.sql');
    Object.defineProperty(huge, 'size', { value: 900 * 1024 * 1024 });
    await act(async () => { await addFiles([huge]); });
    expect(staged.map((s) => s.name)).toEqual(['dump.sql']);
  });

  it('stages the stored name, which is not always the one that was sent', async () => {
    // The daemon sanitizes and de-duplicates, so the composer must show what actually landed rather
    // than what the user picked — otherwise the chip names a file that is not there.
    server.use(http.post('*/api/brain/uploads', () => HttpResponse.json({
      path: '/data/project/uploads/admin/2026-08-23/report (2).txt',
      relative: 'uploads/admin/2026-08-23/report (2).txt',
      name: 'report (2).txt', size: 10, project: { id: 2, slug: 'sdilene' },
    })));
    await mount();
    await act(async () => { await addFiles([fileOf('report.txt')]); });
    expect(staged[0]?.name).toBe('report (2).txt');
  });

  it('sends the PATH, not the contents', async () => {
    await mount();
    await act(async () => { await addFiles([fileOf('nabidka.pdf')]); });
    act(() => setInput('mrkni na to'));
    await act(async () => { await submit(); });
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent?.text).toContain('mrkni na to');
    expect(sent?.text).toContain('/data/project/uploads/admin/2026-08-23/nabidka.pdf');
  });

  it('stages nothing and says so when the upload fails', async () => {
    uploadStatus = 500;
    await mount();
    await act(async () => { await addFiles([fileOf('x.bin')]); });
    expect(staged).toEqual([]);
    expect(await screen.findByText(/nepodařilo nahrát|could not be uploaded|nepodarilo nahrať/i)).toBeTruthy();
  });

  it('sends the conversation id and the declared size, and never a project or a path', async () => {
    // Where a file lands is the conversation's business: the browser hands over an opaque session id and
    // the file's length, and the server resolves the project and the destination itself. A client that
    // could name a project — or a filesystem path — would be choosing somebody's storage for them.
    const file = fileOf('01-kava.png');
    Object.defineProperty(file, 'size', { value: 1586902 });
    await uploadAttachment(file, 'brain-1-mu2h35tfzipb');

    const query = uploadQueries[0]!;
    expect(query.get('session')).toBe('brain-1-mu2h35tfzipb');
    expect(query.get('size')).toBe('1586902');
    expect(query.get('name')).toBe('01-kava.png');
    // Nothing else is the client's to say — no project id, no execution kind, no path.
    expect([...query.keys()].sort()).toEqual(['name', 'session', 'size']);
  });

  it('carries the declared size through the composer, where the conversation supplies the id', async () => {
    await mount();
    const file = fileOf('smlouva.pdf');
    Object.defineProperty(file, 'size', { value: 4096 });
    await act(async () => { await addFiles([file]); });
    expect(uploadQueries[0]!.get('size')).toBe('4096');
    expect(uploadQueries[0]!.has('path')).toBe(false);
  });

  it('shows the server’s own refusal, which is the half the user can act on', async () => {
    // A placement refusal names what to do — "ask an administrator to assign you one". Reporting it as
    // the generic transfer failure is what left a company instance unable to attach anything for days
    // with nothing on screen to explain why.
    server.use(http.post('*/api/brain/uploads', () => HttpResponse.json(
      { error: 'no project to upload into — ask an administrator to assign you one' },
      { status: 409 },
    )));
    await mount();
    await act(async () => { await addFiles([fileOf('01-kava.png')]); });
    expect(staged).toEqual([]);
    expect(await screen.findByText(/ask an administrator to assign you one/i)).toBeTruthy();
  });
});
