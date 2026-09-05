import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';

/** The delegated turn as the daemon addresses it: channel key, owner, durable parent. */
const req = { channelId: 'subagent-sub-dlg-1', ownerUserId: 1, parentSessionId: 'brain-1' };
const CHILD = 'brain-ch-subagent-sub-dlg-1';

function serviceWith(extra: Record<string, unknown> = {}) {
  const registry = new LiveSessionRegistry<{ sessionId: string; session: { dispose(): void; isStreaming: boolean } }>();
  const store = { getSession: (id: string) => (id === 'brain-1' ? { id, user_id: 1 } : undefined) };
  const svc = new ChannelSessionService({ registry, store, ...extra } as never);
  return { svc, registry };
}

// The runner executes the turn body, but the abort tree, the parent/child edge and the pending-abort
// marker are in-memory here and used ACROSS sessions — so they stay in the daemon and fence the remote
// turn exactly as they fence a local one.
describe('ChannelSessionService.sendRemote — the half of a delegated turn that cannot leave the daemon', () => {
  it('registers the parent→child edge for the whole remote turn, then releases it', async () => {
    const { svc, registry } = serviceWith();
    let duringTurn = false;
    const reply = await svc.sendRemote(req, async () => {
      duringTurn = registry.hasActiveChildren('brain-1') && registry.isActiveChild(CHILD);
      return 'child done';
    });
    expect(reply).toBe('child done');
    expect(duringTurn).toBe(true); // `/stop`, status and the shutdown gate can all see the remote work
    expect(registry.hasActiveChildren('brain-1')).toBe(false);
  });

  it('releases the edge even when the remote turn fails', async () => {
    const { svc, registry } = serviceWith();
    await expect(svc.sendRemote(req, () => Promise.reject(new Error('the sub-agent runner exited')))).rejects.toThrow('runner exited');
    expect(registry.hasActiveChildren('brain-1')).toBe(false);
  });

  it('refuses to start while the parent is aborting — the fence is read before anything is forwarded', async () => {
    const { svc, registry } = serviceWith();
    registry.beginParentAbort('brain-1');
    let forwarded = false;
    await expect(svc.sendRemote(req, async () => { forwarded = true; return 'x'; })).rejects.toThrow('delegation aborted');
    expect(forwarded).toBe(false);
  });

  it('refuses a parent that does not exist or belongs to another account', async () => {
    const { svc } = serviceWith();
    await expect(svc.sendRemote({ ...req, parentSessionId: 'brain-gone' }, async () => 'x')).rejects.toThrow('invalid parent session');
    await expect(svc.sendRemote({ ...req, ownerUserId: 2 }, async () => 'x')).rejects.toThrow('invalid parent session');
  });

  // A stop that lands while the runner is working must make the child terminally unsuccessful, or its
  // partial answer is mistaken for a successful one.
  it('turns a stop that landed mid-turn into a terminal abort, not a reply', async () => {
    const { svc, registry } = serviceWith();
    await expect(svc.sendRemote(req, async () => {
      registry.requestPendingAbort(CHILD);
      return 'half an answer';
    })).rejects.toThrow('delegation aborted');
  });

  it('consumes a pending abort raised before the turn was forwarded', async () => {
    const { svc, registry } = serviceWith();
    registry.requestPendingAbort(CHILD);
    let forwarded = false;
    await expect(svc.sendRemote(req, async () => { forwarded = true; return 'x'; })).rejects.toThrow('delegation aborted');
    expect(forwarded).toBe(false);
  });

  it('reports each delegated edge to the reporter the runner mirrors upward with', async () => {
    const edges: [string, string, boolean][] = [];
    const { svc } = serviceWith({ onDelegatedEdge: (p: string, c: string, r: boolean) => edges.push([p, c, r]) });
    await svc.sendRemote(req, async () => 'done');
    expect(edges).toEqual([['brain-1', CHILD, true], ['brain-1', CHILD, false]]);
  });

  it('reports only the 0↔1 transitions of an edge held by overlapping calls — the mirror is a boolean', async () => {
    // The settle fence (dispatch/settledCall) holds the edge AROUND the turn's own hold in send(). The
    // daemon mirrors a runner's nested edges as one boolean claim per source, so an inner release reported
    // over the wire would drop the edge while the outer holder still has it — and a `/stop` on the top
    // conversation would walk past a child that is mid-settlement.
    const edges: [string, string, boolean][] = [];
    const { svc, registry } = serviceWith({ onDelegatedEdge: (p: string, c: string, r: boolean) => edges.push([p, c, r]) });
    await svc.sendRemote(req, async () => {
      await svc.sendRemote(req, async () => 'inner');
      expect(registry.isActiveChild(CHILD)).toBe(true); // the outer hold survives the inner release
      return 'outer';
    });
    expect(edges).toEqual([['brain-1', CHILD, true], ['brain-1', CHILD, false]]);
    expect(registry.isActiveChild(CHILD)).toBe(false);
  });
});

describe('ChannelSessionService.abort — reaching a child that lives in the runner', () => {
  it('sends the abort verb for a registered child with no live record here', async () => {
    const abortRemote = vi.fn();
    const { svc, registry } = serviceWith({ abortRemote });
    registry.setChildRunning('brain-1', CHILD, true); // running, but in the other process
    await svc.abort('subagent-sub-dlg-1');
    expect(abortRemote).toHaveBeenCalledWith('subagent-sub-dlg-1');
    expect(registry.hasPendingAbort(CHILD)).toBe(true); // …and the delegation is terminal here regardless
  });

  it('does not reach for the runner over a channel nothing is delegating', async () => {
    const abortRemote = vi.fn();
    const { svc } = serviceWith({ abortRemote });
    await svc.abort('subagent-sub-dlg-1');
    expect(abortRemote).not.toHaveBeenCalled();
  });
});
