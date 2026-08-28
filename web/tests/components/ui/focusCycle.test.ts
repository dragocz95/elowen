import { describe, expect, it, afterEach } from 'vitest';
import { cycleTabFocus } from '../../../components/ui/focusCycle';

/** The one implementation of the Tab cycle, shared by every modal and both navigation sheets. */
describe('cycleTabFocus', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  const mount = (html: string) => {
    const container = document.createElement('div');
    container.tabIndex = -1;
    container.innerHTML = html;
    document.body.append(container);
    return container;
  };

  const tab = (container: HTMLElement, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    cycleTabFocus(event, container);
    return event;
  };

  it('wraps from the last control back to the first, and back again with Shift', () => {
    const container = mount('<button id="a">A</button><button id="b">B</button>');
    const [a, b] = [document.getElementById('a')!, document.getElementById('b')!];

    b.focus();
    expect(tab(container).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);

    expect(tab(container, true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
  });

  // The command palette's listbox is a stack of `role="option"` BUTTONS held out of the tab order with
  // `tabindex="-1"`, because the combobox above them owns the selection through `aria-activedescendant`.
  // Counting them as stops made the cycle believe the last option was the last stop: it never wrapped at
  // the real one, so Tab from the input walked out of a dialog that promised `aria-modal`.
  it('ignores controls held out of the tab order with tabindex="-1"', () => {
    const container = mount(
      '<input id="q" /><button role="option" tabindex="-1">One</button><button role="option" tabindex="-1">Two</button>',
    );
    const input = document.getElementById('q')!;

    input.focus();
    const event = tab(container);
    expect(event.defaultPrevented, 'the only stop is also the last stop, so Tab must wrap here').toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('holds focus on the container when it has no stops at all', () => {
    const container = mount('<p>Nothing focusable.</p>');
    document.body.focus();
    expect(tab(container).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(container);
  });

  it('brings focus back on the next Tab when it has escaped the container', () => {
    const container = mount('<button id="a">A</button><button id="b">B</button>');
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    expect(tab(container).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('a'));
  });
});
