import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { managedShellFrame } from '../../plugins/sandbox/lib/managedBootstrap.mjs';

it('preserves binary duplex frames sent in the same write as the bootstrap', () => {
  const script = "exec python3 -c 'import os; os.dup2(0,3); os.dup2(1,4);\nwhile True:\n data=os.read(3,65536)\n if not data: break\n os.write(4,data)'\n";
  const framed = managedShellFrame(script);
  const payload = Buffer.alloc(150000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
  const result = spawnSync(framed.argv[0], framed.argv.slice(1), { input: Buffer.concat([framed.stdin, payload]), maxBuffer: 2 ** 20 });
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout).toEqual(payload);
  expect(framed.argv.join(' ')).not.toContain(script);
});
it('fails explicitly when the prefix ends early', () => {
  const framed = managedShellFrame('printf unexpected');
  const result = spawnSync(framed.argv[0], framed.argv.slice(1), { input: framed.stdin.subarray(0, 3), encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Incomplete managed bootstrap');
  expect(result.stdout).toBe('');
});
it('preserves shell exit status and Unicode script bytes', () => {
  const framed = managedShellFrame('printf příkaz; exit 7');
  const result = spawnSync(framed.argv[0], framed.argv.slice(1), { input: framed.stdin, encoding: 'utf8' });
  expect(result.status).toBe(7);
  expect(result.stdout).toBe('příkaz');
});
