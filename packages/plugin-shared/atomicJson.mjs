import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';

/** Read and parse a JSON file. Returns `fallback` when the file does not exist yet (first run). When it
 *  exists but is not valid JSON, calls `onCorrupt(error)` — so the caller can LOG it — and still returns
 *  `fallback`: a scheduler or a chat command has to keep working even against a corrupted file, but the
 *  corruption must be visible, never indistinguishable from "there was never any state here". */
export function readJsonSafe(file, fallback, onCorrupt) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    onCorrupt?.(e);
    return fallback;
  }
}

/** Write `value` to `file` atomically: serialize to a sibling temp file, then rename it over the
 *  destination. A same-filesystem rename replaces the old content in one step, so a crash or a full disk
 *  mid-write can never leave `file` half-written or corrupt — the previous good content survives on disk
 *  until the new one is completely written. Throws on failure (temp write or rename); the caller decides
 *  how to surface that (log it, propagate it to whoever asked for the write, …) — it must not be silently
 *  swallowed into a false "saved" result. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    // The temp name is unique per attempt, so ANY failure after the file appears orphans it forever, and
    // a writer on a short interval turns one bad minute into a directory full of them. Both halves matter:
    // a full disk leaves a zero-byte temp from the write (41 such files were found from one incident),
    // a bad destination leaves a complete one from the rename. The throw still reaches the caller — the
    // cleanup only stops a failure from accumulating on disk.
    rmSync(tmp, { force: true });
    throw e;
  }
}
