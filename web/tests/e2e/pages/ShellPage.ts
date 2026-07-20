// Page object for the app shell: navigation + route helpers + a readiness gate. The shell is the
// authenticated frame (primary nav + module content) that LoginGate opens once `/auth/me` succeeds; a
// spec waits for it before asserting on any module. Selectors here lean on stable existing landmarks
// (the `<nav>` role, next/link hrefs) — the shell itself grows no test-only ids.
import { type Page, type Locator, expect } from '@playwright/test';

export class ShellPage {
  /** The primary navigation landmark (`<nav aria-label="…">` in the sidebar). */
  readonly nav: Locator;
  /** The login form's password field — its ABSENCE is how we know the gate is open (mirror smoke spec). */
  readonly loginPassword: Locator;

  constructor(readonly page: Page) {
    this.nav = page.getByRole('navigation').first();
    this.loginPassword = page.locator('input[type="password"]');
  }

  /** Open any route by URL. */
  async goto(path = '/'): Promise<void> {
    await this.page.goto(path);
  }

  /** Open the full-page chat at `/chat`. */
  async gotoChat(): Promise<void> {
    await this.page.goto('/chat');
  }

  /** Follow a sidebar nav link by its href (e.g. `/chat`, `/dash`, `/tasks`). */
  async clickNav(href: string): Promise<void> {
    await this.nav.locator(`a[href="${href}"]`).first().click();
  }

  /** Resolve once the authenticated shell is up: the login form is gone and the nav landmark is present. */
  async waitForShell(): Promise<void> {
    await expect(this.loginPassword).toHaveCount(0);
    await expect(this.nav).toBeVisible();
  }
}
