import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');

type ParseFn = (text: string, question: { multiSelect?: boolean; custom?: boolean; options: { label: string }[] }) =>
  | { kind: 'picks'; labels: string[] }
  | { kind: 'other'; text: string }
  | null;

const load = async () => (await import(join(repoRoot, 'plugins/whatsapp/index.mjs'))) as { parseAskReply: ParseFn };

const single = { options: [{ label: 'Blue' }, { label: 'Green' }, { label: 'Red' }] };
const multi = { ...single, multiSelect: true };

describe('whatsapp parseAskReply (AskUserQuestion reply parsing)', () => {
  it('parses a bare number as that option', async () => {
    const { parseAskReply } = await load();
    expect(parseAskReply('2', single)).toEqual({ kind: 'picks', labels: ['Green'] });
    expect(parseAskReply(' 3 ', single)).toEqual({ kind: 'picks', labels: ['Red'] });
  });

  it('parses a comma list only on a multiSelect question (deduplicated)', async () => {
    const { parseAskReply } = await load();
    expect(parseAskReply('1, 3', multi)).toEqual({ kind: 'picks', labels: ['Blue', 'Red'] });
    expect(parseAskReply('1,1,2', multi)).toEqual({ kind: 'picks', labels: ['Blue', 'Green'] });
    // On single-select a comma list is not a valid pick → falls back to free text.
    expect(parseAskReply('1,3', single)).toEqual({ kind: 'other', text: '1,3' });
  });

  it('accepts free text when custom is allowed (default) and out-of-range numbers become text', async () => {
    const { parseAskReply } = await load();
    expect(parseAskReply('teal, please', single)).toEqual({ kind: 'other', text: 'teal, please' });
    expect(parseAskReply('7', single)).toEqual({ kind: 'other', text: '7' });
  });

  it('returns null (re-prompt) for unusable replies on an options-only question (custom: false)', async () => {
    const { parseAskReply } = await load();
    const strict = { ...single, custom: false };
    expect(parseAskReply('teal', strict)).toBeNull();
    expect(parseAskReply('7', strict)).toBeNull();
    expect(parseAskReply('2', strict)).toEqual({ kind: 'picks', labels: ['Green'] });
    expect(parseAskReply('', single)).toBeNull();
  });
});

type WhatsAppAdapterCtor = new (
  cfg: Record<string, unknown>, logger: unknown, state: unknown, listModels: unknown,
  imageDirs: unknown[], authDir: string, qrPngPath: string, answerQuestion: () => boolean,
) => {
  pendingAsks: Map<string, { jid: string; askerJid: string; questions: unknown[]; selected: Record<number, string[]>; createdAt: number }>;
  handleTextReply: (chatJid: string, senderJid: string, text: string, m: unknown) => Promise<boolean>;
};

const loadAdapter = async () => (await import(join(repoRoot, 'plugins/whatsapp/lib/adapter.mjs'))) as { WhatsAppAdapter: WhatsAppAdapterCtor };
const noopLog = { info() {}, warn() {}, error() {} };
const mkAdapter = async (cfg: Record<string, unknown> = {}) => {
  const { WhatsAppAdapter } = await loadAdapter();
  return new WhatsAppAdapter(cfg, noopLog, null, null, [], '', '', () => false);
};

describe('whatsapp configurable askTimeoutMs (pending AskUserQuestion TTL)', () => {
  it('unset reproduces the default (~6 min): a 60s-old pending ask is NOT pruned', async () => {
    const adapter = await mkAdapter();
    adapter.pendingAsks.set('ask1', { jid: 'other', askerJid: 'other', questions: [], selected: {}, createdAt: Date.now() - 60_000 });
    // A reply from an unrelated chat still runs the prune loop (it iterates every pending ask).
    await adapter.handleTextReply('chat', 'sender', 'hi', {});
    expect(adapter.pendingAsks.has('ask1')).toBe(true);
  });

  it('a configured askTimeoutMs overrides the default, pruning a pending ask once older than the cap', async () => {
    const adapter = await mkAdapter({ askTimeoutMs: 30000 }); // the allowed minimum (30s)
    adapter.pendingAsks.set('ask1', { jid: 'other', askerJid: 'other', questions: [], selected: {}, createdAt: Date.now() - 60_000 }); // 60s old > 30s cap
    await adapter.handleTextReply('chat', 'sender', 'hi', {});
    expect(adapter.pendingAsks.has('ask1')).toBe(false);
  });
});
