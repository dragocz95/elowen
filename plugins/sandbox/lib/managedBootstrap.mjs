// Read only the known script prefix. Buffered readers may consume protocol frames before exec.
export const MANAGED_BOOTSTRAP = `import os, sys
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
