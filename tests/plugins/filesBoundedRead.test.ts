import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(join(tmpdir(), 'elowen-files-bounded-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('files plugin — bounded text reads', () => {
  it('does not call readFileSync for an arbitrarily large text file before applying readCap', () => {
    const target = join(dir, 'large.txt');
    const pluginUrl = pathToFileURL(join(repoRoot, 'plugins/files/index.mjs')).href;
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const target = ${JSON.stringify(target)};
      fs.writeFileSync(target, 'first line\\n');
      fs.truncateSync(target, 8 * 1024 * 1024);
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (String(path) === target) throw new Error('UNBOUNDED_READ_FILE_SYNC');
        return originalReadFileSync.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      const { register } = await import(${JSON.stringify(`${pluginUrl}?bounded-read`)});
      const tools = [];
      register({
        config: { readCap: 20_000 },
        logger: { info() {} },
        registerHook() {},
        registerTool(tool) { tools.push(tool); },
        assertPathAllowed(path) { return path; },
        displayPath(path) { return path; },
        pathStateKey(path) { return path; },
        sanitizePathOutput(text) { return String(text); },
        currentAccess() { return {}; },
        currentSessionId() { return 'brain-bounded-read'; },
        defaultCwd() { return ${JSON.stringify(dir)}; },
      });
      const read = tools.find((tool) => tool.name === 'Read');
      const result = await read.execute('t', { file_path: target, limit: 1 });
      if (result.content[0].text.includes('UNBOUNDED_READ_FILE_SYNC')) process.exit(2);
      if (!result.content[0].text.includes('first line')) process.exit(3);
      process.stdout.write('ok');
    `;

    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 5_000,
    })).toBe('ok');
  });
});
