import { describe, it, expect, afterEach } from 'vitest';
import { GET } from '../../../app/api/ws-config/route';

const orig = process.env.ELOWEN_WS_DIRECT_PORT;
afterEach(() => { if (orig === undefined) delete process.env.ELOWEN_WS_DIRECT_PORT; else process.env.ELOWEN_WS_DIRECT_PORT = orig; });

describe('GET /api/ws-config', () => {
  it('returns a null directPort when unset (behind a proxy / on localhost)', async () => {
    delete process.env.ELOWEN_WS_DIRECT_PORT;
    expect(await GET().json()).toEqual({ directPort: null });
  });
  it('surfaces the daemon port in proxy-less IP mode', async () => {
    process.env.ELOWEN_WS_DIRECT_PORT = '4400';
    expect(await GET().json()).toEqual({ directPort: 4400 });
  });
  it('treats a non-numeric env value as null (never trust a hand-edited unit)', async () => {
    process.env.ELOWEN_WS_DIRECT_PORT = 'nope';
    expect(await GET().json()).toEqual({ directPort: null });
  });
});
