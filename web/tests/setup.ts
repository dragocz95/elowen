import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Components persist UI state (last-visited section, kanban view, …) into localStorage via
// usePersistentState. jsdom keeps one localStorage for the whole file, so without this a test that
// navigates away leaks its persisted section into the next test's initial render. Reset between tests.
afterEach(() => { try { localStorage.clear(); } catch { /* no storage in this env — nothing to clear */ } });

// jsdom does not implement ResizeObserver — provide a no-op stub so Terminal
// tests (and any component using ResizeObserver) don't blow up.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement PointerEvent — Testing Library then fires a bare Event that drops the
// clientX/clientY coordinates, so pointer-drag components (ResizeHandle) can't be tested. Back it with
// MouseEvent (which does carry coordinates) and tack on the pointer fields we use.
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}
// jsdom Elements lack pointer-capture methods; our handles call them, guarded, but stub them so the
// real (non-guarded) call paths are also safe.
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

// jsdom does not implement window.matchMedia — provide a stub that defaults to
// non-mobile (matches: false) so existing tests are unaffected.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
