'use client';

/**
 * Deprecated compatibility shim. Elowen is OLED-only, so there is no theme action to render.
 * Keeping the export temporarily lets existing shell/plugin callers migrate without a flag day.
 */
export function ThemeToggle() {
  return null;
}
