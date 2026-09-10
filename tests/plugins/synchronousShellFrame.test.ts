import { describe, expect, it } from 'vitest';
import { managedShellFrame, synchronousShellFrame } from '../../plugins/sandbox/lib/managedBootstrap.mjs';

/** The two shapes a managed shell execution can take, and why they are not interchangeable.
 *
 *  A DUPLEX consumer — a language server, a CDP client — sends its first protocol frames in the same
 *  stream that carried the script. A buffered reader would swallow them, so the bootstrap reads exactly
 *  the declared number of bytes and leaves the rest of stdin for the program it execs.
 *
 *  A SYNCHRONOUS caller sends a script and reads the result. There is nothing behind the script for a
 *  reader to eat, so the bootstrap protects nothing and costs a Python interpreter start-up on every
 *  execution. `bash -s` is then the whole mechanism. */

describe('synchronous managed shell frame', () => {
  it('runs the script under the canonical managed shell with no interpreter in front of it', () => {
    const frame = synchronousShellFrame('echo hello\n');
    expect(frame.argv).toEqual(['/bin/bash', '-s']);
    // Not a POSIX shell: these scripts are bash, and quietly running them under /bin/sh would change
    // what they mean rather than fail honestly.
    expect(frame.argv[0]).not.toBe('/bin/sh');
    expect(frame.argv).not.toContain('/usr/bin/python3');
  });

  it('hands the script to the guest byte for byte', () => {
    // Multi-byte text, an emoji outside the basic plane, a CR, a tab and a trailing newline: everything
    // that a re-encoding or a line-ending fixup would quietly damage.
    const script = 'printf "%s" "přílišžluťoučký — 🜂"\r\n\tls\n';
    const frame = synchronousShellFrame(script);
    expect(frame.stdin).toEqual(Buffer.from(script, 'utf8'));
    expect(frame.stdin.toString('utf8')).toBe(script);
  });

  it('preserves NUL bytes rather than truncating the script at one', () => {
    const script = Buffer.from('echo a\u0000b\n', 'utf8');
    expect(synchronousShellFrame(script)).toMatchObject({ stdin: script });
    expect(synchronousShellFrame(script).stdin.length).toBe(script.length);
  });

  it('measures its bound in bytes, so a multi-byte script is measured as the guest receives it', () => {
    const justUnder = Buffer.alloc(1048576, 0x61);
    expect(() => synchronousShellFrame(justUnder)).not.toThrow();
    expect(() => synchronousShellFrame(Buffer.alloc(1048577, 0x61))).toThrow(/exceeds its bound/);
    // 524288 two-byte characters is 1048576 BYTES: at the limit measured correctly, over it if the
    // length were counted in characters.
    expect(() => synchronousShellFrame('č'.repeat(524288))).not.toThrow();
    expect(() => synchronousShellFrame('č'.repeat(524289))).toThrow(/exceeds its bound/);
  });

  it('treats an absent script as an empty one rather than the string "undefined"', () => {
    expect(synchronousShellFrame(undefined).stdin).toEqual(Buffer.alloc(0));
    expect(synchronousShellFrame('').stdin).toEqual(Buffer.alloc(0));
  });

  it('leaves the duplex bootstrap in place for the consumers that need it', () => {
    const frame = managedShellFrame('echo hello\n');
    expect(frame.argv[0]).toBe('/usr/bin/python3');
    // The declared byte count is what stops the bootstrap reading into the program's own protocol.
    expect(frame.argv.at(-1)).toBe(String(Buffer.byteLength('echo hello\n')));
  });
});
