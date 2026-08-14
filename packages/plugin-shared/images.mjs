// Loading images off disk for upload, shared by every platform adapter. Two sources feed it: the
// image-gen/image-edit plugins write their PNGs into their own data dirs (the adapters' data-dir
// siblings), and an image the agent shared (ShareImage) lives in the daemon's chat-images dir. An adapter
// only knows the file names extracted from the reply text or from an `image` stream event.
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

const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The upload content type for a resolved file name. A shared image is no longer PNG-only, and a surface
 *  that declares the wrong type renders a broken attachment. Unknown extensions fall back to PNG — that is
 *  what the image plugins produce, and their names carry no other type. */
export function imageMimeType(name) {
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  return MIME_BY_EXTENSION[ext] ?? 'image/png';
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
