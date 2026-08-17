import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { splitContent, extractImageRefs, imageRefName, stripThinking, parseModelExec, stripForSpeech, runtimeFooter, stripRuntimeFooter } from '../../packages/plugin-shared/format.mjs';

describe('shared plugin format helpers', () => {
  it('splitContent / extractImageRefs / stripThinking never throw on a null or undefined body (the shipped Discord/WhatsApp TypeError)', () => {
    expect(() => splitContent(null, 1990)).not.toThrow();
    expect(splitContent(undefined, 1990)).toEqual(['']);
    expect(() => extractImageRefs(undefined)).not.toThrow();
    expect(extractImageRefs(null)).toEqual({ cleaned: '', files: [] });
    expect(stripThinking(undefined)).toBe('');
  });

  it('splitContent keeps a fenced code block intact across a chunk boundary', () => {
    const body = 'before\n```js\n' + 'x'.repeat(50) + '\n```\nafter';
    const pieces = splitContent(body, 40);
    expect(pieces.length).toBeGreaterThan(1);
    // Every piece has balanced fences (the split reopens the block).
    for (const p of pieces) expect((p.match(/```/g)?.length ?? 0) % 2).toBe(0);
    // Every code character survives the split (the reopen/close fences are injected around them).
    expect((pieces.join('').match(/x/g) ?? []).length).toBe(50);
  });

  it('extractImageRefs pulls brain-image links and leaves other text, guarding path tricks', () => {
    const { cleaned, files } = extractImageRefs('see ![a](http://x/brain/images/abc123.png) and ![b](/brain/images/def.png)');
    expect(files).toEqual(['abc123.png', 'def.png']);
    expect(cleaned).not.toContain('brain/images');
    // A non-matching name (uppercase / path segment) is left untouched.
    expect(extractImageRefs('![x](/brain/images/../evil.png)').files).toEqual([]);
  });

  const UUID = '3f2b7c14-9a8d-4e6f-b0c1-2d3e4f5a6b7c';
  const SHA = 'a'.repeat(64);

  it('extractImageRefs never uploads a chat image a model merely NAMED in its prose', () => {
    // `chat-images` is one directory shared by the whole instance, holding every user's private
    // attachments. This text is written by the model, so treating a name it typed as permission to read
    // and upload that file would be an authorization decision nobody made. Shared images arrive as an
    // `image` event instead, which the daemon emits only for a file it checked ownership of.
    const r = extractImageRefs(`hle ![p](/api/brain/chat-images/${UUID}.png) a ![q](https://x/api/brain/chat-images/${SHA}.webp)`);
    expect(r.files).toEqual([]);
    // Still stripped from the text — a raw markdown link is not something to show the reader.
    expect(r.cleaned).not.toContain('chat-images');
    // The generated-image directory is unaffected: global plugin output, always reachable this way.
    expect(extractImageRefs(`![a](/api/brain/images/abc123.png) ![b](/api/brain/chat-images/${UUID}.jpg)`).files)
      .toEqual(['abc123.png']);
  });

  it('imageRefName still accepts a chat image, because that ref comes from the daemon', () => {
    expect(imageRefName(`/api/brain/chat-images/${UUID}.png`)).toBe(`${UUID}.png`);
    expect(imageRefName(`/api/brain/chat-images/${SHA}.webp`)).toBe(`${SHA}.webp`);
  });

  it('extractImageRefs refuses a chat-image name that is not exactly a stored name (it reaches the filesystem)', () => {
    for (const link of [
      '![x](/api/brain/chat-images/../../secret.png)',
      '![x](/api/brain/chat-images/%2e%2e%2fsecret.png)',
      '![x](/api/brain/chat-images//etc/passwd.png)',
      `![x](/api/brain/chat-images/${UUID}.svg)`,
      `![x](/api/brain/chat-images/${UUID}.exe)`,
      `![x](/api/brain/chat-images/${UUID.toUpperCase()}.png)`,
      '![x](/api/brain/chat-images/abc123.png)', // neither a uuid nor a sha256
    ]) {
      expect(extractImageRefs(link).files).toEqual([]);
      expect(extractImageRefs(link).cleaned).toBe(link); // left as inert text, never a file name
    }
  });

  it('imageRefName validates an image event ref down to the stored file name', () => {
    expect(imageRefName(`/api/brain/chat-images/${UUID}.png`)).toBe(`${UUID}.png`);
    expect(imageRefName(`/api/brain/chat-images/${SHA}.gif`)).toBe(`${SHA}.gif`);
    expect(imageRefName('/api/brain/images/abc123.png')).toBe('abc123.png'); // the older generated form
    expect(imageRefName('/api/brain/chat-images/../../../etc/passwd')).toBeNull();
    expect(imageRefName(`/api/brain/chat-images/${UUID}.svg`)).toBeNull();
    expect(imageRefName('/etc/passwd')).toBeNull();
    expect(imageRefName(undefined)).toBeNull();
  });

  it('stripThinking removes inline chain-of-thought; parseModelExec parses the three exec shapes', () => {
    expect(stripThinking('<think>secret</think>answer')).toBe('answer');
    expect(parseModelExec('elowen:anthropic/claude-x')).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(parseModelExec('anthropic/claude-x')).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(parseModelExec('claude-x')).toEqual({ model: 'claude-x' });
    expect(parseModelExec('')).toBeNull();
  });

  it('stripForSpeech flattens markdown to speakable prose', () => {
    expect(stripForSpeech('# Title\n`code` and [link](http://x)')).toBe('Title code and link');
    expect(stripForSpeech(null)).toBe('');
  });

  // One footer implementation now serves Discord, Telegram and WhatsApp — only the fence differs. These
  // pin each surface's fence so a change to the shared core can't silently flatten them into one look,
  // and pin the writer/reader symmetry the history strip depends on.
  describe('runtimeFooter / stripRuntimeFooter', () => {
    const FENCES = {
      discord: { open: '-# ', close: '' },
      telegram: { open: '— ', close: '' },
      whatsapp: { open: '_', close: '_' },
    };
    const idle = { model: 'alibaba/qwen3.8-max-preview', usage: { percent: 41.6 } };

    it('wraps the same bare model in each surface own markup and rounds the percent', () => {
      expect(runtimeFooter(idle, FENCES.discord)).toBe('-# qwen3.8-max-preview · 42 %');
      expect(runtimeFooter(idle, FENCES.telegram)).toBe('— qwen3.8-max-preview · 42 %');
      expect(runtimeFooter(idle, FENCES.whatsapp)).toBe('_qwen3.8-max-preview · 42 %_');
    });

    // A chat surface is not where a model gets picked or spend reconciled, so the provider is noise under
    // every answer — it belongs in the CLI status line and the web pickers instead. The split has to take
    // the FIRST separator only: a model name may itself contain a slash, and cutting at the last one would
    // silently truncate it to the final segment.
    it('drops the provider but keeps a model name that itself contains a slash', () => {
      const qualified = { model: 'openai-codex/gpt-5.6-luna', usage: { percent: 20 } };
      expect(runtimeFooter(qualified, FENCES.discord)).toBe('-# gpt-5.6-luna · 20 %');

      const nested = { model: 'ai-coresynth-io/deepseek/deepseek-v4-pro', usage: { percent: 20 } };
      expect(runtimeFooter(nested, FENCES.discord)).toBe('-# deepseek/deepseek-v4-pro · 20 %');

      // A bare model has no provider to drop and must survive untouched.
      expect(runtimeFooter({ model: 'k3', usage: { percent: 20 } }, FENCES.discord)).toBe('-# k3 · 20 %');
    });

    // Footers written before this change still sit in channel history. The reader recognises a footer by
    // its fence, not by its contents, so it must keep stripping the qualified shape too — otherwise the
    // old line feeds back into the prompt and the model starts writing footers of its own.
    it('still strips a footer that was written with the provider still in it', () => {
      expect(stripRuntimeFooter('Hotovo.\n\n-# alibaba/qwen3.8-max-preview · 42 %', FENCES.discord)).toBe('Hotovo.');
    });

    // Teams is the one surface with no subtext style for bot messages, so its footer carries no markup.
    // It still goes through the same writer: one footer shape across every platform, fence or not.
    const teams = { open: '', close: '' };

    it('writes the same footer unmarked on a surface that has no subtext style', () => {
      expect(runtimeFooter(idle, teams)).toBe('qwen3.8-max-preview · 42 %');
      expect(runtimeFooter(null, teams)).toBe('');
    });

    it('refuses to read a footer back off an unfenced surface, where every line would match', () => {
      expect(stripRuntimeFooter('Hotovo.\n\nqwen3.8-max-preview · 42 %', teams)).toBe('Hotovo.\n\nqwen3.8-max-preview · 42 %');
      expect(stripRuntimeFooter('Just one line.', teams)).toBe('Just one line.');
    });

    it('omits a percentage that is not a finite number rather than printing it', () => {
      // `percent` comes from the agent runtime's context accounting; a zero-sized window divides out to
      // Infinity, and `Infinity %` under an answer is worse than no percentage at all.
      expect(runtimeFooter({ model: 'gpt-5', usage: { percent: Infinity } }, FENCES.discord)).toBe('-# gpt-5');
      expect(runtimeFooter({ model: 'gpt-5', usage: { percent: NaN } }, FENCES.discord)).toBe('-# gpt-5');
    });

    it('renders nothing rather than an empty fence when the idle event carried no usable data', () => {
      for (const fence of Object.values(FENCES)) {
        expect(runtimeFooter(null, fence)).toBe('');
        expect(runtimeFooter({}, fence)).toBe('');
        // Either half alone still earns a footer — only a turn that reported NEITHER renders none.
        expect(runtimeFooter({ model: 'gpt-5' }, fence)).toBe(`${fence.open}gpt-5${fence.close}`);
        expect(runtimeFooter({ usage: { percent: 7 } }, fence)).toBe(`${fence.open}7 %${fence.close}`);
      }
    });

    it('takes back off exactly what it writes, on every surface', () => {
      for (const fence of Object.values(FENCES)) {
        expect(stripRuntimeFooter(`Hotovo.\n\n${runtimeFooter(idle, fence)}`, fence)).toBe('Hotovo.');
      }
    });

    it('leaves anything that is not a trailing footer of its own surface intact', () => {
      // A Discord footer is not a WhatsApp one — each reader only recognises its own fence.
      expect(stripRuntimeFooter('Hotovo.\n\n-# x · 1 %', FENCES.whatsapp)).toBe('Hotovo.\n\n-# x · 1 %');
      // A bare fence has nothing between open and close.
      expect(stripRuntimeFooter('Hotovo.\n\n_', FENCES.whatsapp)).toBe('Hotovo.\n\n_');
      expect(stripRuntimeFooter('Hotovo.\n\n-#', FENCES.discord)).toBe('Hotovo.\n\n-#');
      // Only the LAST line is a footer position; the same markup mid-body is content.
      expect(stripRuntimeFooter('— pozn\n\nHotovo.', FENCES.telegram)).toBe('— pozn\n\nHotovo.');
      expect(stripRuntimeFooter(null, FENCES.discord)).toBe('');
    });
  });
});
