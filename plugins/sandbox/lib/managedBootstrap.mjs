// Read only the known script prefix. Buffered readers may consume protocol frames before exec.
const MANAGED_BOOTSTRAP = `import os, sys
remaining = int(sys.argv[1])
if not 0 <= remaining <= 1048576:
    raise SystemExit('Invalid managed bootstrap size')
fd = os.memfd_create('elowen-script', 0)
os.set_inheritable(fd, True)
while remaining:
    chunk = os.read(0, min(remaining, 65536))
    if not chunk:
        raise SystemExit('Incomplete managed bootstrap')
    view = memoryview(chunk)
    while view:
        written = os.write(fd, view)
        view = view[written:]
    remaining -= len(chunk)
os.lseek(fd, 0, os.SEEK_SET)
os.execv('/bin/bash', ['/bin/bash', '/proc/self/fd/' + str(fd)])
`;

export function managedShellFrame(input) {
  const stdin = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  if (stdin.length > 1048576) throw new Error('Managed bootstrap exceeds its bound');
  return { stdin, argv: ['/usr/bin/python3', '-c', MANAGED_BOOTSTRAP, String(stdin.length)] };
}

/** The shape for a SYNCHRONOUS shell execution: a script in, output and an exit code out, with nothing
 *  reading the guest's stdin afterwards.
 *
 *  The bootstrap above exists for a duplex consumer — a language server, a CDP client — whose first
 *  protocol frames follow the script in the same stream and would be swallowed by a buffered reader.
 *  A synchronous caller has no such frames, so `bash -s` is the whole mechanism, and it is already the
 *  canonical managed shell that completion capture insists on. It drops a Python interpreter start-up
 *  from every such execution without introducing a shape the runtime does not already use.
 *
 *  The bound is the same one the bootstrap enforces, checked on BYTES rather than characters, so a script
 *  of multi-byte text is measured as the guest will receive it. There is no `/bin/sh` fallback: the
 *  scripts this runs are bash, and silently running them under another shell would change their meaning. */
export function synchronousShellFrame(input) {
  const stdin = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  if (stdin.length > 1048576) throw new Error('Managed shell script exceeds its bound');
  return { stdin, argv: ['/bin/bash', '-s'] };
}
