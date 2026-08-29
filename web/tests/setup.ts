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
    // Radix gates every pointer-driven behaviour behind `event.pointerType === 'mouse'` — item
    // highlight on pointer move, submenu hover-intent, the whole hover contract. Dropping this field
    // made all of it untestable and made a working menu look like a broken one. It defaults to empty
    // rather than 'mouse' so a test has to say which pointer it is simulating, which is the
    // distinction the components branch on.
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? '';
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

// Radix primitives probe these two before they will move focus into an open overlay, and jsdom
// implements neither: `hasPointerCapture` decides whether a pointer interaction is still being
// tracked, and `scrollIntoView` is how a highlighted item is brought into view. Missing, the first
// throws and the second is simply absent, and in both cases the item never receives focus — which
// looks in a test exactly like a keyboard contract that does not work.
if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Radix `Avatar` renders its image only once loading has SUCCEEDED, which it decides from
// `image.complete && image.naturalWidth > 0` — and jsdom never fetches a resource, so both stay false
// forever and every avatar in every test falls back to its monogram. The behaviour under test is right
// (a broken URL should degrade to initials rather than a blank square); what is missing is a browser.
// Treating "has a src" as "loaded" restores the distinction the component actually branches on, and
// leaves a src-less avatar correctly reported as not loaded.
if (typeof HTMLImageElement !== 'undefined') {
  const loaded = function (this: HTMLImageElement) { return Boolean(this.getAttribute('src')); };
  const naturalSize = function (this: HTMLImageElement) { return this.getAttribute('src') ? 1 : 0; };
  Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: loaded });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: naturalSize });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: naturalSize });
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
