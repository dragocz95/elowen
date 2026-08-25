import { describe, it, expect } from 'vitest';
import { splitContent, extractImageRefs, imageRefName, stripThinking, parseModelExec, stripForSpeech, runtimeFooter, stripRuntimeFooter, formatColumns, formatColumnsCodeBlock, renderChatTables } from '../../packages/plugin-shared/format.mjs';

describe('shared plugin format helpers', () => {
  it('splitContent / extractImageRefs / stripThinking never throw on a null or undefined body (the shipped Discord/WhatsApp TypeError)', () => {
    expect(() => splitContent(null, 1990)).not.toThrow();
    expect(splitContent(undefined, 1990)).toEqual(['']);
    expect(() => extractImageRefs(undefined)).not.toThrow();
    expect(extractImageRefs(null)).toEqual({ cleaned: '', files: [] });
    expect(stripThinking(undefined)).toBe('');
  });

  describe('formatColumns / formatColumnsCodeBlock', () => {
    // Every case here aligns on RENDERED monospace cells. Counting UTF-16 units, code points or JS
    // characters instead each produces a plausible-looking table that is visibly ragged on a real client.
    it('aligns decomposed Czech with composed Czech instead of counting its combining marks', () => {
      // A macOS/iOS paste arrives in NFD: `ř` is `r` + U+030C, two code points but one cell. Measured by
      // code points this row over-pads by nine and shifts the whole second column.
      expect(formatColumns([
        ['Příkaz', 'Stav'],
        ['Příliš žluťoučký kůň'.normalize('NFD'), 'čeká'],
        ['Příliš žluťoučký kůň', 'hotovo'],
      ])).toBe([
        'Příkaz                Stav',
        'Příliš žluťoučký kůň  čeká',
        'Příliš žluťoučký kůň  hotovo',
      ].join('\n'));
    });

    it('counts emoji, ZWJ sequences and East Asian glyphs as the two cells they render as', () => {
      expect(formatColumns([
        ['Příkaz', 'Stav'],
        ['Žluťoučký 🐎', 'hotovo'],
        ['rodina 👨‍👩‍👧', 'ok'],
        ['日本語', 'ok'],
      ])).toBe([
        'Příkaz        Stav',
        'Žluťoučký 🐎  hotovo',
        'rodina 👨‍👩‍👧     ok',
        '日本語        ok',
      ].join('\n'));
    });

    it('truncates on one line at a grapheme boundary, never inside a cluster', () => {
      // Cutting by code point halves the ZWJ family into a different emoji, and strands the caron of `ť`.
      expect(formatColumns([['👨‍👩‍👧‍👦 rodina a další text'], ['x']], { maxWidth: 6 }))
        .toBe('👨‍👩‍👧‍👦 ro…\nx');
      expect(formatColumns([['Příliš žluťoučký'.normalize('NFD')], ['x']], { maxWidth: 8 }))
        .toBe('Příliš …\nx');
      // A two-cell glyph is dropped whole rather than half-rendered when only one cell is left.
      expect(formatColumns([['日本語テキスト'], ['x']], { maxWidth: 5 })).toBe('日本…\nx');
    });

    it('truncates long cells with an ellipsis and keeps every row within maxWidth', () => {
      const result = formatColumns([
        ['Příkaz', 'Popis'],
        ['/reasoning', 'nastavit úroveň uvažování pro tento kanál'],
      ], { maxWidth: 20 });

      expect(result).toBe('Příkaz     Popis\n/reasoni…  nastavit…');
      expect(result.split('\n')).toHaveLength(2);
    });

    it('neutralizes a fence terminator and invisible controls carried in a cell', () => {
      // The model can put a ``` block in a description. Left intact it closes the surrounding fence and
      // corrupts the fence parity splitContent relies on, so the rest of the message renders as raw text.
      const block = formatColumnsCodeBlock([['/x', '```js\nrm -rf /\n```']]);
      expect(block).toBe('```\n/x  `js rm -rf / `\n```');
      expect(block.match(/```/g)).toHaveLength(2);
      // Bidi overrides and zero-width spaces would silently reorder or pad a rendered line.
      expect(formatColumns([['a\u202Eb\u200Bc', 'x'], ['plain', 'y']])).toBe('a b c  x\nplain  y');
    });

    it('returns no table for empty rows and omits columns whose every value is empty', () => {
      expect(formatColumns([])).toBe('');
      expect(formatColumns([['', ''], ['', '']])).toBe('');
      expect(formatColumns([['Příkaz', '', 'Stav'], ['/new', '', 'ano']]))
        .toBe('Příkaz  Stav\n/new    ano');
      expect(formatColumnsCodeBlock([])).toBe('');
    });

    it('wraps a non-empty table in one shared fenced monospace block', () => {
      expect(formatColumnsCodeBlock([['A', 'B'], ['1', '2']], { gap: 1 }))
        .toBe('```\nA B\n1 2\n```');
    });

    it('fails loudly when the requested width cannot fit one cell per column', () => {
      expect(() => formatColumns([['A', 'B', 'C']], { maxWidth: 4, gap: 1 }))
        .toThrow('cannot fit 3 columns');
    });

    it('rejects a row that is not an array instead of rendering it as a blank line', () => {
      expect(() => formatColumns(['nope' as unknown as string[], ['a', 'b']]))
        .toThrow('row 0 is not an array');
    });
  });

  describe('renderChatTables', () => {
    it('leaves a markdown table inside a fenced block byte-for-byte untouched', () => {
      const text = 'Before\n```md\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\nAfter';
      expect(renderChatTables(text, { fence: true })).toBe(text);
    });

    it('leaves a pipe-containing log line and a header without body rows untouched', () => {
      const log = '2026-08-25T11:00:00Z INFO worker | request=7 | done';
      expect(renderChatTables(log, { fence: false })).toBe(log);
      const empty = '| A | B |\n| --- | --- |';
      expect(renderChatTables(empty, { fence: false })).toBe(empty);
    });

    it('converts a real table, strips inline markdown and preserves surrounding text exactly', () => {
      const text = 'Before\r\n\r\n| Name | State |\r\n| --- | --- |\r\n| **Ada** | [`ready`](https://example.test) |\r\n\r\nAfter';
      expect(renderChatTables(text, { fence: true })).toBe([
        'Before\r\n\r\n```\nName  State\nAda   ready\n```\r\n\r\nAfter',
      ].join(''));
    });

    it('honours left, center and right alignment markers', () => {
      const rendered = renderChatTables([
        '| Left | Center | Right |',
        '| :-- | :-: | --: |',
        '| a | b | c |',
      ].join('\n'), { fence: false });
      const [header, body] = rendered.split('\n');
      expect(body.indexOf('a')).toBe(header.indexOf('Left'));
      expect(body.indexOf('b')).toBe(header.indexOf('Center') + 2);
      expect(body.indexOf('c')).toBe(header.indexOf('Right') + 4);
    });

    it('unescapes an escaped pipe inside a cell', () => {
      expect(renderChatTables('| A | B |\n| --- | --- |\n| x\\|y | z |', { fence: false }))
        .toBe('A    B\nx|y  z');
    });

    it('emits no backticks when fence is false', () => {
      const rendered = renderChatTables('| A | B |\n| --- | --- |\n| 1 | 2 |', { fence: false });
      expect(rendered).toBe('A  B\n1  2');
      expect(rendered).not.toContain('```');
    });

    it('uses stacked records when columns would hide more than half of a measured cell', () => {
      const rendered = renderChatTables([
        '| Key | Details |',
        '| --- | --- |',
        '| A | abcdefghijklmnopqrstuvwxyz |',
        '| B | another long value for mobile |',
      ].join('\n'), { fence: false, maxWidth: 16 });
      expect(rendered).toBe([
        'Key: A',
        'Details: abcdef…',
        '',
        'Key: B',
        'Details: anothe…',
      ].join('\n'));
    });

    it('returns malformed input unchanged instead of throwing into the send path', () => {
      const malformed = '| A | B |\n| --- | nope |\n| 1 | 2 |';
      expect(() => renderChatTables(malformed, { fence: true })).not.toThrow();
      expect(renderChatTables(malformed, { fence: true })).toBe(malformed);
      expect(renderChatTables(malformed, { fence: true, maxWidth: 0 })).toBe(malformed);
    });

    it('renders before splitting so a long fenced table becomes balanced code blocks with stable columns', () => {
      const table = [
        '| Name | State |',
        '| --- | --- |',
        ...Array.from({ length: 10 }, (_, index) => `| row-${index} | value-${index} |`),
      ].join('\n');
      const pieces = splitContent(renderChatTables(table, { fence: true, maxWidth: 32 }), 60);
      expect(pieces.length).toBeGreaterThan(1);
      for (const piece of pieces) expect((piece.match(/```/g)?.length ?? 0) % 2).toBe(0);
      const rows = pieces.flatMap((piece) => piece.split('\n')).filter((line) => line.startsWith('row-'));
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((line) => line.indexOf('value-')))).toEqual(new Set([7]));
    });
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
