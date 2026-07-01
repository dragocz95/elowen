// Files plugin: read/write/list, each confined to the caller's accessible repos via ctx.assertPathAllowed
// (which reads the per-session Policy). A guard rejection is returned as an error text so the model can
// react, not thrown, matching how the orca_* tools surface API errors.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX = 100_000;
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'read_file', label: 'Read file',
    description: 'Read a UTF-8 text file within your accessible repositories.',
    parameters: Type.Object({ path: Type.String({ description: 'Absolute path to the file' }) }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const body = readFileSync(abs, 'utf-8');
        return ok(body.length > MAX ? `${body.slice(0, MAX)}\n…[truncated]` : body);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'write_file', label: 'Write file',
    description: 'Create or overwrite a UTF-8 text file within your accessible repositories.',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        writeFileSync(abs, p.content, 'utf-8');
        return ok(`Wrote ${Buffer.byteLength(p.content)} bytes to ${abs}`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'list_dir', label: 'List directory',
    description: 'List the entries of a directory within your accessible repositories.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => {
      try {
        const abs = ctx.assertPathAllowed(p.path);
        const entries = readdirSync(abs).map((n) => {
          try { return statSync(join(abs, n)).isDirectory() ? `${n}/` : n; } catch { return n; }
        });
        return ok(entries.join('\n') || '(empty)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.logger.info('registered read_file, write_file, list_dir');
}
