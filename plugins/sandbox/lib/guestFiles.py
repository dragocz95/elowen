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
            expected(target, op.get('expectedVersion'), True)
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
