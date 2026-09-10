import base64
import ctypes
import datetime
from bisect import insort
import fnmatch
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import time

MAX_BYTES = 524288
MAX_ENTRIES = 10000
SAFE_INT = 9007199254740991


def fail(code, message):
    error = RuntimeError(message)
    error.code = code
    raise error


def path(value):
    if not isinstance(value, str) or not value.startswith('/') or '\x00' in value or len(value) > 4096:
        fail('invalid_path', 'An absolute guest path is required')
    return os.path.normpath(value)


def bounded(value, low, high):
    if type(value) is not int or not low <= value <= high:
        fail('invalid_limit', 'Invalid guest operation bound')
    return value


def version(name, follow=False):
    info = os.stat(name) if follow else os.lstat(name)
    digest = hashlib.sha256()
    digest.update(f'{info.st_dev}:{info.st_ino}:{info.st_mode}:{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}'.encode())
    if stat.S_ISREG(info.st_mode):
        with open(name, 'rb') as stream:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                digest.update(chunk)
        current = os.stat(name) if follow else os.lstat(name)
        if (current.st_ino, current.st_mtime_ns, current.st_size) != (info.st_ino, info.st_mtime_ns, info.st_size):
            fail('version_conflict', 'File changed while reading')
    elif stat.S_ISLNK(info.st_mode):
        digest.update(os.readlink(name).encode())
    return digest.hexdigest()


def entry(name, with_version=True):
    # The version hashes the whole file, which is what makes an entry authoritative enough to write
    # against and dead weight for a caller that only wants names and modification times. When it is
    # omitted the key is ABSENT rather than null, so nothing can mistake a skipped hash for a computed
    # one and write against it.
    info = os.lstat(name)
    kind = 'file' if stat.S_ISREG(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'other'
    record = {'path': name, 'kind': kind, 'size': info.st_size,
              'modifiedAt': datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).isoformat()}
    if with_version:
        record['version'] = version(name)
    return record


def expected(name, value, follow=False):
    exists = os.path.exists(name) if follow else os.path.lexists(name)
    if value is None:
        if exists:
            fail('version_conflict', 'Destination already exists')
    elif not isinstance(value, str) or not exists or version(name, follow) != value:
        fail('version_conflict', 'Content version no longer matches')


def sync_directory(name):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def ensure_ancestors(target):
    # An upload used to assume its destination directory already existed, so uploading into a new folder
    # failed later — when the first chunk opened its candidate file in a directory that was not there —
    # as a raw errno from the middle of a transfer. The ancestry is built here instead, with the SAME
    # durability the mkdir operation gives it: mode 0700, and each new directory's PARENT fsynced, so the
    # entry survives a crash rather than merely existing in the page cache.
    missing = []
    probe = os.path.dirname(target)
    while not os.path.isdir(probe):
        # Something is already there and it is not a directory. That is a conflict the caller can read
        # and act on, not an errno surfacing from deep inside the transfer.
        if os.path.lexists(probe):
            fail('not_directory', 'Upload destination is inside something that is not a directory')
        missing.append(probe)
        higher = os.path.dirname(probe)
        if higher == probe:
            fail('invalid_path', 'Upload destination has no reachable root')
        probe = higher
    for directory in reversed(missing):
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            # Another writer built the same ancestry first. That is success, not conflict — unless what it
            # created is not a directory.
            if not os.path.isdir(directory):
                fail('not_directory', 'Upload destination is inside something that is not a directory')
            continue
        sync_directory(os.path.dirname(directory))


def upload(op, name):
    import fcntl
    import shutil
    identity = op.get('uploadId')
    scope = op.get('scope')
    if not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{32}', identity) or not isinstance(scope, dict):
        fail('upload_forbidden', 'A trusted upload binding is required')
    root = path(os.environ.get('ELOWEN_UPLOAD_ROOT', '/data/.elowen-uploads'))
    os.makedirs(root, mode=0o700, exist_ok=True)
    if os.path.realpath(root) != root:
        fail('upload_forbidden', 'Upload storage must not be a symlink')
    folder = os.path.join(root, identity)
    kind = op['kind']
    if kind == 'write-begin':
        os.makedirs(folder, mode=0o700, exist_ok=True)
    if not os.path.lexists(folder) and kind == 'write-abort':
        return {'kind': kind, 'aborted': True}
    lock = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        metadata = os.path.join(folder, 'metadata.json')
        def save(value):
            fd, temporary = tempfile.mkstemp(prefix='.metadata-', dir=folder)
            try:
                with os.fdopen(fd, 'w') as stream:
                    json.dump(value, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, metadata)
                sync_directory(folder)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        def digest(file):
            result = hashlib.sha256()
            with open(file, 'rb') as stream:
                for data in iter(lambda: stream.read(65536), b''):
                    result.update(data)
            return result.hexdigest()
        if os.path.exists(metadata):
            with open(metadata) as stream:
                state = json.loads(stream.read(65537))
            if state['scope'] != scope or state['path'] != name:
                fail('upload_forbidden', 'Upload belongs to another execution scope')
            for key in ['expectedVersion', 'size', 'resolvedPath']:
                if key in op and op[key] is not None and op[key] != state[key]:
                    fail('upload_forbidden', 'Upload binding changed')
        elif kind == 'write-begin':
            size = bounded(op.get('size'), 0, SAFE_INT)
            target = os.path.realpath(name)
            # The compare-and-swap runs FIRST, so a refused upload leaves no directories behind, and the
            # resolution recorded below is taken after the ancestry exists — which is what the drift check
            # before every later step compares against.
            expected(target, op.get('expectedVersion'), True)
            ensure_ancestors(target)
            state = {'scope': scope, 'path': name, 'resolvedPath': target, 'size': size,
                     'expectedVersion': op.get('expectedVersion'), 'prepared': None, 'result': None}
            save(state)
        elif kind == 'write-abort':
            shutil.rmtree(folder)
            sync_directory(root)
            return {'kind': kind, 'aborted': True}
        else:
            fail('upload_unknown', 'Upload metadata is unavailable')
        target = state['resolvedPath']
        candidate = os.path.join(os.path.dirname(target), '.elowen-upload-' + identity)
        def discard_candidate():
            if not os.path.lexists(candidate):
                return
            info = os.lstat(candidate)
            prepared = state['prepared']
            if not prepared or [info.st_dev, info.st_ino] != prepared['inode'] or not stat.S_ISREG(info.st_mode):
                fail('upload_cleanup_unverified', 'Upload candidate identity changed')
            os.unlink(candidate)
            sync_directory(os.path.dirname(candidate))
        if kind == 'write-abort':
            discard_candidate()
            shutil.rmtree(folder)
            sync_directory(root)
            return {'kind': kind, 'aborted': True}
        if state['result']:
            if kind == 'write-commit':
                return state['result']
            fail('upload_completed', 'Upload is already committed')
        if os.path.realpath(name) != target:
            fail('resolution_drift', 'Upload destination was retargeted')
        def received():
            total = 0
            with os.scandir(folder) as items:
                for item in items:
                    if item.name.isdigit():
                        info = item.stat(follow_symlinks=False)
                        if not stat.S_ISREG(info.st_mode):
                            fail('upload_invalid', 'Upload chunk is not regular')
                        total += info.st_size
            return total
        if kind == 'write-begin':
            return {'kind': kind, 'uploadId': identity, 'chunkSize': MAX_BYTES, 'received': received(), 'resolvedPath': target}
        if kind == 'write-chunk':
            offset = bounded(op.get('offset'), 0, max(0, state['size'] - 1))
            data = base64.b64decode(op.get('base64'), validate=True)
            if offset % MAX_BYTES or not data or len(data) != min(MAX_BYTES, state['size'] - offset):
                fail('upload_invalid', 'Invalid upload chunk boundary')
            chunk = os.path.join(folder, str(offset))
            if os.path.lexists(chunk):
                if not stat.S_ISREG(os.lstat(chunk).st_mode):
                    fail('upload_invalid', 'Upload chunk identity changed')
                with open(chunk, 'rb') as stream:
                    if stream.read(MAX_BYTES + 1) != data:
                        fail('chunk_conflict', 'Upload chunk already contains different bytes')
            else:
                fd, temporary = tempfile.mkstemp(prefix='.chunk-', dir=folder)
                try:
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, chunk)
                    sync_directory(folder)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            return {'kind': kind, 'received': received()}
        if kind != 'write-commit':
            fail('invalid_operation', 'Invalid upload action')
        prepared = state['prepared']
        if prepared and prepared.get('hash') and os.path.exists(target):
            info = os.stat(target)
            if [info.st_dev, info.st_ino] == prepared['inode'] and digest(target) == prepared['hash']:
                state['result'] = {'kind': kind, 'entry': entry(target)}
                save(state)
                return state['result']
        expected(target, state['expectedVersion'], True)
        for offset in range(0, state['size'], MAX_BYTES):
            chunk = os.path.join(folder, str(offset))
            if not os.path.exists(chunk) or not stat.S_ISREG(os.lstat(chunk).st_mode) or os.stat(chunk).st_size != min(MAX_BYTES, state['size'] - offset):
                fail('upload_incomplete', 'Upload is missing a complete chunk')
        discard_candidate()
        fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            info = os.fstat(stream.fileno())
            state['prepared'] = {'inode': [info.st_dev, info.st_ino], 'hash': None}
            save(state)
            content = hashlib.sha256()
            for offset in range(0, state['size'], MAX_BYTES):
                with open(os.path.join(folder, str(offset)), 'rb') as chunk:
                    for data in iter(lambda: chunk.read(65536), b''):
                        stream.write(data)
                        content.update(data)
            if os.path.exists(target):
                os.fchmod(stream.fileno(), stat.S_IMODE(os.stat(target).st_mode))
            stream.flush()
            os.fsync(stream.fileno())
            state['prepared']['hash'] = content.hexdigest()
            save(state)
        expected(target, state['expectedVersion'], True)
        if os.path.realpath(name) != target:
            fail('resolution_drift', 'Upload destination was retargeted')
        os.replace(candidate, target)
        sync_directory(os.path.dirname(target))
        state['result'] = {'kind': kind, 'entry': entry(target)}
        save(state)
        return state['result']
    finally:
        os.close(lock)


def run(op):
    kind = op.get('kind')
    name = path(op.get('path'))
    if kind in ['write-begin', 'write-chunk', 'write-commit', 'write-abort']:
        return upload(op, name)
    if kind == 'export-manifest':
        root = os.path.realpath(name)
        if not os.path.isdir(root):
            fail('not_directory', 'Publication source must be a directory')
        entries = []
        stack = [root]
        total = 0
        while stack:
            current = stack.pop()
            with os.scandir(current) as scan:
                for item in scan:
                    if item.name == '.git':
                        continue
                    relative = os.path.relpath(item.path, root)
                    info = os.lstat(item.path)
                    mode = stat.S_IMODE(info.st_mode)
                    record = {'path': relative, 'mode': mode}
                    if stat.S_ISLNK(info.st_mode):
                        target = os.readlink(item.path)
                        resolved = os.path.normpath(os.path.join(os.path.dirname(relative), target))
                        if os.path.isabs(target) or resolved == '..' or resolved.startswith('../'):
                            fail('unsafe_symlink', 'Publication symlink leaves the exported tree')
                        record.update(kind='symlink', target=target)
                    elif stat.S_ISDIR(info.st_mode):
                        record.update(kind='directory')
                        stack.append(item.path)
                    elif stat.S_ISREG(info.st_mode):
                        if mode & 0o7000:
                            fail('unsafe_mode', 'Publication refuses special permission bits')
                        record.update(kind='file', size=info.st_size, version=version(item.path))
                        total += info.st_size
                    else:
                        fail('unsupported_entry', 'Publication supports regular files, directories and safe relative symlinks')
                    entries.append(record)
                    if len(entries) > MAX_ENTRIES or total > 17179869184:
                        fail('export_limit', 'Publication exceeds its bounded transport')
        entries.sort(key=lambda value: value['path'])
        return {'kind': kind, 'root': root, 'mode': stat.S_IMODE(os.stat(root).st_mode), 'entries': entries}
    if kind == 'stat':
        follow = op.get('followSymlinks', False)
        if type(follow) is not bool:
            fail('invalid_operation', 'followSymlinks must be boolean')
        try:
            target = os.path.realpath(name, strict=True) if follow else name
        except FileNotFoundError:
            return {'kind': kind, 'entry': None}
        return {'kind': kind, 'entry': entry(target) if os.path.lexists(target) else None}
    if kind == 'list':
        limit = bounded(op.get('limit'), 1, 1000)
        # `version` hashes a file's entire contents, so a plain listing of a source directory read and
        # hashed every file in it to answer a question about names. `metadata` True asks for the cheap
        # answer — path, kind, size, modification time — and is the only shape a caller may use when it
        # is not going to write against what it saw.
        metadata = op.get('metadata', False)
        if type(metadata) is not bool:
            fail('invalid_operation', 'metadata must be boolean')
        cursor = op.get('cursor')
        if cursor is not None and (not isinstance(cursor, str) or not cursor or len(cursor) > 4096):
            fail('invalid_cursor', 'Invalid list cursor')
        selected = []
        with os.scandir(name) as scan:
            for item in scan:
                if cursor is not None and item.name <= cursor:
                    continue
                insort(selected, item.name)
                if len(selected) > limit + 1:
                    selected.pop()
        truncated = len(selected) > limit
        page = selected[:limit]
        return {'kind': kind, 'entries': [entry(os.path.join(name, item), not metadata) for item in page],
                'truncated': truncated, 'nextCursor': page[-1] if truncated else None}
    if kind == 'read':
        cap = bounded(op.get('maxBytes'), 1, MAX_BYTES)
        offset = bounded(op.get('offset', 0), 0, SAFE_INT)
        length = bounded(op.get('length', cap), 0, cap)
        target = os.path.realpath(name)
        if not stat.S_ISREG(os.stat(target).st_mode):
            fail('not_regular_file', 'Only regular files can be read')
        before = version(target)
        with open(target, 'rb') as stream:
            total = os.fstat(stream.fileno()).st_size
            stream.seek(offset)
            data = stream.read(length)
        if version(target) != before:
            fail('version_conflict', 'File changed while reading')
        return {'kind': kind, 'base64': base64.b64encode(data).decode(), 'version': before, 'totalBytes': total}
    if kind == 'write':
        target = os.path.realpath(name)
        value = op.get('base64')
        if not isinstance(value, str) or len(value) > (MAX_BYTES * 4 // 3 + 4):
            fail('file_too_large', 'Write exceeds the guest transport limit')
        data = base64.b64decode(value, validate=True)
        if len(data) > MAX_BYTES:
            fail('file_too_large', 'Write exceeds the guest transport limit')
        expected(target, op.get('expectedVersion'), True)
        parent = os.path.dirname(target)
        # A DISTINCT answer for the one recoverable reason a write cannot start, so the host can try the
        # write first and build the tree only when this is what came back. Walking the ancestry ahead of
        # every write cost a guest round trip per write to learn what is almost always already true.
        if not os.path.isdir(parent):
            fail('parent_missing', 'Parent directory does not exist: ' + parent)
        mode = stat.S_IMODE(os.stat(target).st_mode) if os.path.exists(target) else 0o600
        fd, temporary = tempfile.mkstemp(prefix='.elowen-write-', dir=parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
            expected(target, op.get('expectedVersion'), True)
            if os.path.realpath(name) != target:
                fail('version_conflict', 'Symlink target changed while writing')
            os.replace(temporary, target)
            sync_directory(parent)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {'kind': kind, 'entry': entry(target)}
    if kind == 'mkdir':
        os.mkdir(name, 0o700)
        sync_directory(os.path.dirname(name))
        return {'kind': kind, 'entry': entry(name)}
    if kind == 'remove':
        expected(name, op.get('expectedVersion'))
        if os.path.isdir(name) and not os.path.islink(name):
            os.rmdir(name)
        else:
            os.unlink(name)
        sync_directory(os.path.dirname(name))
        return {'kind': kind, 'removed': True}
    if kind == 'rename':
        destination = path(op.get('destination'))
        expected(name, op.get('expectedVersion'))
        libc = ctypes.CDLL(None, use_errno=True)
        result = libc.renameat2(-100, os.fsencode(name), -100, os.fsencode(destination), 1)
        if result != 0:
            number = ctypes.get_errno()
            raise OSError(number, os.strerror(number))
        sync_directory(os.path.dirname(name))
        sync_directory(os.path.dirname(destination))
        return {'kind': kind, 'entry': entry(destination)}
    if kind == 'walk':
        # One traversal, inside the guest. Driving it from the host cost a round trip per directory, and
        # each of those is a container execution — a tree of four directories was five crossings before
        # a single name had been matched. Nothing here is written against, so no content is read and no
        # version is computed: a path and a modification time is the whole answer.
        # `limit` bounds every entry the traversal LOOKS AT, not the subset it chooses to return. A
        # directory and a symlink cost the same work to examine as a file, so counting only files let a
        # walk wander through any number of them and still answer "complete".
        limit = bounded(op.get('limit'), 1, MAX_ENTRIES + 1)
        # Levels of descent BELOW the root. 0 lists the root's own children and goes no deeper, which is
        # what expanding one directory in an editor asks for.
        max_depth = bounded(op.get('maxDepth', 64), 0, 64)
        skip = op.get('skip', [])
        if not isinstance(skip, list) or len(skip) > 64 or any(
                not isinstance(item, str) or not item or len(item) > 255 or '/' in item or '\x00' in item for item in skip):
            fail('invalid_operation', 'Invalid skip list')
        skipped = set(skip)

        # The requested path decides the answer before any traversal: absent is reported as such so the
        # host needs no separate stat, and a path that is not a directory is traversed from its parent,
        # which is the behaviour Glob has always had.
        if not os.path.lexists(name):
            return {'kind': kind, 'root': name, 'rootKind': None, 'entries': [], 'truncated': False}
        info = os.lstat(name)
        root_kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
        root = name if root_kind == 'directory' else os.path.dirname(name)

        entries = []
        visited = 0
        payload = 0
        truncated = False
        deadline = time.monotonic() + 10
        # Depth first in sorted order, so the same tree always answers in the same sequence and a
        # truncated answer is a stable prefix rather than whatever the filesystem happened to hand back.
        stack = [(root, 0)]
        while stack and not truncated:
            current, depth = stack.pop()
            # The deadline is checked WHILE enumerating. Sorting a materialized listing first meant a
            # directory of a million names was read in full before the clock was ever consulted, so the
            # bound could be exceeded by an unbounded margin.
            children = []
            expired = False
            try:
                with os.scandir(current) as scan:
                    for item in scan:
                        if time.monotonic() > deadline:
                            expired = True
                            break
                        children.append(item)
            except (FileNotFoundError, NotADirectoryError):
                # It was a directory when it was queued and is not one now. The answer is incomplete and
                # says so, rather than quietly omitting a subtree.
                truncated = True
                continue
            if expired:
                # Discard this directory's partial listing entirely: half of one directory, in scandir
                # order, is not a prefix of the sorted answer and must not be presented as one.
                truncated = True
                break
            children.sort(key=lambda item: item.name)
            nested = []
            for item in children:
                visited += 1
                if visited > limit or visited > MAX_ENTRIES + 1 or time.monotonic() > deadline:
                    truncated = True
                    break
                # `follow_symlinks=False` throughout, so a link is never DESCENDED into and the traversal
                # cannot be walked out of its own root. It is still reported, because a tree view has
                # always shown links and a consumer that wants to know where one points can follow it
                # deliberately, one path at a time, rather than have this walk do it silently.
                try:
                    link = item.is_symlink()
                    directory = not link and item.is_dir(follow_symlinks=False)
                    regular = not link and item.is_file(follow_symlinks=False)
                    if not link and not directory and not regular:
                        continue
                    # A skipped directory is omitted ENTIRELY, not merely left undescended: reporting it
                    # while refusing to walk it would present it to a consumer as an empty directory,
                    # which is a different and false statement about the tree.
                    if directory and item.name in skipped:
                        continue
                    # The link's OWN size and time, never its target's: resolving the target is the
                    # caller's decision, and a broken link must still describe itself.
                    facts = item.stat(follow_symlinks=False)
                except OSError:
                    truncated = True
                    continue
                record = {'path': item.path, 'kind': 'symlink' if link else 'directory' if directory else 'file',
                          'size': facts.st_size, 'mtime': int(facts.st_mtime * 1000)}
                # The ACTUAL encoded size, with the same escaping the reply is written with: a name of
                # non-ASCII text inflates to six bytes per character once escaped, so a byte count taken
                # on the raw path would under-measure a tree of such names several times over.
                encoded = len(json.dumps(record, ensure_ascii=True, separators=(',', ':'))) + 1
                if payload + encoded > 8388608:
                    truncated = True
                    break
                payload += encoded
                entries.append(record)
                if directory and depth < max_depth:
                    nested.append((item.path, depth + 1))
            stack.extend(reversed(nested))
        return {'kind': kind, 'root': root, 'rootKind': root_kind, 'entries': entries, 'truncated': truncated}
    if kind == 'search':
        limit = bounded(op.get('limit'), 1, 1000)
        pattern = op.get('pattern')
        if not isinstance(pattern, str) or len(pattern) > 4096:
            fail('invalid_pattern', 'Invalid search pattern')
        expression = re.compile(pattern, 0 if op.get('caseSensitive') else re.IGNORECASE)
        matches = []
        count = 0
        deadline = time.monotonic() + 10
        candidates = [name] if os.path.isfile(name) else (os.path.join(root, item) for root, _, files in os.walk(name, followlinks=False) for item in files)
        for candidate in candidates:
            count += 1
            if count > MAX_ENTRIES or time.monotonic() > deadline:
                fail('search_limit', 'Search exceeds the guest scan limit')
            if op.get('glob') and not fnmatch.fnmatch(os.path.relpath(candidate, name), op['glob']):
                continue
            info = os.stat(candidate)
            if info.st_size > MAX_BYTES and stat.S_ISREG(info.st_mode):
                fail('search_limit', 'A file exceeds the guest search size limit')
            if not stat.S_ISREG(info.st_mode):
                continue
            try:
                with open(candidate, encoding='utf8') as stream:
                    for number, text in enumerate(stream, 1):
                        if expression.search(text):
                            if len(matches) == limit:
                                return {'kind': kind, 'matches': matches, 'truncated': True}
                            matches.append({'path': candidate, 'line': number, 'text': text.rstrip('\n')[:500]})
            except UnicodeDecodeError:
                continue
        return {'kind': kind, 'matches': matches, 'truncated': False}
    fail('invalid_operation', 'Unknown guest file operation')


try:
    raw = sys.stdin.buffer.read(1048577)
    if len(raw) > 1048576:
        fail('input_limit', 'Guest input exceeds limit')
    operation = json.loads(raw)
    if not isinstance(operation, dict):
        fail('invalid_operation', 'Guest operation must be an object')
    print(json.dumps({'ok': True, 'result': run(operation)}, ensure_ascii=True))
except Exception as error:
    code = getattr(error, 'code', 'guest_file_error')
    if isinstance(error, FileNotFoundError):
        code = 'not_found'
    elif isinstance(error, FileExistsError):
        code = 'already_exists'
    elif isinstance(error, PermissionError):
        code = 'permission_denied'
    print(json.dumps({'ok': False, 'error': {'code': code, 'message': str(error)}}))
    sys.exit(1)
