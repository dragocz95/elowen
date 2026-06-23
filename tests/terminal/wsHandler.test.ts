import { describe, it, expect } from 'vitest';
import { terminalWsHandler, UNSUPPORTED_CLOSE } from '../../src/terminal/wsHandler.js';
import { createTicketStore } from '../../src/terminal/ticketStore.js';
import type { PtyModule } from '../../src/terminal/ptyLoader.js';

function fakeWs() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    sent,
    get closed() { return closed; },
    ws: { send: (d: string) => sent.push(d), close: (code?: number, reason?: string) => { closed = { code, reason }; } } as any,
  };
}
const ctx = (url: string) => ({ req: { url } }) as any;
const okPty: PtyModule = { spawn: () => ({ onData: () => {}, write: () => {}, resize: () => {}, kill: () => {} }) };

describe('terminalWsHandler', () => {
  it('closes with unsupported when the ticket is unknown', async () => {
    const tickets = createTicketStore();
    const events = await terminalWsHandler({ tickets, loadPty: async () => okPty })(ctx('http://x/ws/terminal?ticket=nope'));
    const w = fakeWs();
    events.onOpen?.(new Event('open'), w.ws);
    expect(w.sent).toEqual([]); // no data frame
    expect(w.closed).toMatchObject({ code: UNSUPPORTED_CLOSE, reason: 'ticket' });
  });

  it('closes with unsupported when node-pty is unavailable', async () => {
    const tickets = createTicketStore();
    const id = tickets.issue({ session: 'orca-advisor-1', userId: 1 });
    const events = await terminalWsHandler({ tickets, loadPty: async () => null })(ctx(`http://x/ws/terminal?ticket=${id}`));
    const w = fakeWs();
    events.onOpen?.(new Event('open'), w.ws);
    expect(w.closed).toMatchObject({ code: UNSUPPORTED_CLOSE, reason: 'pty' });
  });

  it('attaches the ticket session and disposes on close', async () => {
    const tickets = createTicketStore();
    const id = tickets.issue({ session: 'orca-advisor-7', userId: 7 });
    const attached: unknown[] = [];
    let killed = false;
    const attach = ((_mod: PtyModule, opts: unknown) => {
      attached.push(opts);
      return { onData: () => {}, write: () => {}, resize: () => {}, kill: () => { killed = true; } };
    }) as typeof import('../../src/terminal/ptySession.js').attachPty;
    const events = await terminalWsHandler({ tickets, loadPty: async () => okPty, attach })(ctx(`http://x/ws/terminal?ticket=${id}`));
    const w = fakeWs();
    events.onOpen?.(new Event('open'), w.ws);
    expect(attached[0]).toMatchObject({ session: 'orca-advisor-7' });
    expect(w.closed).toBeNull(); // happy path: not closed
    events.onClose?.({} as CloseEvent, w.ws);
    expect(killed).toBe(true);
  });

  it('forwards a resize frame to resizeWindow with the ticket session', async () => {
    const tickets = createTicketStore();
    const id = tickets.issue({ session: 'orca-advisor-9', userId: 9 });
    const resized: unknown[] = [];
    const attach = ((_mod: PtyModule) =>
      ({ onData: () => {}, write: () => {}, resize: () => {}, kill: () => {} })) as typeof import('../../src/terminal/ptySession.js').attachPty;
    const resizeWindow = (session: string, cols: number, rows: number) => { resized.push([session, cols, rows]); };
    const events = await terminalWsHandler({ tickets, loadPty: async () => okPty, attach, resizeWindow })(ctx(`http://x/ws/terminal?ticket=${id}`));
    const w = fakeWs();
    events.onOpen?.(new Event('open'), w.ws);
    events.onMessage?.({ data: JSON.stringify({ type: 'resize', cols: 100, rows: 30 }) } as MessageEvent, w.ws);
    expect(resized).toEqual([['orca-advisor-9', 100, 30]]);
  });

  it('consumes the ticket exactly once', async () => {
    const tickets = createTicketStore();
    const id = tickets.issue({ session: 'orca-advisor-1', userId: 1 });
    await terminalWsHandler({ tickets, loadPty: async () => okPty })(ctx(`http://x/ws/terminal?ticket=${id}`));
    expect(tickets.consume(id)).toBeNull(); // already consumed at upgrade
  });
});
