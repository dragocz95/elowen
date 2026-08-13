import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ThemeProvider } from '../../../lib/useTheme';
import { EffectsProvider } from '../../../lib/useEffects';
import { en } from '../../../lib/i18n/dictionaries/en';
import { ElowenApiError } from '../../../lib/elowenClient';
import type { LogFileContent } from '../../../lib/types';

const useLogFiles = vi.hoisted(() => vi.fn());
const useLogFile = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries', () => ({ useLogFiles, useLogFile }));
vi.mock('../../../lib/mutations', () => ({
  useDeleteLogFile: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteAllLogFiles: () => ({ mutate: vi.fn(), isPending: false }),
}));
// Monaco is browser-only and irrelevant to the states under test — stand it in for a marker div.
vi.mock('../../../lib/monaco/monacoLoader', () => ({ MonacoEditor: () => <div data-testid="monaco" /> }));
vi.mock('../../../lib/monaco/oledTheme', () => ({ defineEditorThemes: () => {}, editorTheme: () => 'elowen-oled' }));

import { LogsModal } from '../../../modules/settings/LogsModal';

const FILE = 'daemon-2026-07-25.log';

type FileQuery = ReturnType<typeof useLogFile>;

/** A useLogFile result. `name`-gated so an unselected viewer gets the idle shape and a selected one the
 *  configured state, mirroring the real `enabled: !!name` query. */
const fileQuery = (state: Partial<FileQuery>): FileQuery =>
  ({ data: undefined, isLoading: false, isError: false, isFetching: false, error: null, refetch: vi.fn(), ...state } as FileQuery);

const content = (over: Partial<LogFileContent> = {}): LogFileContent =>
  ({ name: FILE, lines: ['2026-07-25 17:33:34.120  INFO   [x]  hello'], totalLines: 1, truncated: false, bytes: 42, ...over });

const setFileState = (state: Partial<FileQuery>): void => {
  useLogFile.mockImplementation((name: string | null) => (name ? fileQuery(state) : fileQuery({})));
};

const renderModal = () =>
  render(
    <EffectsProvider><ThemeProvider><LanguageProvider><LogsModal onClose={() => {}} /></LanguageProvider></ThemeProvider></EffectsProvider>,
  );

const selectFile = async (): Promise<void> => {
  const name = await screen.findByText(FILE);
  const pick = name.closest('button');
  if (!pick) throw new Error('file pick button not found');
  fireEvent.click(pick);
};

beforeEach(() => {
  useLogFiles.mockReset();
  useLogFile.mockReset();
  useLogFiles.mockReturnValue({ data: { dir: '/var/log/elowen', files: [{ name: FILE, source: 'daemon', bytes: 42, modifiedAt: Date.now() }] } });
});

describe('LogsModal read states', () => {
  it('shows a loading state for a read that has nothing on screen yet', async () => {
    setFileState({ isLoading: true, isFetching: true });
    renderModal();
    await selectFile();
    expect(screen.getByLabelText(en.common.loading)).toBeInTheDocument();
    expect(screen.queryByTestId('monaco')).not.toBeInTheDocument();
  });

  it('does not flash the loading state on a background refetch of data already shown', async () => {
    // The 3s poll sets isFetching without clearing data; isLoading stays false, so the editor keeps the
    // screen rather than a spinner blinking over the text the user is reading.
    setFileState({ data: content(), isFetching: true });
    renderModal();
    await selectFile();
    expect(await screen.findByTestId('monaco')).toBeInTheDocument();
    expect(screen.queryByLabelText(en.common.loading)).not.toBeInTheDocument();
  });

  it('names the failure: a deleted file (404) vs a file over the read cap (413)', async () => {
    setFileState({ isError: true, error: new ElowenApiError('gone', 404) });
    const { unmount } = renderModal();
    await selectFile();
    expect(screen.getByText(en.settings.logsErrorGone)).toBeInTheDocument();
    unmount();

    setFileState({ isError: true, error: new ElowenApiError('too big', 413) });
    renderModal();
    await selectFile();
    expect(screen.getByText(en.settings.logsErrorTooBig)).toBeInTheDocument();
  });

  it('surfaces a deleted-file error over stale cached content instead of freezing the editor', async () => {
    // A file deleted from under the viewer 404s while react-query keeps the last successful read. Showing
    // the editor here would freeze that stale content on screen forever; the viewer must say the file is
    // gone even though `data` is still populated.
    setFileState({ data: content(), isError: true, error: new ElowenApiError('gone', 404) });
    renderModal();
    await selectFile();
    expect(screen.getByText(en.settings.logsErrorGone)).toBeInTheDocument();
    expect(screen.queryByTestId('monaco')).not.toBeInTheDocument();
  });

  it('falls back to a generic read error for anything else', async () => {
    setFileState({ isError: true, error: new ElowenApiError('boom', 500) });
    renderModal();
    await selectFile();
    expect(screen.getByText(en.settings.logsError)).toBeInTheDocument();
  });
});

describe('LogsModal truncation banner', () => {
  it('offers to load the whole file while a tail is truncated', async () => {
    setFileState({ data: content({ lines: new Array(100).fill('x'), totalLines: 5000, truncated: true }) });
    renderModal();
    await selectFile();
    expect(screen.getByRole('button', { name: en.settings.logsLoadFull })).toBeInTheDocument();
    expect(screen.queryByText(/maximum/)).not.toBeInTheDocument();
  });

  it('drops the button and says it is the viewer ceiling once the whole file was requested', async () => {
    // The full read is still truncated: the file is over the viewer's line ceiling. The button then does
    // nothing, so it must go, and the wording must stop implying more can be loaded.
    setFileState({ data: content({ lines: new Array(50000).fill('x'), totalLines: 120000, truncated: true }) });
    renderModal();
    await selectFile();
    fireEvent.click(screen.getByRole('button', { name: en.settings.logsLoadFull }));
    await waitFor(() => expect(screen.queryByRole('button', { name: en.settings.logsLoadFull })).not.toBeInTheDocument());
    expect(screen.getByText(/maximum/)).toBeInTheDocument();
  });
});

describe('LogsModal accessibility', () => {
  it('marks the selected file with aria-current so it is not conveyed by colour alone', async () => {
    setFileState({ data: content() });
    renderModal();
    await selectFile();
    const pick = (await screen.findByText(FILE)).closest('button');
    expect(pick).toHaveAttribute('aria-current', 'true');
  });
});
