import { describe, it, expect } from 'vitest';
import { encodeMessage, MessageDecoder } from '../../src/lsp/protocol.js';
import { detectLanguage, serverForLanguage } from '../../src/lsp/servers.js';
import { parsePublishDiagnostics, LspClient, type LspTransport, type JsonRpcMessage } from '../../src/lsp/client.js';
import { LspManager, formatCheckResult } from '../../src/lsp/manager.js';
import { buildLspTools, toggleLsp, lspManager } from '../../src/brain/tools/lspTools.js';

describe('LSP protocol codec', () => {
  it('encodes with a byte-accurate Content-Length header', () => {
    const framed = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { s: 'café' } });
    const len = Number(/Content-Length: (\d+)/.exec(framed)![1]);
    const body = framed.split('\r\n\r\n')[1]!;
    expect(len).toBe(Buffer.byteLength(body, 'utf8'));
    expect(len).toBeGreaterThan(body.length - 2); // multibyte é makes bytes > chars
  });

  it('decodes a whole message', () => {
    const dec = new MessageDecoder();
    const msgs = dec.push(encodeMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    expect(msgs).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });

  it('reassembles a message split across chunks', () => {
    const dec = new MessageDecoder();
    const framed = encodeMessage({ jsonrpc: '2.0', method: 'a', params: 1 });
    expect(dec.push(framed.slice(0, 10))).toEqual([]);
    expect(dec.push(framed.slice(10, 25))).toEqual([]);
    expect(dec.push(framed.slice(25))).toEqual([{ jsonrpc: '2.0', method: 'a', params: 1 }]);
  });

  it('decodes two back-to-back messages in one chunk', () => {
    const dec = new MessageDecoder();
    const a = encodeMessage({ jsonrpc: '2.0', id: 1 });
    const b = encodeMessage({ jsonrpc: '2.0', id: 2 });
    const msgs = dec.push(a + b);
    expect(msgs.map((m) => m.id)).toEqual([1, 2]);
  });

  it('skips a corrupt frame without wedging the stream', () => {
    const dec = new MessageDecoder();
    const bad = 'Content-Length: 5\r\n\r\n{bad}';
    const good = encodeMessage({ jsonrpc: '2.0', id: 9 });
    const msgs = dec.push(bad + good);
    expect(msgs.map((m) => m.id)).toEqual([9]);
  });
});

describe('LSP server registry', () => {
  it('detects language from extension', () => {
    expect(detectLanguage('src/a.ts')).toBe('typescript');
    expect(detectLanguage('x.py')).toBe('python');
    expect(detectLanguage('main.go')).toBe('go');
    expect(detectLanguage('notes.md')).toBeNull();
    expect(detectLanguage('Makefile')).toBeNull();
  });

  it('resolves servers through aliases (tsx/jsx reuse the TS server)', () => {
    expect(serverForLanguage('typescript')?.command).toBe('typescript-language-server');
    expect(serverForLanguage('typescriptreact')?.command).toBe('typescript-language-server');
    expect(serverForLanguage('javascript')?.command).toBe('typescript-language-server');
    expect(serverForLanguage('nonsense')).toBeNull();
  });
});

describe('parsePublishDiagnostics', () => {
  it('flattens, 1-bases positions, and sorts errors first', () => {
    const { uri, diagnostics } = parsePublishDiagnostics({
      uri: 'file:///a.ts',
      diagnostics: [
        { severity: 2, message: 'unused var', range: { start: { line: 4, character: 2 } }, source: 'ts' },
        { severity: 1, message: 'type error', range: { start: { line: 0, character: 0 } }, source: 'ts', code: 2322 },
      ],
    });
    expect(uri).toBe('file:///a.ts');
    expect(diagnostics[0]).toMatchObject({ severity: 'error', line: 1, column: 1, code: '2322' });
    expect(diagnostics[1]).toMatchObject({ severity: 'warning', line: 5, column: 3 });
  });

  it('is defensive about missing fields', () => {
    const { diagnostics } = parsePublishDiagnostics({ uri: 'file:///x', diagnostics: [{ message: 'no range no severity' }] });
    expect(diagnostics[0]).toMatchObject({ severity: 'warning', line: 1, column: 1 });
  });

  it('drops entries with an empty message and tolerates junk params', () => {
    expect(parsePublishDiagnostics({ diagnostics: [{ message: '' }] }).diagnostics).toEqual([]);
    expect(parsePublishDiagnostics(null).diagnostics).toEqual([]);
  });
});

/** A fake language server: answers `initialize`, and on `didOpen` publishes the diagnostics it was seeded
 *  with for that path. Lets the client be tested end-to-end without a real binary. */
function fakeServer(diagnosticsByFile: Record<string, unknown[]>): LspTransport {
  let onMsg: (m: JsonRpcMessage) => void = () => {};
  return {
    send: (framed) => {
      const body = framed.split('\r\n\r\n')[1]!;
      const msg = JSON.parse(body) as JsonRpcMessage;
      if (msg.method === 'initialize' && typeof msg.id === 'number') {
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
      } else if (msg.method === 'textDocument/didOpen') {
        const doc = (msg.params as { textDocument: { uri: string } }).textDocument;
        const file = decodeURIComponent(doc.uri.replace('file://', ''));
        const diags = diagnosticsByFile[file] ?? [];
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics: diags } }));
      }
    },
    onMessage: (cb) => { onMsg = cb; },
    onExit: () => {},
    dispose: () => {},
  };
}

describe('LspClient end-to-end (fake transport)', () => {
  it('initializes, opens a doc, and returns its diagnostics', async () => {
    const transport = fakeServer({
      '/proj/a.ts': [{ severity: 1, message: 'boom', range: { start: { line: 2, character: 1 } }, source: 'ts' }],
    });
    const client = new LspClient(transport, '/proj');
    const diags = await client.diagnose('/proj/a.ts', 'const x: string = 1', 'typescript');
    expect(diags).toEqual([{ severity: 'error', message: 'boom', line: 3, column: 2, source: 'ts' }]);
  });

  it('resolves empty for a clean file (server stays silent past the wait)', async () => {
    const transport = fakeServer({}); // no diagnostics published
    const client = new LspClient(transport, '/proj');
    const diags = await client.diagnose('/proj/ok.ts', 'const x = 1', 'typescript', 50);
    expect(diags).toEqual([]);
  });
});

describe('LspManager', () => {
  const seed = { '/proj/a.ts': [{ severity: 1, message: 'bad', range: { start: { line: 0, character: 0 } } }] };

  it('checks a known file through a spawned client', async () => {
    const mgr = new LspManager({ root: '/proj', readFile: () => 'code', spawn: () => fakeServer(seed) });
    const r = await mgr.checkFile('/proj/a.ts');
    expect(r.language).toBe('typescript');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.severity).toBe('error');
  });

  it('skips a non-code file without spawning', async () => {
    let spawned = false;
    const mgr = new LspManager({ root: '/proj', readFile: () => '', spawn: () => { spawned = true; return fakeServer({}); } });
    const r = await mgr.checkFile('/proj/readme.md');
    expect(r.skipped).toBe('not-a-known-language');
    expect(spawned).toBe(false);
  });

  it('reports no-server-installed when spawn yields null', async () => {
    const mgr = new LspManager({ root: '/proj', readFile: () => 'x', spawn: () => null });
    const r = await mgr.checkFile('/proj/a.ts');
    expect(r.skipped).toBe('no-server-installed');
  });

  it('is a cheap no-op when disabled', async () => {
    let spawned = false;
    const mgr = new LspManager({ root: '/proj', spawn: () => { spawned = true; return fakeServer({}); } });
    mgr.setEnabled(false);
    const r = await mgr.checkFile('/proj/a.ts');
    expect(r.skipped).toBe('disabled');
    expect(spawned).toBe(false);
  });

  it('reuses one client across checks of the same server', async () => {
    let spawns = 0;
    const mgr = new LspManager({ root: '/proj', readFile: () => 'x', spawn: () => { spawns++; return fakeServer(seed); } });
    await mgr.checkFile('/proj/a.ts');
    await mgr.checkFile('/proj/b.ts');
    expect(spawns).toBe(1);
  });

  it('formats a result block a human/agent can read', () => {
    const block = formatCheckResult({ path: 'a.ts', language: 'typescript', server: 'TypeScript', diagnostics: [{ severity: 'error', message: 'nope', line: 3, column: 2, source: 'ts' }] });
    expect(block).toContain('a.ts: 1 error(s)');
    expect(block).toContain('error a.ts:3:2 — nope');
    expect(formatCheckResult({ path: 'a.ts', server: 'TypeScript', diagnostics: [] })).toContain('no problems');
  });
});

describe('lsp tool + /lsp toggle', () => {
  it('exposes an lsp_diagnostics tool that returns readable text', async () => {
    const tool = buildLspTools().find((t) => t.name === 'lsp_diagnostics')!;
    expect(tool).toBeDefined();
    // A non-code path is a graceful no-op (no server spawned) regardless of install state.
    const res = await tool.execute('c1', { path: '/tmp/readme.md' });
    expect(res.content[0]!.text).toContain('nothing to check');
  });

  it('toggle flips the shared manager state and back', () => {
    const before = lspManager().isEnabled();
    const off = toggleLsp();
    expect(off.enabled).toBe(!before);
    expect(lspManager().isEnabled()).toBe(!before);
    const on = toggleLsp();
    expect(on.enabled).toBe(before);
    expect(lspManager().isEnabled()).toBe(before);
  });
});
