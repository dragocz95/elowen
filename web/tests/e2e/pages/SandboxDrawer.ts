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
  project: 'Project',
  createHint: 'Creating a workspace does not move this conversation into it. Choose “Use here” on its row when you want to work there.',
  baseRefUnknown: 'This project states no default branch, so enter the reference to branch from.',
  returnToProject: 'Return to project',
  returnDescription: 'This conversation is working in a workspace. Returning it sends only this conversation back to the project directory. The workspace is kept, with its branch and its files, and can be selected again at any time.',
  returned: 'This conversation is working in the project directory again. The workspace has been kept.',
  returnBlockedInUse: 'A running process is using the workspace, so this conversation still works in it. Nothing has been changed.',
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

  /** One of the app's toasts, scoped to the notification region — the page also carries Radix's own empty
   *  live region, which a bare `getByRole('status')` matches as well. */
  toast(tone: 'status' | 'alert'): Locator {
    return this.page.getByRole('region', { name: 'Notifications (F8)' }).getByRole(tone);
  }

  /** The action that sends this conversation back to its project directory. Offered only while the
   *  conversation actually works in a workspace, so its absence is itself an assertion. */
  returnButton(): Locator {
    return this.root.getByRole('button', { name: SANDBOX_TEXT.returnToProject });
  }

  /** The footer button that opens the create form. */
  createButton(): Locator {
    return this.root.getByRole('button', { name: SANDBOX_TEXT.create });
  }

  /** Choose a project in the create form. The control is the app's `SelectMenu` (a Radix select), so the
   *  option lives in a portal outside the drawer and is reached from the page. */
  async selectProject(slug: string): Promise<void> {
    await this.root.getByRole('combobox', { name: SANDBOX_TEXT.project }).click();
    await this.page.getByRole('option', { name: slug }).click();
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
