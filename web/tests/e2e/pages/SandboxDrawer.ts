// Page object for the `/sandbox` chat drawer (web/modules/advisor/SandboxModal.tsx), the picker the
// sandbox PLUGIN contributes and the web draws through its generic plugin-picker registry.
//
// Every selector the sandbox spec uses lives here. They are the accessible names and the one testid the
// drawer itself declares — the row's `sandbox-workspace-row`, the `Use here: <label>` and
// `Workspace actions: <label>` labels, and the shared dialog chrome — so a renamed control fails here
// once instead of in every assertion.
import { type Page, type Locator } from '@playwright/test';
import { DAEMON_URL } from '../fixtures/env.ts';
import type { SandboxCall } from '../fake-daemon/handlers/sandbox.ts';

/** The English strings the drawer renders (web/lib/i18n/dictionaries/en.ts, section `sandboxModal`).
 *  Spelled out rather than imported so the spec asserts on the copy a reader actually sees. */
export const SANDBOX_TEXT = {
  title: 'Sandbox workspaces',
  activeHere: 'Active in this conversation',
  clean: 'Clean',
  create: 'New workspace',
  createSubmit: 'Create',
  label: 'Name',
  baseRef: 'Base reference',
  removeTitle: 'Remove this workspace?',
  remove: 'Remove',
  blockedNotClean: 'The workspace contains uncommitted changes or commits that exist nowhere else, so it was not removed.',
} as const;

export class SandboxDrawer {
  /** The drawer itself. `dialog` (not `alertdialog`), so the removal confirmation never matches it. */
  readonly root: Locator;
  /** The removal confirmation raised FROM the drawer — a centered alert dialog, one level deeper. */
  readonly confirm: Locator;

  constructor(readonly page: Page) {
    this.root = page.getByRole('dialog', { name: SANDBOX_TEXT.title });
    this.confirm = page.getByRole('alertdialog', { name: SANDBOX_TEXT.removeTitle });
  }

  /** Every workspace row currently rendered, across all project groups. */
  rows(): Locator {
    return this.root.getByTestId('sandbox-workspace-row');
  }

  /** The row of one workspace, found by the label it states. */
  row(label: string): Locator {
    return this.rows().filter({ hasText: label });
  }

  /** A project group's heading (the drawer groups worktrees under the repository they were cut from). */
  group(name: string): Locator {
    return this.root.getByRole('heading', { name });
  }

  /** The row's own primary action: point this conversation at that workspace. */
  useButton(label: string): Locator {
    return this.root.getByRole('button', { name: `Use here: ${label}` });
  }

  /** The row's ⋯ menu, where the destructive action lives. */
  actionsTrigger(label: string): Locator {
    return this.root.getByRole('button', { name: `Workspace actions: ${label}` });
  }

  /** Open the row's ⋯ menu and choose Remove, which asks the daemon what removal would take with it. */
  async startRemoval(label: string): Promise<void> {
    await this.actionsTrigger(label).click();
    await this.page.getByRole('menuitem', { name: SANDBOX_TEXT.remove }).click();
  }

  /** The footer button that opens the create form. */
  createButton(): Locator {
    return this.root.getByRole('button', { name: SANDBOX_TEXT.create });
  }

  /** The create form's submit. */
  createSubmit(): Locator {
    return this.root.getByRole('button', { name: SANDBOX_TEXT.createSubmit, exact: true });
  }

  /** The surface element, whose `data-presentation` is the shape `overlayDepth.tsx` resolved for it
   *  (a right-hand `drawer` with room, `fullscreen` on a phone). */
  surface(): Locator {
    return this.root;
  }

  /** The presentation the overlay resolved to. */
  async presentation(): Promise<string | null> {
    return this.root.getAttribute('data-presentation');
  }

  /** The sandbox writes the drawer posted upstream, in order (the fake daemon's `/__test/sandbox-calls`). */
  async calls(): Promise<SandboxCall[]> {
    const res = await this.page.request.get(`${DAEMON_URL}/__test/sandbox-calls`);
    const body = (await res.json()) as { calls: SandboxCall[] };
    return body.calls;
  }
}
