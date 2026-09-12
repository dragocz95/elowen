import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import { ToastProvider } from '../../components/ui/Toast';
import type { BrainStatus, ProjectExecutionRef } from '../../lib/types';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (event: MessageEvent) => void>();
  constructor() { FakeEventSource.instances.push(this); }
  close = vi.fn();
  addEventListener(name: string, listener: (event: MessageEvent) => void): void { this.listeners.set(name, listener); }
  emit(name: string): void { this.listeners.get(name)?.(new MessageEvent(name, { data: '{}' })); }
}
vi.stubGlobal('EventSource', FakeEventSource);
const state = vi.hoisted(() => ({
  session: 'brain-fresh', created: true, target: { kind: 'host' } as ProjectExecutionRef,
}));
const status = (): BrainStatus => ({ running: false, sessionId: state.session, projectRef: state.target, model: 'test', usage: null, statusline: null });
const brainStatus = vi.fn(async () => status());
const brainSetExecution = vi.fn(async (target: ProjectExecutionRef, session: string) => {
  expect(session).toBe(state.session);
  state.target = target;
  return { projectRef: target, workDir: target.kind === 'managed' ? '/managed-test' : '/host-test' };
});
const brainSend = vi.fn(async () => ({ ok: true }));
vi.mock('../../lib/elowenClient', () => ({
  BASE: '/api', apiErrorMessage: (error: Error) => error.message,
  elowenClient: {
    brainStart: async () => ({ sessionId: state.session, created: state.created }),
    brainStatus: (...args: []) => brainStatus(...args),
    brainSetExecution: (...args: [ProjectExecutionRef, string]) => brainSetExecution(...args),
    brainSend: (...args: []) => brainSend(...args),
    brainMessagesPage: async () => ({ items: [], hasMore: false, nextBefore: null }),
    brainMessages: async () => [], brainModels: async () => [], brainCommands: async () => ({ commands: [] }),
    brainSessions: async () => [], brainVisibility: () => {},
    projects: async () => [
      { id: 42, slug: 'managed-test', executionKind: 'managed' },
      { id: 43, slug: 'host-test', executionKind: 'host', path: '/host-test' },
    ],
    me: async () => ({ user: { id: 1, is_admin: true } }),
    getConfig: async () => ({}),
  },
}));
import { BrainChatProvider, useBrainChat } from '../../modules/advisor/BrainChatProvider';
import { NewConversationProjectModal } from '../../modules/advisor/NewConversationProjectModal';
import { ProjectPicker } from '../../modules/advisor/ProjectPicker';

function Harness() {
  const chat = useBrainChat();
  useEffect(() => { chat.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <NewConversationProjectModal /><ProjectPicker />
    <button onClick={() => { chat.setInput('First request'); void chat.submit(); }}>Send test</button>
    <button onClick={() => chat.closeProjectChoice()}>Cancel test</button>
    <button onClick={() => { void chat.switchSession({ session: state.session }); }}>Reconnect test</button>
    <output data-testid="target">{JSON.stringify(chat.telemetry.projectRef)}</output>
    <output data-testid="lsp">{String(chat.telemetry.lspEnabled)}</output>
  </>;
}
const mount = () => render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper: createWrapper().wrapper });
beforeEach(() => {
  vi.clearAllMocks(); FakeEventSource.instances.length = 0; state.session = 'brain-fresh'; state.created = true; state.target = { kind: 'host' };
  brainStatus.mockImplementation(async () => status());
});
const picker = () => within(screen.getByTestId('chat-project-picker'));

describe('new conversation project selection shared with the composer', () => {
  it.each([
    ['managed-test', { kind: 'managed', projectId: 42 }],
    ['host-test', { kind: 'host', projectId: 43 }],
  ] as const)('publishes confirmed %s identity before first send and restores it on reload', async (name, target) => {
    const view = mount();
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(name) }));
    await waitFor(() => expect(screen.queryByTestId('new-conversation-projects')).toBeNull());
    expect(brainSetExecution).toHaveBeenCalledExactlyOnceWith(target, 'brain-fresh');
    expect(state.target).toEqual(target);
    expect(picker().getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByTestId('target')).toHaveTextContent(JSON.stringify(target));
    fireEvent.click(screen.getByText('Send test'));
    await waitFor(() => expect(brainSend).toHaveBeenCalledTimes(1));
    expect(brainSend.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ session: 'brain-fresh' })]));
    view.unmount(); state.created = false;
    mount();
    await waitFor(() => expect(picker().getByRole('button', { name })).toBeInTheDocument());
    expect(screen.queryByTestId('new-conversation-projects')).toBeNull();
  });

  it('does not overwrite a confirmed choice with the older connect status', async () => {
    let resolve!: (value: BrainStatus) => void;
    const oldStatus = status();
    brainStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /managed-test/ }));
    await waitFor(() => expect(screen.queryByTestId('new-conversation-projects')).toBeNull());
    await act(async () => { resolve(oldStatus); });
    expect(picker().getByRole('button', { name: 'managed-test' })).toBeInTheDocument();
  });

  it('fences only the identity of a superseded read, not the rest of it', async () => {
    let resolve!: (value: BrainStatus) => void;
    brainStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /managed-test/ }));
    await waitFor(() => expect(screen.queryByTestId('new-conversation-projects')).toBeNull());
    // The read started before the switch was confirmed, so its identity is stale — but nothing else
    // publishes the MCP and LSP sections, and dropping them leaves the telemetry panel blank.
    await act(async () => { resolve({ ...status(), projectRef: { kind: 'host' }, lspEnabled: true }); });
    expect(screen.getByTestId('target')).toHaveTextContent(JSON.stringify({ kind: 'managed', projectId: 42 }));
    expect(screen.getByTestId('lsp')).toHaveTextContent('true');
  });

  it('keeps the project question through a reconnect to the same conversation', async () => {
    mount();
    await screen.findByRole('radio', { name: /managed-test/ });
    state.created = false; // a reconnect resumes the conversation; it does not create one
    fireEvent.click(screen.getByText('Reconnect test'));
    await waitFor(() => expect(brainStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('new-conversation-projects')).toBeInTheDocument();
  });

  it('keeps the latest event status when overlapping reads resolve in request order', async () => {
    state.created = false;
    mount();
    await waitFor(() => expect(screen.getByTestId('target')).toHaveTextContent(JSON.stringify({ kind: 'host' })));
    let first!: (value: BrainStatus) => void;
    let second!: (value: BrainStatus) => void;
    brainStatus.mockImplementationOnce(() => new Promise((done) => { first = done; }))
      .mockImplementationOnce(() => new Promise((done) => { second = done; }));
    act(() => { FakeEventSource.instances[0].emit('session-event'); FakeEventSource.instances[0].emit('session-event'); });
    await act(async () => { first({ ...status(), projectRef: { kind: 'managed', projectId: 42 } }); });
    await act(async () => { second({ ...status(), projectRef: { kind: 'host', projectId: 43 } }); });
    expect(screen.getByTestId('target')).toHaveTextContent(JSON.stringify({ kind: 'host', projectId: 43 }));
  });

  it('shares a subsequent in-conversation selection with every consumer', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /managed-test/ }));
    await waitFor(() => expect(screen.queryByTestId('new-conversation-projects')).toBeNull());
    fireEvent.keyDown(picker().getByRole('button', { name: 'managed-test' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'host-test' }));
    await waitFor(() => expect(screen.getByTestId('target')).toHaveTextContent(JSON.stringify({ kind: 'host', projectId: 43 })));
  });

  it('keeps a rejected choice open and leaves the shared target unchanged', async () => {
    brainSetExecution.mockRejectedValueOnce(new Error('Selection refused'));
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /managed-test/ }));
    await screen.findByText('Selection refused');
    expect(screen.getByTestId('new-conversation-projects')).toBeInTheDocument();
    expect(screen.getByTestId('chat-project-picker')).toHaveTextContent('No project');
    expect(screen.getByTestId('target')).toHaveTextContent(JSON.stringify({ kind: 'host' }));
  });

  it('does not apply a late selection response to another conversation', async () => {
    let resolve!: (value: { projectRef: ProjectExecutionRef; workDir: string }) => void;
    brainSetExecution.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /managed-test/ }));
    state.session = 'brain-other'; state.created = false;
    fireEvent.click(screen.getByText('Reconnect test'));
    await waitFor(() => expect(brainStatus).toHaveBeenCalledTimes(2));
    await act(async () => { resolve({ projectRef: { kind: 'managed', projectId: 42 }, workDir: '/managed-test' }); });
    expect(screen.getByTestId('target')).toHaveTextContent(JSON.stringify({ kind: 'host' }));
    expect(screen.queryByTestId('new-conversation-projects')).toBeNull();
  });

  it('dismissing the question preserves the default without a mutation', async () => {
    mount(); await screen.findByRole('radio', { name: /managed-test/ });
    fireEvent.click(screen.getByText('Cancel test'));
    expect(brainSetExecution).not.toHaveBeenCalled();
    expect(state.target).toEqual({ kind: 'host' });
    expect(picker().getByRole('button', { name: 'No project' })).toBeInTheDocument();
  });
});
