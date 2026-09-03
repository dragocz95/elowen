import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse, delay } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }
// The diacritics tests search in Czech: "retence" (and "retenc" with no diacritics at all) must find the
// memory-retention row, which is why they render against the Czech dictionary. `initialLocale="cs"` with
// storage cleared (see the beforeEach below) keeps the provider from resolving a stray stored locale.
function Cs({ children }: { children: React.ReactNode }) { return <LanguageProvider initialLocale="cs">{children}</LanguageProvider>; }

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: () => {} }) }));
// The palette lists the pages of every enabled plugin alongside the core modules; this suite runs
// without a QueryClient, so the hook is stubbed directly.
vi.mock('../../../lib/queries', () => ({
  usePluginUi: () => ({ data: [{
    name: 'work',
    nav: [
      { label: 'Tasks', icon: 'ListChecks', route: 'tasks' },
      { label: 'Kanban', icon: 'KanbanSquare', route: 'kanban' },
    ],
    settings: [],
  }] }),
}));
import { CommandPalette, COMMAND_PALETTE_OPEN_EVENT } from '../../../components/shell/CommandPalette';
import { Modal } from '../../../components/ui/Modal';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const primitivesCss = readFileSync(join(WEB, 'app', 'styles', 'components', 'primitives.css'), 'utf-8');

// jsdom implements no scrollIntoView, and cmdk keeps the selected row in view — that is the whole point
// of wrapping past the ends of a list taller than its scroller.
beforeAll(() => { Element.prototype.scrollIntoView ??= () => {}; });

const openPalette = () => fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
const type = (query: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
/** The group headings cmdk rendered, in order — the launcher's fixed group order made visible. */
const headings = () => [...document.querySelectorAll('[cmdk-group-heading]')].map((el) => el.textContent);
const optionCount = () => document.querySelectorAll('[cmdk-item]').length;
/** Row values (the entry ids) currently rendered — a stable handle the highlight cannot split. */
const rowValues = () => [...document.querySelectorAll('[cmdk-item]')].map((el) => el.getAttribute('data-value'));

// The two assisted passes go over the network. Every suite in this file gets the server, defaulting to
// "this instance has no semantic layer" (503) — the same answer an install with no embedding provider
// gives — so the tests that are NOT about assistance behave exactly as they did before it existed.
const server = setupServer(
  http.post('*/api/search/rank', () => HttpResponse.json({ error: 'embeddings-not-configured' }, { status: 503 })),
  http.post('*/api/search/ask', () => HttpResponse.json({ error: 'model-not-configured' }, { status: 503 })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Longer than the palette's 300 ms debounce, short enough to stay a fast test. Real timers rather than
 *  fake ones: msw, fetch and React's act queue all schedule work of their own, and a faked clock makes
 *  the interleaving of those the thing under test instead of the debounce. */
const PAST_DEBOUNCE_MS = 450;
const settle = (ms = PAST_DEBOUNCE_MS) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Serve `/search/rank` from a query → answer table, recording the queries that actually went out.
 *  `delayMs` is PER QUERY, which is what lets a test put one answer behind another and check that the
 *  overtaken one is discarded rather than rendered. */
function serveRank(byQuery: Record<string, { ids: string[]; delayMs?: number }>) {
  const queries: string[] = [];
  server.use(http.post('*/api/search/rank', async ({ request }) => {
    const body = await request.json() as { query: string };
    queries.push(body.query);
    const answer = byQuery[body.query];
    if (answer?.delayMs) await delay(answer.delayMs);
    return HttpResponse.json({ results: (answer?.ids ?? []).map((id) => ({ id, score: 0.7 })) });
  }));
  return queries;
}

beforeEach(() => {
  // The stored locale outlives a test — and `LanguageProvider` re-resolves it on mount, so a Czech
  // test would silently render in whatever language the PREVIOUS test left behind.
  localStorage.clear();
});

describe('CommandPalette', () => {
  // The searched destination is a PLUGIN page: the board left the core registry with the work plugin,
  // and a palette that only walked MODULES would have quietly stopped being able to reach it.
  it('opens on Ctrl+K, filters, and runs a command on Enter', () => {
    render(<CommandPalette />, { wrapper: W });
    expect(screen.queryByPlaceholderText('Search…')).not.toBeInTheDocument();
    openPalette();
    const input = screen.getByPlaceholderText('Search…');
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'kanban' } });
    // One ArrowDown settles cmdk's roving cursor onto the single match before Enter: cmdk resolves the
    // initial selection asynchronously and announces it with the first interaction.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/p/work/kanban');
  });

  // A ROW is chosen by its anchor, a SECTION by its section alone. The href is the only channel — the
  // same one a semantic suggestion, an Ask AI answer and a pasted link travel through — so what is pushed
  // here is what makes the settings page scroll to that record and blink it.
  it('pushes the row anchor with a row, and nothing extra for a section', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    type(en.settings.modelRoles.digest);
    const row = document.querySelector<HTMLElement>('[cmdk-item][data-value="settings:models:settings.modelRoles.digest"]')!;
    // The anchor is machinery, not an address: the hint column keeps printing the route a reader knows.
    expect(row.textContent).toContain('/settings?cat=models');
    expect(row.textContent).not.toContain('row=');
    fireEvent.click(row);
    expect(push).toHaveBeenCalledWith('/settings?cat=models&row=settings.modelRoles.digest');

    openPalette();
    type(en.settings.models);
    fireEvent.click(document.querySelector<HTMLElement>('[cmdk-item][data-value="settings:models"]')!);
    expect(push).toHaveBeenCalledWith('/settings?cat=models');
  });

  // TopBar's visible trigger dispatches exactly this event, and it is the only way a pointer user reaches
  // the palette at all — a design that ships the button must not ship it dead.
  //
  // The marker is asserted alongside the focus because Radix would otherwise cover for its absence: its
  // own `onOpenAutoFocus` default focuses the first TABBABLE control, which here happens to be this same
  // input (cmdk's rows are not in the Tab cycle). Focus landing correctly therefore does not prove the
  // app's policy still runs; `data-autofocus` being on the element it aims at is what does.
  it('opens on the window event and hands focus to the search field', () => {
    render(<CommandPalette />, { wrapper: W });
    fireEvent(window, new Event(COMMAND_PALETTE_OPEN_EVENT));
    const input = screen.getByPlaceholderText('Search…');
    expect(input).toHaveAttribute('data-autofocus');
    expect(input).toHaveFocus();
  });

  // The EMPTY query is a calm launcher: the page routes plus the Settings and Account decks' sections —
  // no row entries. Typing is what reveals the rows (and the plugin pages).
  it('launches calm on an empty query and reveals the rows once you type', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    expect(headings()).toEqual(['Primary', 'Settings', 'My account']);
    expect(screen.queryByRole('option', { name: /Memory retention/ })).not.toBeInTheDocument();

    type('retention');
    expect(screen.getByRole('option', { name: /Memory retention/ })).toBeInTheDocument();
    // Plugin pages are launcher material only once there is something to search for.
    type('kanban');
    expect(screen.getByRole('option', { name: /Kanban/ })).toBeInTheDocument();
  });

  // Grouped presentation, with the memory-retention row found under its Settings section — and the match
  // highlighted inside the ORIGINAL accented title. `retence` (Czech), `Retence` (case) and `retenc`
  // (no diacritics typed at all) must all reach it; cmdk's own filter is neither diacritics- nor
  // case-aware in the way the app needs, which is why the custom filter in siteSearch owns matching.
  //
  // THE ROW LIVES IN SETTINGS → {agentName} AI, so Enter deep-links `/settings?cat=brain` — and names
  // the row itself in `&row=`, which is what makes the arriving page scroll to it and blink it. (The deck's
  // Memory section hosts the embedding/categorization models; retention is a Brain-runtime record —
  // pointing the row anywhere else would land the user in a section that does not contain it.)
  it('finds the memory-retention row from "retence" in any casing or diacritics, and highlights the match', async () => {
    // Each query gets its own mount: one change per palette keeps the interaction on the single
    // code path that is deterministic under cmdk's controlled field.
    for (const q of ['retence', 'Retence', 'retenc']) {
      const view = render(<CommandPalette />, { wrapper: Cs });
      openPalette();
      const input = screen.getByRole('combobox');
      fireEvent.change(input, { target: { value: q } });
      // The row is addressed by its cmdk `data-value` (the entry id): when the query lands mid-word,
      // the highlight splits the title and the flattened accessible name carries an artifact space at
      // the split ("Retenc e paměti"), so the name is not a stable handle — the value is.
      const row = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[cmdk-item][data-value="settings:brain:brain.retention.title"]');
        expect(el, `"${q}" must reveal the memory-retention row`).not.toBeNull();
        return el!;
      });
      expect(row).toHaveAttribute('role', 'option');
      // The subtitle names the section the row lives in.
      expect(row.textContent).toContain('Elowen AI');
      // The matched substring wears the accent, mapped back onto the accented original.
      const highlighted = row.querySelector('.text-primary');
      expect(highlighted, `"${q}" must highlight the matched substring`).not.toBeNull();
      expect(highlighted!.textContent).toBe(q.slice(0, 1).toUpperCase() + q.slice(1));
      view.unmount();
    }
    // Two rows legitimately match "retence" (the runtime row's hint mentions it too), and the retention
    // row is the second: walk the cursor onto it, then Enter runs exactly that row.
    render(<CommandPalette />, { wrapper: Cs });
    openPalette();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'retence' } });
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[cmdk-item][data-value="settings:brain:brain.retention.title"]');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(input).toHaveAttribute('aria-activedescendant', row.id);
      expect(row).toHaveAttribute('data-selected', 'true');
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/settings?cat=brain&row=brain.retention.title');
  });

  // The palette used to be a bare <input> over a <ul> of <button>s: no combobox, no listbox, no announced
  // active row. cmdk now owns all of that — this pins the wiring it must keep providing.
  //
  // cmdk announces the active row through `aria-activedescendant` when the cursor MOVES; mount itself
  // only paints `aria-selected` on the first row (the announced id lands with the first cursor move), so
  // the first ArrowDown is the deterministic point from which every move is announced at once.
  it('exposes a combobox over a listbox and announces the active option', async () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    const input = screen.getByRole('combobox', { name: 'Search commands…' });
    const list = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(input).toHaveAttribute('aria-expanded', 'true');

    // The first row starts active…
    const options = screen.getAllByRole('option');
    await waitFor(() => expect(options[0]).toHaveAttribute('aria-selected', 'true'));
    expect(options[0]).toHaveAttribute('data-selected', 'true');
    // …and ArrowDown moves the cursor, announced on the input and marked on the row.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);
      expect(options[1]).toHaveAttribute('aria-selected', 'true');
      expect(options[1]).toHaveAttribute('data-selected', 'true');
    });
  });

  // Wraparound is what SelectMenu — the app's reference listbox — does, and cmdk's `loop` keeps it.
  it('wraps the cursor past both ends of the list', async () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    const input = screen.getByRole('combobox', { name: 'Search commands…' });
    fireEvent.keyDown(input, { key: 'Home' });
    const options = screen.getAllByRole('option');
    const last = options.at(-1)!.id;

    // Up from the FIRST row wraps to the last; Down from there wraps back to the first.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', last));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id));
  });

  // The dialog is Radix's now, so it has to BE one: an announced modal dialog whose surface sits inside
  // the layer that isolates the page — not a second body child of its own, which is what Radix's
  // `Dialog.Portal` would produce and what the overlay stack would then mark inert. The cmdk parts
  // render INSIDE that surface: no `CommandDialog`, no portal of their own.
  it('renders the palette as a modal dialog inside the isolating layer', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();

    const dialog = screen.getByRole('dialog', { name: 'Open command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toHaveClass('overlay-layer-modal');
    expect(dialog.parentElement!.parentElement).toBe(document.body);
    expect(dialog.closest('[inert]')).toBeNull();
    expect(document.querySelector('[cmdk-root]')!.closest('[role="dialog"]')).toBe(dialog);
  });

  // Radix owns the focus trap and Escape; the app keeps the overlay stack's `inert` isolation and the
  // element to hand focus back to, because Radix has no notion of either — a dialog mounted without a
  // `Dialog.Trigger` leaves it nothing to restore focus to.
  //
  // Escape is raised on the DIALOG, not on `window`: Radix listens on the document, which is where a real
  // keypress arrives after bubbling out of whatever had focus. `window` is one step further up and nothing
  // propagates back down to it.
  it('isolates the background and restores focus to the opener on close', async () => {
    const { container } = render(<CommandPalette />, { wrapper: W });
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    fireEvent(window, new Event(COMMAND_PALETTE_OPEN_EVENT));
    expect(container.closest('body > *')).toHaveAttribute('inert');
    expect(opener).toHaveAttribute('inert');

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Open command palette' }), { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(opener).not.toHaveAttribute('inert');
    // Radix's focus scope hands focus back a tick after the surface is gone, so that its own trap is
    // already torn down and cannot pull the restored focus back into the dialog it is unmounting.
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  // Escape belongs to the TOPMOST overlay only, which is why `CommandPalette` deliberately does not handle
  // it in its own window listener: an overlay raised over the palette has to dismiss itself first and
  // leave the palette standing. That used to be the overlay stack's rule and is now the Radix layer
  // stack's, so it is asserted across the two rather than assumed to have survived the move.
  it('leaves Escape to an overlay raised over it', () => {
    const onRaisedClose = vi.fn();
    function Harness({ raised }: { raised: boolean }) {
      return (
        <>
          <CommandPalette />
          {raised ? <Modal title="Raised dialog" onClose={onRaisedClose}>raised</Modal> : null}
        </>
      );
    }
    // Mounted only after the palette is up, so it really is the layer above it rather than below.
    const { rerender } = render(<Harness raised={false} />, { wrapper: W });
    openPalette();
    rerender(<Harness raised />);

    fireEvent.keyDown(document.querySelector('[data-elowen-modal]')!, { key: 'Escape' });
    expect(onRaisedClose).toHaveBeenCalledTimes(1);
    // Queried through the DOM: the stack correctly takes the palette out of the accessibility tree while
    // it is not the topmost overlay, which is the same rule that just kept Escape away from it.
    expect(document.querySelector('[role="dialog"][aria-label="Open command palette"]')).toBeInTheDocument();
  });

  // A `click` fires on the common ancestor of the press and the release, so a press that begins on a row
  // and ends anywhere else reaches the backdrop with `target === currentTarget`. Radix Select makes that
  // the normal case rather than an edge one — opening it sets `pointer-events: none` on the body — so the
  // backdrop dismisses only on a press that BEGAN on it.
  it('closes on a backdrop press but not on one that began inside the panel', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    const backdrop = screen.getByRole('dialog', { name: 'Open command palette' }).parentElement!;

    fireEvent.pointerDown(screen.getAllByRole('option')[0]!);
    fireEvent.click(backdrop);
    expect(screen.getByRole('dialog', { name: 'Open command palette' })).toBeInTheDocument();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'Open command palette' })).not.toBeInTheDocument();
  });

  // The search field is the ONE input that drops the global focus halo: the panel itself is the focus
  // indication, and the halo reads there as a stray outline around nothing. The app silences it with a
  // scoped stylesheet rule — not by touching the global focus styles — and this pins both halves: the
  // marker class on the input, no ring utility on it, and the rule in the stylesheet that owns overlays.
  it('carries no focus ring on the search field and keeps the ring everywhere else', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    const input = screen.getByRole('combobox');
    expect(input).toHaveClass('command-palette-search');
    expect(input.className).not.toMatch(/focus-visible:(ring|shadow)/);
    expect(primitivesCss).toMatch(/input\.command-palette-search:focus-visible\s*\{\s*box-shadow:\s*none;/);
  });

  // A query that matches nothing gets an answer, not silence — and since the assisted passes landed, the
  // answer carries exactly ONE actionable row: the offer to ask the assistant. There are no destinations
  // among them, which is what this asserts; the Ask row itself is covered further down.
  it('says so when nothing matches', () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    type('no-such-setting-anywhere');
    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(rowValues()).toEqual(['__ask-ai__']);
  });
});

/** The two passes BEHIND the lexical filter. Both are network work on a keystroke-driven surface, so what
 *  matters as much as the results is when they are NOT reached: above the lexical floor, below the query
 *  length, before the debounce, and forever after the daemon has said it cannot help. */
describe('CommandPalette — assisted search', () => {
  // "kanban" is a single plugin page and nothing else, so it is genuinely thin; the daemon answers with a
  // row that shares no word with it, which is the whole point of the layer.
  it('asks for suggestions after the debounce and renders them in their own group', async () => {
    const queries = serveRank({ kanban: { ids: ['settings:brain:brain.maxSteps'] } });
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    type('kanban');

    // Nothing has gone out yet — the lexical answer is already on screen and the debounce is running.
    expect(queries).toEqual([]);
    expect(headings()).not.toContain(en.common.searchSuggestions);

    await settle();
    await waitFor(() => expect(headings()).toContain(en.common.searchSuggestions));
    expect(queries).toEqual(['kanban']);
    // Same row anatomy as a lexical hit — but with no accent, because nothing matched literally.
    const suggestion = document.querySelector<HTMLElement>('[cmdk-item][data-value="settings:brain:brain.maxSteps"]')!;
    expect(suggestion).toHaveAttribute('role', 'option');
    expect(suggestion.querySelector('.text-primary')).toBeNull();
    expect(suggestion.textContent).toContain('/settings?cat=brain');

    // And it navigates like any other row.
    fireEvent.click(suggestion);
    expect(push).toHaveBeenCalledWith('/settings?cat=brain&row=brain.maxSteps');
  });

  // THE GATE. A query the lexical pass already answered must not cost a request at all — this is the
  // assertion that fails if the `< 3 lexical hits` condition is loosened or removed.
  it('leaves the network alone when the lexical pass already found enough', async () => {
    const queries = serveRank({});
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    type('memory');
    expect(optionCount()).toBeGreaterThanOrEqual(3);

    await settle();
    expect(queries).toEqual([]);
  });

  // …and the same for a query too short to be a question rather than a prefix.
  it('leaves the network alone for a query shorter than three characters', async () => {
    const queries = serveRank({});
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    type('zq'); // matches nothing, but is a prefix, not a question
    await settle();
    expect(queries).toEqual([]);
  });

  // STALENESS, with the timing arranged so it is genuinely tested: the first answer is slow enough to be
  // OVERTAKEN by the second, so it would land last and win if nothing discarded it. The palette discards
  // it twice over — the request is aborted on the next keystroke, and a response that beat the abort
  // carries an older request id — and this is what fails if both of those go.
  //
  //   t=0   type "kanban"        t=300 its request goes out (500 ms slow)
  //   t=350 type "kanbon"        t=650 its request goes out and answers at once
  //   t=800 "kanban" would have answered — after the answer that replaced it
  it('never renders a ranking answer to a query the user has moved past', async () => {
    const queries = serveRank({
      kanban: { ids: ['account:security'], delayMs: 500 },
      kanbon: { ids: ['page:memory'] },
    });
    render(<CommandPalette />, { wrapper: W });
    openPalette();

    type('kanban');
    await settle(350);              // past the debounce: the slow request is in flight
    expect(queries).toEqual(['kanban']);
    type('kanbon');                 // …and the user has already moved on
    await settle(900);              // past the moment the overtaken answer would have landed

    expect(queries).toEqual(['kanban', 'kanbon']);
    expect(rowValues()).toContain('page:memory');
    // The superseded answer never appeared — not before the new one, and not after it either.
    expect(rowValues()).not.toContain('account:security');

    // …and abandoning a request is not a failure: the layer is still live for the next query.
    type('tasks');
    await settle();
    expect(queries).toEqual(['kanban', 'kanbon', 'tasks']);
  });

  // An instance with no embedding provider is not a broken instance. It says so once, and the palette
  // stops asking for the rest of the session — silently, with nothing on screen about it.
  it('silences the semantic layer for the rest of the session after a 503, showing nothing', async () => {
    let calls = 0;
    server.use(http.post('*/api/search/rank', () => {
      calls++;
      return HttpResponse.json({ error: 'embeddings-not-configured' }, { status: 503 });
    }));
    render(<CommandPalette />, { wrapper: W });
    openPalette();

    type('kanban');
    await settle();
    expect(calls).toBe(1);
    expect(headings()).not.toContain(en.common.searchSuggestions);
    expect(screen.queryByText(en.common.searchAskFailed)).not.toBeInTheDocument();
    // The lexical answer is untouched — the layer failing is not the search failing.
    expect(rowValues()).toContain('plugin:/p/work/kanban');

    type('tasks');
    await settle();
    expect(calls).toBe(1);
  });

  it('offers to ask the assistant when nothing matched at all', async () => {
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    type('no-such-setting-anywhere');
    // The offer stands whether or not the semantic pass ran; it is the answer to "nothing at all".
    await settle();
    const ask = screen.getByRole('option', { name: /Ask AI about/ });
    expect(ask.textContent).toContain('no-such-setting-anywhere');
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('spins in the row while asking, then renders the answers as suggestions', async () => {
    server.use(http.post('*/api/search/ask', async () => {
      await delay(120);
      return HttpResponse.json({ results: [{ id: 'settings:brain:brain.maxSteps' }, { id: 'page:memory' }] });
    }));
    render(<CommandPalette />, { wrapper: W });
    openPalette();
    type('no-such-setting-anywhere');

    fireEvent.click(screen.getByRole('option', { name: /Ask AI about/ }));
    // The pending state lives IN the row: the shared Spinner, and the row taken out of the cursor.
    await waitFor(() => expect(document.querySelector('[cmdk-item] .animate-spin')).not.toBeNull());
    expect(screen.getByRole('option', { name: /Ask AI about/ })).toHaveAttribute('aria-busy', 'true');

    await waitFor(() => expect(headings()).toContain(en.common.searchSuggestions));
    expect(rowValues()).toEqual(['settings:brain:brain.maxSteps', 'page:memory']);
    // With rows to show, the empty state and its offer are gone.
    expect(screen.queryByText('No results')).not.toBeInTheDocument();
  });

  // A failed ask is reported where the question was asked. Never a toast: the palette is a transient
  // overlay, and a notification on the page underneath outlives the surface that raised it.
  it('reports an ask failure as a muted line inside the palette', async () => {
    render(<CommandPalette />, { wrapper: W }); // the default handler already refuses
    openPalette();
    type('no-such-setting-anywhere');

    fireEvent.click(screen.getByRole('option', { name: /Ask AI about/ }));
    await waitFor(() => expect(screen.getByText(en.common.searchAskFailed)).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Ask AI about/ })).not.toBeInTheDocument();
    expect(screen.getByText('No results')).toBeInTheDocument();

    // Retyping is the way back: a new question starts from a clean state.
    type('no-such-setting-either');
    expect(screen.queryByText(en.common.searchAskFailed)).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Ask AI about/ })).toBeInTheDocument();
  });
});