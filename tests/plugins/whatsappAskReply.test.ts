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

describe('whatsapp parseAskReply (ask_user_question reply parsing)', () => {
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
