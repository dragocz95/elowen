// Loading attachments off disk for upload, shared by every platform adapter. Three sources feed it: the
// image-gen/image-edit plugins write their PNGs into their own data dirs (the adapters' data-dir
// siblings), an image the agent shared (ShareImage) lives in the daemon's chat-images dir, and a general
// file the agent shared (ShareFile) lives in its chat-files sibling. An adapter only knows the file names
// extracted from the reply text, or the refs carried by an `image` / `file` stream event.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every directory an outgoing image may come from, derived from the adapter's own plugin data dir — one
 *  definition for all four platforms, so a new source is added in one place rather than four.
 *  `chat-images` is NOT under the plugin data root: it sits beside the database, which is the PARENT of
 *  `plugins-data` (see `chatImagesDir` in src/daemon/bootstrap.ts). */
export function platformImageDirs(dataDir) {
  return [
    join(dataDir, '..', 'image-gen'),
    join(dataDir, '..', 'image-edit'),
    join(dataDir, '..', '..', 'chat-images'),
  ];
}

/** Where a file the agent shared on purpose (ShareFile) is read from, derived from the adapter's own
 *  plugin data dir. Like `chat-images` it sits beside the database, which is the PARENT of `plugins-data`
 *  (see `chatFilesDir` in src/brain/chatFiles.ts) — so this is the SAME derivation as the last entry of
 *  `platformImageDirs`, one directory over. It lives here rather than in each adapter for the reason that
 *  list exists at all: four copies of a path derivation are four chances for one of them to drift. */
export function platformChatFilesDir(dataDir) {
  return join(dataDir, '..', '..', 'chat-files');
}

const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Content types worth declaring for a shared FILE. Only types where the surface renders something better
 *  than a generic download when it is told (a PDF preview, an inline text/CSV view); everything else is
 *  deliberately `application/octet-stream` rather than a guess, because a wrong declared type renders a
 *  broken attachment while an honest generic one always downloads. */
const FILE_MIME_BY_EXTENSION = {
  ...MIME_BY_EXTENSION,
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
};

/** The upload content type for a resolved file name. A shared image is no longer PNG-only, and a surface
 *  that declares the wrong type renders a broken attachment. Unknown extensions fall back to PNG — that is
 *  what the image plugins produce, and their names carry no other type. */
export function imageMimeType(name) {
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  return MIME_BY_EXTENSION[ext] ?? 'image/png';
}

/** The upload content type for a shared file. Unknown extensions fall back to `application/octet-stream`
 *  — a general file carries no assumption about its type the way an image plugin's output does. */
export function fileMimeType(name) {
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  return FILE_MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** The stored file name a `file` event's `ref` points at, or null.
 *
 *  The core serves shared files from `/api/brain/chat-files/<sha256>.bin` and writes nothing else into
 *  that directory (`isStoredChatFileName` in src/brain/chatFiles.ts). Matching that exact shape — rather
 *  than taking the last path segment — is what keeps a ref the model repeated in prose from being joined
 *  onto a directory and read off disk. This mirrors `imageRefName`'s role on the image path. */
const SHARED_FILE_REF = /(?:^|\/)brain\/chat-files\/([0-9a-f]{64}\.bin)$/;
export function sharedFileRefName(ref) {
  const m = SHARED_FILE_REF.exec(String(ref ?? ''));
  return m ? m[1] : null;
}

/** Load up to `cap` shared files from `dir` for the `{ ref, name }` entries a `file` event produced.
 *
 *  The counterpart of `resolveImageFiles`, and deliberately the same shape: a ref that does not name a
 *  stored file, or bytes that cannot be read, is skipped silently so the answer text still goes out. The
 *  UPLOAD name is the agent's original basename (what the person expects to receive), reduced to a bare
 *  segment — the bytes are always addressed by the stored content name, never by this one. */
export function resolveSharedFiles(dir, refs, cap) {
  const files = [];
  for (const entry of refs.slice(0, cap)) {
    const stored = sharedFileRefName(entry?.ref);
    if (!stored) continue;
    const p = join(dir, stored);
    if (!existsSync(p)) continue;
    try { files.push({ name: uploadName(entry?.name, stored), data: readFileSync(p) }); }
    catch { /* unreadable → skip */ }
  }
  return files;
}

/** A file name safe to put in a multipart part or a `fileName` field: one segment, no separators, no
 *  control characters. Falls back to the stored content name when nothing usable survives. */
function uploadName(raw, fallback) {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    // Leading junk, stripped AFTER the separators became dashes so `../..\x` collapses in one pass —
    // the same order and the same reasons as `safeSegment` in src/brain/chatUploads.ts.
    .replace(/^[.\-\s]+/, '')
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/** Load up to `cap` images by name from `imageDirs` (first directory holding the name wins). A missing or
 *  unreadable file is skipped silently — the text still goes out without it. Names must already be
 *  validated by the caller; this joins them onto a path. */
export function resolveImageFiles(imageDirs, names, cap) {
  const files = [];
  for (const name of names.slice(0, cap)) {
    for (const dir of imageDirs) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      try { files.push({ name, data: readFileSync(p) }); } catch { /* unreadable → skip */ }
      break;
    }
  }
  return files;
}
