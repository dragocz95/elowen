// Page object for the full-page brain chat (`/chat`, the `variant="full"` surface). This is the SINGLE
// home for every chat row/control selector — specs never hand-write a selector. All locators reference
// the `data-testid`s phase 3 adds to `BrainChatSurface.tsx` (agreed names below); the surface root is
// disambiguated from the compact dock (which shares the same component + testids) by the EXISTING
// `[data-variant="full"]` attribute on the surface's outer div.
import { type Page, type Locator, expect } from '@playwright/test';
import { DAEMON_URL } from '../fixtures/env.ts';
import { DEFAULT_SESSION_ID } from '../seed/fixtures.ts';

/** The role of a transcript turn, mirrored onto `chat-turn` as `data-role` by the renderer. */
export type ChatTurnRole = 'you' | 'assistant' | 'divider' | 'event';

export class ChatPage {
  /** The full-page surface root — scopes every selector below, so the compact dock never matches. */
  readonly root: Locator;
  readonly transcript: Locator;
  readonly composer: Locator;
  readonly sendButton: Locator;
  readonly stopButton: Locator;
  readonly historySentinel: Locator;
  readonly modelPicker: Locator;
  readonly slashMenu: Locator;

  constructor(readonly page: Page) {
    this.root = page.locator('[data-variant="full"]');
    this.transcript = this.root.getByTestId('chat-transcript');
    this.composer = this.root.getByTestId('chat-composer');
    this.sendButton = this.root.getByTestId('chat-send');
    this.stopButton = this.root.getByTestId('chat-stop');
    this.historySentinel = this.root.getByTestId('chat-history-sentinel');
    this.modelPicker = this.root.getByTestId('chat-model-picker');
    this.slashMenu = this.root.getByTestId('chat-slash-menu');
  }

  // --- Navigation / readiness ---

  /** Open `/chat` and wait for the surface to be interactive. */
  async goto(): Promise<void> {
    // Snapshot the highest open stream id BEFORE navigating: the previous test's EventSource (every spec
    // binds the same `brain-1` session) may still be draining as this one starts, so readiness must wait
    // for a NEWLY-registered stream, not match the lingering one.
    const baseline = await this.maxStreamId();
    await this.page.goto('/chat');
    await this.waitForReady(baseline);
  }

  /** The highest currently-open stream id for the bound session (0 when none). */
  private async maxStreamId(): Promise<number> {
    const res = await this.page.request.get(`${DAEMON_URL}/__test/streams?session=${DEFAULT_SESSION_ID}`);
    const body = (await res.json()) as { streams: { id: number }[] };
    return body.streams.reduce((max, s) => Math.max(max, s.id), 0);
  }

  /** The surface is ready once its transcript and composer have mounted AND THIS load's EventSource has
   *  registered on the fake daemon (a stream id past `afterId`). The stream opens asynchronously
   *  (brainStart → history → status → EventSource) well after the DOM paints, and a scripted frame emitted
   *  before it connects is dropped on the floor — so a spec must not script the stream until it is open. */
  async waitForReady(afterId = 0): Promise<void> {
    await expect(this.transcript).toBeVisible();
    await expect(this.composer).toBeVisible();
    await expect
      .poll(
        async () => {
          const res = await this.page.request.get(`${DAEMON_URL}/__test/streams?session=${DEFAULT_SESSION_ID}`);
          const body = (await res.json()) as { streams: { id: number }[] };
          return body.streams.some((s) => s.id > afterId);
        },
        { message: 'chat EventSource never registered on the fake daemon' },
      )
      .toBe(true);
  }

  // --- Composer ---

  /** Replace the composer's content. */
  async type(text: string): Promise<void> {
    await this.composer.fill(text);
  }

  /** Click the Send button (present only when not streaming and the composer is non-empty). */
  async submit(): Promise<void> {
    await this.sendButton.click();
  }

  /** Submit via the keyboard (Enter without Shift), the primary send path. */
  async submitWithEnter(): Promise<void> {
    await this.composer.press('Enter');
  }

  /** Type a message and send it in one step. */
  async sendMessage(text: string): Promise<void> {
    await this.type(text);
    await this.submit();
  }

  /** Click the Stop button (present only while a turn is streaming). */
  async stop(): Promise<void> {
    await this.stopButton.click();
  }

  // --- Transcript rows ---

  /** Every rendered turn row. */
  turns(): Locator {
    return this.root.getByTestId('chat-turn');
  }

  /** The turns of one role (`chat-turn[data-role="…"]`). */
  turnsByRole(role: ChatTurnRole): Locator {
    return this.root.locator(`[data-testid="chat-turn"][data-role="${role}"]`);
  }

  /** The last rendered turn. */
  lastTurn(): Locator {
    return this.turns().last();
  }

  /** A session-state marker row (model/mode/rename/reasoning/cwd change). */
  eventMarker(): Locator {
    return this.root.getByTestId('chat-event-marker');
  }

  // --- Tool rows (keyed by the daemon tool-call id) ---

  /** The tool pill for a given tool-call id (`chat-tool-pill[data-tool-id="…"]`). */
  toolPill(id: string): Locator {
    return this.root.locator(`[data-testid="chat-tool-pill"][data-tool-id="${id}"]`);
  }

  /** Every tool pill in the transcript (unfiltered). */
  toolPills(): Locator {
    return this.root.getByTestId('chat-tool-pill');
  }

  /** A tool's output block. Scoped to one tool-call id when given, else any output block. */
  toolOutput(id?: string): Locator {
    if (id === undefined) return this.root.getByTestId('chat-tool-output');
    return this.toolPill(id).getByTestId('chat-tool-output');
  }

  // --- Model picker ---

  /** Open the model-picker popover (its trigger carries `aria-haspopup="listbox"`). */
  async openModelPicker(): Promise<void> {
    await this.modelPicker.locator('button[aria-haspopup="listbox"]').click();
  }

  /** The picker's option rows (role="option"), available once it is open. */
  modelOptions(): Locator {
    return this.modelPicker.getByRole('option');
  }

  /** Open the picker and choose the option whose text contains `label`. */
  async selectModel(label: string): Promise<void> {
    await this.openModelPicker();
    await this.modelOptions().filter({ hasText: label }).first().click();
  }

  // --- Slash menu ---

  /** Open the slash-command menu by seeding the composer with '/'. */
  async openSlashMenu(): Promise<void> {
    await this.composer.fill('/');
    await expect(this.slashMenu).toBeVisible();
  }

  /** The slash menu's command entries. */
  slashItems(): Locator {
    return this.slashMenu.locator('button');
  }

  // --- Lazy-load ---

  /** Scroll every scrollable ancestor of the transcript (and the window) to the top, tripping the
   *  scroll-up loader — robust to whether the actual scroller is the page `<main>` or the surface's own
   *  box (fullscreen). Assert on `historySentinel` afterwards. */
  async scrollToTopForOlder(): Promise<void> {
    await this.transcript.evaluate((el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight) node.scrollTop = 0;
      }
      window.scrollTo(0, 0);
    });
  }
}
