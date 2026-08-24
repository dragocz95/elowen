import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { recallMemoryBlock } from '../../src/brain/session/memoryBlock.js';
import type { MemoryService } from '../../src/brain/memoryService.js';

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000)
  .toISOString().replace('T', ' ').slice(0, 19);

function service(memories: { id: number; body: string; updated_at: string }[], overrides: {
  markRecalled?: () => void;
} = {}): { service: MemoryService; retrieve: ReturnType<typeof vi.fn> } {
  const retrieve = vi.fn().mockResolvedValue({ memories });
  return {
    retrieve,
    service: {
      retrieve,
      markRecalled: overrides.markRecalled ?? vi.fn(),
    } as unknown as MemoryService,
  };
}

const passthrough = <T>(run: () => Promise<T>): Promise<T> => run();

describe('recallMemoryBlock', () => {
  // The regression this exists for: a channel writer used to be handed the same rows as bare bullets,
  // because the room composed its own recall. Inside a single channel turn that made mid-turn recall
  // (which warns) disagree with the turn-start block (which did not), about the very same memory.
  it('warns the model that an old memory is a point-in-time observation', async () => {
    const { service: svc } = service([
      { id: 7, body: 'the daemon runs under systemd', updated_at: daysAgo(200) },
      { id: 8, body: 'today we agreed on X', updated_at: daysAgo(1) },
    ]);

    const block = await recallMemoryBlock({
      service: svc, userId: 2, text: 'how is it deployed?', enabled: true, scoped: passthrough, now: NOW,
    });

    expect(block).toContain('- the daemon runs under systemd');
    expect(block).toContain('last updated 200 days ago');
    // The fresh one is not annotated: a warning on every memory trains the model to skim past it.
    expect(block).toContain('- today we agreed on X');
    expect(block.match(/last updated/g)).toHaveLength(1);
    expect(block).toContain('<user_memories>');
  });

  it('does not touch the memory service when the turn has no writer to recall for', async () => {
    for (const opts of [
      { userId: 2, enabled: false, text: 'hello' },   // the writer switched auto-recall off
      { userId: null, enabled: true, text: 'hello' }, // an unlinked sender in a shared room
      { userId: 2, enabled: true, text: '   ' },      // nothing to retrieve against
    ]) {
      const { service: svc, retrieve } = service([{ id: 1, body: 'x', updated_at: daysAgo(1) }]);
      const block = await recallMemoryBlock({ ...opts, service: svc, scoped: passthrough, now: NOW });
      expect(block).toBe('');
      expect(retrieve).not.toHaveBeenCalled();
    }
  });

  it('keeps the recall when only its bookkeeping fails', async () => {
    const { service: svc } = service(
      [{ id: 7, body: 'still delivered', updated_at: daysAgo(1) }],
      { markRecalled: () => { throw new Error('counter write failed'); } },
    );

    const block = await recallMemoryBlock({
      service: svc, userId: 2, text: 'q', enabled: true, scoped: passthrough, now: NOW,
    });

    // The memories are already on their way to the prompt; losing them over a counter would be worse.
    expect(block).toContain('still delivered');
  });

  it('survives a retrieval failure without failing the turn', async () => {
    const svc = { retrieve: vi.fn().mockRejectedValue(new Error('embedding provider down')), markRecalled: vi.fn() };
    await expect(recallMemoryBlock({
      service: svc as unknown as MemoryService, userId: 2, text: 'q', enabled: true, scoped: passthrough,
    })).resolves.toBe('');
  });

  it('is the only place either surface renders recalled memory', () => {
    for (const file of ['src/brain/channels.ts', 'src/brain/service/turnContextBuilder.ts']) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8');
      expect(source, `${file} must recall through the shared helper`).toContain('recallMemoryBlock(');
      expect(source, `${file} renders its own memory block`).not.toContain("frameUntrusted('user_memories'");
    }
  });
});
