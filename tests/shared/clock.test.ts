import { describe, it, expect } from 'vitest';
import { FakeClock } from '../../src/shared/clock.js';

describe('FakeClock', () => {
  it('advance() triggers due intervals and moves now()', () => {
    const c = new FakeClock(1000);
    let n = 0;
    c.setInterval(() => n++, 100);
    c.advance(250);
    expect(n).toBe(2);
    expect(c.now()).toBe(1250);
  });
  it('cancel stops further ticks', () => {
    const c = new FakeClock(0); let n = 0;
    const cancel = c.setInterval(() => n++, 100);
    c.advance(100); cancel(); c.advance(500);
    expect(n).toBe(1);
  });
});
