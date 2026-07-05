import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
// The plugin is a plain ESM module (no build step) — import it directly.
// @ts-expect-error - .mjs plugin has no type declarations
import { register, killTree, sanitize, mapResult, DetachedStdioTransport } from '../../plugins/mcp/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(here, '../fixtures/mock-mcp-server.mjs');

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return fn(); };

/** A minimal PluginContext stand-in capturing the tools/hooks the plugin registers. */
function fakeCtx(config: Record<string, unknown>) {
  const tools: { name: string; execute: (id: string, args: unknown) => Promise<unknown> }[] = [];
  const hooks: { name: string; run: (p: unknown) => unknown }[] = [];
  return {
    config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: (t: { name: string; execute: (id: string, args: unknown) => Promise<unknown> }) => tools.push(t),
    registerHook: (h: { name: string; run: (p: unknown) => unknown }) => hooks.push(h),
    tools, hooks,
  };
}

describe('mcp plugin — helpers', () => {
  it('sanitize produces a safe tool-name token', () => {
    expect(sanitize('Chrome DevTools!')).toBe('chrome_devtools');
    expect(sanitize('')).toBe('x');
  });

  it('mapResult maps MCP content to a brain tool result', () => {
    expect(mapResult({ content: [{ type: 'text', text: 'hi' }] })).toEqual({ content: [{ type: 'text', text: 'hi' }], details: { isError: false } });
    expect(mapResult({ content: [], isError: true }).details.isError).toBe(true);
  });

  it('killTree kills the whole process group (negative pid)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    killTree({ pid: 4242 });
    expect(spy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    spy.mockRestore();
  });

  it('DetachedStdioTransport frames messages by line', async () => {
    const listeners: Record<string, ((c: unknown) => void)[]> = {};
    const child = {
      stdout: { on: (ev: string, cb: (c: unknown) => void) => { (listeners[ev] ??= []).push(cb); } },
      stdin: { written: [] as string[], write(s: string) { this.written.push(s); } },
      on: () => {},
    };
    const t = new DetachedStdioTransport(child);
    const got: unknown[] = [];
    t.onmessage = (m: unknown) => got.push(m);
    await t.start();
    // Feed a complete JSON-RPC line + a split one.
    listeners.data![0]!(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0",'));
    listeners.data![0]!(Buffer.from('"id":2,"result":{}}\n'));
    expect(got).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }]);
    await t.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(child.stdin.written[0]).toContain('"method":"ping"');
    expect(child.stdin.written[0]!.endsWith('\n')).toBe(true);
  });
});

describe('mcp plugin — end-to-end connection + process-group cleanup', () => {
  it('connects a stdio MCP server, bridges its tool, and reaps the process group on reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-mcp-'));
    const pidFile = join(dir, 'grandchild.pid');
    const ctx = fakeCtx({
      servers: [{
        name: 'mock', enabled: true, transport: 'stdio',
        command: process.execPath, args: [MOCK_SERVER], env: { GRANDCHILD_PID_FILE: pidFile },
      }],
    });

    await register(ctx as never);

    // The server's `echo` tool is bridged, namespaced.
    const echo = ctx.tools.find((t) => t.name === 'mcp_mock_echo');
    expect(echo, 'bridged tool registered').toBeTruthy();
    const res = (await echo!.execute('1', { text: 'hello mcp' })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe('hello mcp');

    // The mock spawned a grandchild — it must be alive now and dead after cleanup (group kill).
    await waitFor(() => existsSync(pidFile));
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    // Fire the reload.before hook the plugin registered — it tears everything down.
    const hook = ctx.hooks.find((h) => h.name === 'plugin.reload.before');
    expect(hook, 'reload.before hook registered').toBeTruthy();
    hook!.run({});

    // No orphan: the grandchild (and its server) are gone.
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  }, 20000);
});
