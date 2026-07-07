import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { describe, it, expect } from 'vitest';
import { encodeMessage, MessageDecoder } from '../../src/lsp/protocol.js';
import { detectLanguage, serverForLanguage, commandExists, listServers } from '../../src/lsp/servers.js';
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

  it('lists every server once per binary (clangd covers c and cpp with one row)', () => {
    const servers = listServers();
    expect(servers.filter((s) => s.command === 'clangd')).toHaveLength(1);
    expect(new Set(servers.map((s) => s.command)).size).toBe(servers.length);
    expect(servers.some((s) => s.command === 'typescript-language-server')).toBe(true);
  });

  it('detects whether a command is on PATH (up-front, so a missing server never spawns a dead pipe)', () => {
    expect(commandExists('node', { PATH: process.env.PATH } as NodeJS.ProcessEnv)).toBe(true);
    expect(commandExists('definitely-not-a-real-binary-xyz', { PATH: process.env.PATH } as NodeJS.ProcessEnv)).toBe(false);
    expect(commandExists('anything', { PATH: '' } as NodeJS.ProcessEnv)).toBe(false);
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
      const publish = (uri: string): void => {
        const file = decodeURIComponent(uri.replace('file://', ''));
        const diags = diagnosticsByFile[file] ?? [];
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diags } }));
      };
      if (msg.method === 'initialize' && typeof msg.id === 'number') {
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
      } else if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange') {
        publish((msg.params as { textDocument: { uri: string } }).textDocument.uri);
      }
    },
    onMessage: (cb) => { onMsg = cb; },
    onExit: () => {},
    dispose: () => {},
  };
}

/** A server that completes the handshake but never publishes diagnostics — the "still indexing a big
 *  project" case the published:false contract exists for. */
function silentServer(): LspTransport {
  let onMsg: (m: JsonRpcMessage) => void = () => {};
  return {
    send: (framed) => {
      const msg = JSON.parse(framed.split('\r\n\r\n')[1]!) as JsonRpcMessage;
      if (msg.method === 'initialize' && typeof msg.id === 'number') {
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
      }
    },
    onMessage: (cb) => { onMsg = cb; },
    onExit: () => {},
    dispose: () => {},
  };
}

/** A tsserver/pyright-style server: after didOpen it first sends a `workspace/configuration` REQUEST and
 *  publishes diagnostics only once the client answers it — exactly the flow that used to stall forever
 *  because the client dropped server→client requests. Records every reply it receives. */
function configRequestingServer(diags: unknown[]): { transport: LspTransport; replies: JsonRpcMessage[] } {
  let onMsg: (m: JsonRpcMessage) => void = () => {};
  const replies: JsonRpcMessage[] = [];
  let pendingUri = '';
  const transport: LspTransport = {
    send: (framed) => {
      const msg = JSON.parse(framed.split('\r\n\r\n')[1]!) as JsonRpcMessage;
      if (msg.method === 'initialize' && typeof msg.id === 'number') {
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
      } else if (msg.method === 'textDocument/didOpen') {
        pendingUri = (msg.params as { textDocument: { uri: string } }).textDocument.uri;
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: 'cfg-1', method: 'workspace/configuration', params: { items: [{ section: 'typescript' }, { section: 'javascript' }] } }));
      } else if (msg.id === 'cfg-1' && msg.method === undefined) {
        // The client answered our request → NOW diagnostics flow (like a real server unblocking).
        replies.push(msg);
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: pendingUri, diagnostics: diags } }));
      }
    },
    onMessage: (cb) => { onMsg = cb; },
    onExit: () => {},
    dispose: () => {},
  };
  return { transport, replies };
}

/** A server whose stdio we can crash, and which counts didOpen vs didChange — for the resilience tests. */
function controllableServer(diagnosticsByFile: Record<string, unknown[]>): { transport: LspTransport; crash: () => void; opens: number; changes: number } {
  let onMsg: (m: JsonRpcMessage) => void = () => {};
  let exitCb: () => void = () => {};
  const ctl = { opens: 0, changes: 0 } as { transport: LspTransport; crash: () => void; opens: number; changes: number };
  ctl.transport = {
    send: (framed) => {
      const msg = JSON.parse(framed.split('\r\n\r\n')[1]!) as JsonRpcMessage;
      const publish = (uri: string): void => queueMicrotask(() => onMsg({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diagnosticsByFile[decodeURIComponent(uri.replace('file://', ''))] ?? [] } }));
      if (msg.method === 'initialize' && typeof msg.id === 'number') queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
      else if (msg.method === 'textDocument/didOpen') { ctl.opens++; publish((msg.params as { textDocument: { uri: string } }).textDocument.uri); }
      else if (msg.method === 'textDocument/didChange') { ctl.changes++; publish((msg.params as { textDocument: { uri: string } }).textDocument.uri); }
    },
    onMessage: (cb) => { onMsg = cb; },
    onExit: (cb) => { exitCb = cb; },
    dispose: () => {},
  };
  ctl.crash = () => exitCb();
  return ctl;
}

describe('LspClient end-to-end (fake transport)', () => {
  it('initializes, opens a doc, and returns its diagnostics', async () => {
    const transport = fakeServer({
      '/proj/a.ts': [{ severity: 1, message: 'boom', range: { start: { line: 2, character: 1 } }, source: 'ts' }],
    });
    const client = new LspClient(transport, '/proj');
    const r = await client.diagnose('/proj/a.ts', 'const x: string = 1', 'typescript', 200, 25);
    expect(r.published).toBe(true);
    expect(r.diagnostics).toEqual([{ severity: 'error', message: 'boom', line: 3, column: 2, source: 'ts' }]);
  });

  it('waits for the publish stream to settle — the semantic pass overrides the earlier empty syntax pass', async () => {
    let onMsg: (m: JsonRpcMessage) => void = () => {};
    const transport: LspTransport = {
      send: (framed) => {
        const msg = JSON.parse(framed.split('\r\n\r\n')[1]!) as JsonRpcMessage;
        if (msg.method === 'initialize' && typeof msg.id === 'number') {
          queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
        } else if (msg.method === 'textDocument/didOpen') {
          const uri = (msg.params as { textDocument: { uri: string } }).textDocument.uri;
          // Real tsserver behaviour: an empty syntax pass first, the semantic verdict shortly after.
          // Resolving on the first publish returned a false "no problems" for semantic errors.
          queueMicrotask(() => onMsg({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } }));
          setTimeout(() => onMsg({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ severity: 1, message: 'semantic', range: { start: { line: 0, character: 0 } } }] } }), 20);
        }
      },
      onMessage: (cb) => { onMsg = cb; },
      onExit: () => {},
      dispose: () => {},
    };
    const client = new LspClient(transport, '/proj');
    const r = await client.diagnose('/proj/a.ts', 'const n: number = "x"', 'typescript', 1000, 60);
    expect(r.published).toBe(true);
    expect(r.diagnostics.map((d) => d.message)).toEqual(['semantic']);
  });

  it('a published empty list is a real verdict (clean file → published:true, no diagnostics)', async () => {
    const transport = fakeServer({}); // fake publishes [] for unseeded files
    const client = new LspClient(transport, '/proj');
    const r = await client.diagnose('/proj/ok.ts', 'const x = 1', 'typescript', 50);
    expect(r).toEqual({ diagnostics: [], published: true });
  });

  it('a server that never publishes resolves with published:false — NOT a false "no problems"', async () => {
    const transport = silentServer(); // answers initialize but never publishes diagnostics
    const client = new LspClient(transport, '/proj');
    const r = await client.diagnose('/proj/slow.ts', 'const x = 1', 'typescript', 30);
    expect(r).toEqual({ diagnostics: [], published: false });
  });

  it('settles BOTH promises when two concurrent diagnose() calls await the same file', async () => {
    const transport = fakeServer({ '/proj/a.ts': [{ severity: 2, message: 'w', range: { start: { line: 0, character: 0 } } }] });
    const client = new LspClient(transport, '/proj');
    const [a, b] = await Promise.all([
      client.diagnose('/proj/a.ts', 'v1', 'typescript', 200, 25),
      client.diagnose('/proj/a.ts', 'v2', 'typescript', 200, 25),
    ]);
    expect(a.diagnostics).toHaveLength(1);
    expect(b.diagnostics).toHaveLength(1); // the earlier waiter is NOT dropped by the later one
  });

  it('sends didChange (not a second didOpen) on a re-check of the same document', async () => {
    const ctl = controllableServer({ '/proj/a.ts': [] });
    const client = new LspClient(ctl.transport, '/proj');
    await client.diagnose('/proj/a.ts', 'v1', 'typescript', 30);
    await client.diagnose('/proj/a.ts', 'v2', 'typescript', 30);
    expect(ctl.opens).toBe(1);
    expect(ctl.changes).toBe(1);
  });

  it('initializes exactly once under concurrent diagnose of different files', async () => {
    let inits = 0;
    const base = fakeServer({});
    const transport: LspTransport = { ...base, send: (framed) => { if (framed.includes('"initialize"')) inits++; base.send(framed); } };
    const client = new LspClient(transport, '/proj');
    await Promise.all([client.diagnose('/proj/a.ts', '', 'typescript', 30), client.diagnose('/proj/b.ts', '', 'typescript', 30)]);
    expect(inits).toBe(1);
  });

  it('rejects diagnose after the server exits (so the manager can evict + respawn)', async () => {
    const ctl = controllableServer({});
    const client = new LspClient(ctl.transport, '/proj');
    ctl.crash();
    expect(client.isDisposed()).toBe(true);
    await expect(client.diagnose('/proj/a.ts', '', 'typescript', 30)).rejects.toThrow();
  });

  it('answers a server workspace/configuration request (one null per item) so diagnostics unblock', async () => {
    const srv = configRequestingServer([{ severity: 1, message: 'bad', range: { start: { line: 0, character: 0 } } }]);
    const client = new LspClient(srv.transport, '/proj');
    // This resolves ONLY because the client replied to the request — a dropped reply would time out.
    const r = await client.diagnose('/proj/a.ts', 'x', 'typescript', 500, 30);
    expect(r.published).toBe(true);
    expect(r.diagnostics).toHaveLength(1);
    expect(srv.replies).toHaveLength(1);
    expect(srv.replies[0]).toMatchObject({ id: 'cfg-1', result: [null, null] });
  });

  it('answers an unknown server request with a MethodNotFound error instead of silence', async () => {
    const sent: JsonRpcMessage[] = [];
    let onMsg: (m: JsonRpcMessage) => void = () => {};
    const transport: LspTransport = {
      send: (framed) => { sent.push(JSON.parse(framed.split('\r\n\r\n')[1]!) as JsonRpcMessage); },
      onMessage: (cb) => { onMsg = cb; },
      onExit: () => {},
      dispose: () => {},
    };
    new LspClient(transport, '/proj');
    onMsg({ jsonrpc: '2.0', id: 7, method: 'window/fancyFeature', params: {} });
    const reply = sent.find((m) => m.id === 7 && m.method === undefined);
    expect(reply?.error?.code).toBe(-32601);
  });
});

describe('LspManager', () => {
  const seed = { '/proj/a.ts': [{ severity: 1, message: 'bad', range: { start: { line: 0, character: 0 } } }] };

  it('checks a known file through a spawned client', async () => {
    const mgr = new LspManager({ root: '/proj', readFile: () => 'code', spawn: () => fakeServer(seed), settleMs: 10 });
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

  it('reports unsupported-language for code Orca has no server for (never says "install")', async () => {
    const mgr = new LspManager({ root: '/proj', readFile: () => 'class X {}', spawn: () => fakeServer({}) });
    const r = await mgr.checkFile('/proj/Main.java');
    expect(r.language).toBe('java');
    expect(r.skipped).toBe('unsupported-language');
  });

  it('after the server crashes: reports server-error, then respawns a fresh client on the next check', async () => {
    let spawns = 0;
    const ctls: ReturnType<typeof controllableServer>[] = [];
    const mgr = new LspManager({ root: '/proj', readFile: () => 'x', spawn: () => { spawns++; const c = controllableServer({}); ctls.push(c); return c.transport; }, settleMs: 10 });
    await mgr.checkFile('/proj/a.ts');       // spawn #1
    ctls[0]!.crash();                        // the server dies
    const r = await mgr.checkFile('/proj/a.ts', ); // disposed client evicted → respawn #2, but it works
    expect(spawns).toBe(2);
    expect(r.skipped).toBeUndefined();
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
    const mgr = new LspManager({ root: '/proj', readFile: () => 'x', spawn: () => { spawns++; return fakeServer(seed); }, settleMs: 10 });
    await mgr.checkFile('/proj/a.ts');
    await mgr.checkFile('/proj/b.ts');
    expect(spawns).toBe(1);
  });

  it('reports no-response (never "no problems") when the server publishes nothing in time', async () => {
    const mgr = new LspManager({ root: '/proj', readFile: () => 'x', spawn: () => silentServer(), firstCheckTimeoutMs: 30, recheckTimeoutMs: 30 });
    const r = await mgr.checkFile('/proj/a.ts');
    expect(r.skipped).toBe('no-response');
    expect(formatCheckResult(r)).toContain('no verdict');
    expect(formatCheckResult(r)).not.toContain('no problems');
  });

  it('status() reports enabled/running plus per-server installed/running rows', async () => {
    const mgr = new LspManager({ root: '/proj', readFile: () => 'x', spawn: () => fakeServer(seed), exists: (cmd) => cmd === 'typescript-language-server', settleMs: 10 });
    expect(mgr.isRunning()).toBe(false);
    let s = mgr.status();
    expect(s.enabled).toBe(true);
    expect(s.running).toBe(false);
    const ts = s.servers.find((x) => x.command === 'typescript-language-server')!;
    expect(ts).toMatchObject({ label: 'TypeScript', installed: true, running: false });
    expect(s.servers.find((x) => x.command === 'gopls')).toMatchObject({ installed: false, running: false });
    // clangd registers for c AND cpp but is ONE binary → one status row.
    expect(s.servers.filter((x) => x.command === 'clangd')).toHaveLength(1);

    await mgr.checkFile('/proj/a.ts'); // spawns the TS client
    expect(mgr.isRunning()).toBe(true);
    s = mgr.status();
    expect(s.running).toBe(true);
    expect(s.servers.find((x) => x.command === 'typescript-language-server')!.running).toBe(true);

    mgr.setEnabled(false); // toggling off frees the servers → nothing runs
    s = mgr.status();
    expect(s).toMatchObject({ enabled: false, running: false });
    expect(mgr.isRunning()).toBe(false);
  });

  it('formats a result block a human/agent can read', () => {
    const block = formatCheckResult({ path: 'a.ts', language: 'typescript', server: 'TypeScript', diagnostics: [{ severity: 'error', message: 'nope', line: 3, column: 2, source: 'ts' }] });
    expect(block).toContain('a.ts: 1 error(s)');
    expect(block).toContain('error a.ts:3:2 — nope');
    expect(formatCheckResult({ path: 'a.ts', server: 'TypeScript', diagnostics: [] })).toContain('no problems');
  });
});

describe('lsp tool + /lsp toggle', () => {
  it('exposes an lsp_diagnostics tool that returns readable text (inside an allowed root)', async () => {
    const tool = buildLspTools().find((t) => t.name === 'lsp_diagnostics')!;
    expect(tool).toBeDefined();
    // A non-code path is a graceful no-op (no server spawned) regardless of install state. The tool
    // enforces the same per-user path policy as every file tool, so run under one covering the path.
    const res = await runWithPolicy(
      { allowedProjectIds: new Set([1]), allowedPaths: () => ['/tmp'] },
      () => tool.execute('c1', { path: '/tmp/readme.md' }),
    );
    expect(res.content[0]!.text).toContain('nothing to check');
  });

  it('lsp_diagnostics refuses a path outside the session policy (no file read, no server)', async () => {
    const tool = buildLspTools().find((t) => t.name === 'lsp_diagnostics')!;
    const res = await runWithPolicy(
      { allowedProjectIds: new Set([1]), allowedPaths: () => ['/tmp/only-here'] },
      () => tool.execute('c1', { path: '/etc/passwd' }),
    );
    expect(res.content[0]!.text).toMatch(/not allowed/);
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
