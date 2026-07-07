import { describe, it, expect, vi } from 'vitest';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { sanitizePermissionSettings } from '../../src/brain/toolPermissions.js';

/** Minimal fake deps: just enough for start()/status()/setYolo() (mirrors brainService.test.ts). */
function fakeDeps(persistedYolo: boolean) {
  const session = {
    prompt: vi.fn(async () => {}), subscribe: () => () => {}, dispose: vi.fn(), abort: vi.fn(async () => {}),
    messages: [], isStreaming: false, getContextUsage: () => undefined,
    getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: vi.fn(),
    supportsThinking: () => false,
  };
  return {
    store: new BrainStore(openDb(':memory:')),
    users: { ensureAdvisorToken: () => 'tok', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    createSession: vi.fn(async () => ({ session })),
    resourceLoaderFactory: () => undefined,
    permissions: vi.fn(() => sanitizePermissionSettings({ yolo: persistedYolo })),
  };
}

describe('BrainService — session /yolo override vs the persisted default', () => {
  it('status reports the persisted default until a session override is set', async () => {
    const d = fakeDeps(true);
    const svc = new BrainService(d as never);
    await svc.start(1);
    expect(svc.status(1).yolo).toBe(true);
  });

  it('bare setYolo toggles the effective state; the override wins over the persisted default', async () => {
    const d = fakeDeps(false);
    const svc = new BrainService(d as never);
    await svc.start(1);
    expect(svc.status(1).yolo).toBe(false);
    expect(svc.setYolo(1)).toEqual({ yolo: true });        // toggle from the persisted false
    expect(svc.status(1).yolo).toBe(true);
    expect(svc.setYolo(1, false)).toEqual({ yolo: false }); // explicit off
    expect(svc.status(1).yolo).toBe(false);
  });

  it('an explicit /yolo off overrides a persisted-on default for this session', async () => {
    const d = fakeDeps(true);
    const svc = new BrainService(d as never);
    await svc.start(1);
    expect(svc.setYolo(1, false)).toEqual({ yolo: false }); // session override beats persisted true
    expect(svc.status(1).yolo).toBe(false);
  });

  it('setYolo without a live session throws (the CLI reports it as an error notice)', () => {
    const d = fakeDeps(false);
    const svc = new BrainService(d as never);
    expect(() => svc.setYolo(1)).toThrow('brain not started');
  });

  it('status without permission wiring reports yolo:false', async () => {
    const d = fakeDeps(false);
    delete (d as { permissions?: unknown }).permissions;
    const svc = new BrainService(d as never);
    await svc.start(1);
    expect(svc.status(1).yolo).toBe(false);
  });
});
