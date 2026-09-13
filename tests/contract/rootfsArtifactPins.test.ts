import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the bundled Sandbox catalogue is plain ESM without declarations
import { ROOTFS_ARTIFACTS, ROOTFS_RECIPES, artifactReference, recipeDigest } from '../../plugins/sandbox/lib/rootfsCatalog.mjs';
// @ts-expect-error the root filesystem build script intentionally has no TypeScript declaration file
import { GENERATOR, PIN_FILE, pinsFrom, releasePathFor } from '../../scripts/build-rootfs-artifact.mjs';

type Pin = { digest: string | null; sizeBytes: number | null; path: string };

const raw = readFileSync(new URL('../../plugins/sandbox/lib/rootfsArtifacts.json', import.meta.url), 'utf8');
const pinFile = JSON.parse(raw) as { $generated: string; $generator: string; artifacts: Record<string, Pin> };

describe('generated root filesystem pin file', () => {
  it('says it is generated and names the only thing allowed to write it', () => {
    // A digest is evidence a build measured, not a preference somebody holds. Anyone who opens this
    // file has to learn that before they reach for an editor.
    expect(pinFile.$generated).toMatch(/do not edit by hand/i);
    expect(pinFile.$generator).toBe(GENERATOR);
    expect(PIN_FILE).toBe('plugins/sandbox/lib/rootfsArtifacts.json');
    // And the pin file the script would write is the one that is checked in.
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('is what the catalogue exports, with nothing added or dropped in between', () => {
    expect(Object.keys(ROOTFS_ARTIFACTS).sort()).toEqual(Object.keys(pinFile.artifacts).sort());
    for (const [reference, entry] of Object.entries(ROOTFS_ARTIFACTS) as [string, Pin][]) {
      expect(entry, reference).toEqual(pinFile.artifacts[reference]);
      // Exactly the three fields the runtime reads; a stray key must not ride along into an entry.
      expect(Object.keys(entry).sort(), reference).toEqual(['digest', 'path', 'sizeBytes']);
    }
  });

  it('round-trips through the script that writes it', () => {
    // The checked-in file has to be the file a build would produce for the same pins, or the next
    // build reformats it and the diff hides whatever actually changed.
    const rewritten = pinsFrom({ artifacts: [] }, ROOTFS_ARTIFACTS);
    expect(`${JSON.stringify(rewritten, null, 2)}\n`).toBe(raw);
  });
});

describe('recipes and pins agree', () => {
  it('pins every recipe exactly once, at the version the recipe currently declares', () => {
    // This is what catches a recipe edited without a version bump: the reference moves to `@2` and
    // there is no entry answering for it, so nothing can resolve the artifact the recipes describe.
    const references = Object.keys(ROOTFS_RECIPES).map((name) => artifactReference(name));
    expect(references.sort()).toEqual(Object.keys(pinFile.artifacts).sort());
    expect(new Set(references).size).toBe(references.length);
  });

  it('names no recipe or version this release does not have', () => {
    for (const reference of Object.keys(pinFile.artifacts)) {
      const separator = reference.lastIndexOf('@');
      const name = reference.slice(0, separator);
      const version = Number(reference.slice(separator + 1));
      expect(Object.keys(ROOTFS_RECIPES), reference).toContain(name);
      expect(version, reference).toBe(ROOTFS_RECIPES[name].version);
    }
  });

  it('gives every entry the release path the build script produces', () => {
    // The pin's `path` is appended to the release base URL, so a path that disagrees with the naming
    // scheme is a 404 at the moment an environment is first created, on a host that has no fallback.
    for (const [reference, entry] of Object.entries(pinFile.artifacts)) {
      const name = reference.slice(0, reference.lastIndexOf('@'));
      expect(entry.path, reference).toBe(releasePathFor(name, ROOTFS_RECIPES[name].version));
      expect(entry.path, reference).toMatch(/^[a-z0-9][a-z0-9./-]*\.tar\.gz$/);
      expect(entry.path, reference).not.toContain('..');
    }
  });

  it('keeps a recipe fingerprint derivable for every pinned reference', () => {
    // The manifest records this beside the digest, so a rebuild a year from now can be compared
    // against the recipe it claims to come from rather than against the current one.
    for (const name of Object.keys(ROOTFS_RECIPES)) {
      expect(recipeDigest(name), name).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe('pinned digests', () => {
  it('is either fully published or not published at all, never half', () => {
    for (const [reference, entry] of Object.entries(pinFile.artifacts)) {
      // A digest with no length cannot bound a download; a length with no digest cannot prove one.
      expect(entry.digest === null, `${reference} pins a length without a digest`).toBe(entry.sizeBytes === null);
      if (entry.digest === null) continue;
      expect(entry.digest, reference).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Number.isSafeInteger(entry.sizeBytes), reference).toBe(true);
      expect(entry.sizeBytes as number, reference).toBeGreaterThan(0);
    }
  });

  it('is published across the board, because a build has measured every recipe', () => {
    // The inverse of what this asserted while the pins were null. Back then `ensure()` refused every
    // reference with `artifact_unpublished` and no environment could be created at all, which was the
    // correct answer to having no bytes. Now every recipe this release declares has bytes behind it, and
    // a pin that returns to null — a hand edit, a half-finished publish, a version bump nobody rebuilt —
    // is that outage again, on a fresh host, at the moment someone creates their first environment.
    for (const name of Object.keys(ROOTFS_RECIPES)) {
      const reference = artifactReference(name);
      const entry = pinFile.artifacts[reference];
      expect(entry, `${reference} has no pin entry`).toBeDefined();
      // Lower-case hex only, which is what the catalogue's own `ARTIFACT_DIGEST` accepts; a pin the
      // runtime would reject as malformed is no more fetchable than a null one.
      expect(entry?.digest, reference).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Number.isSafeInteger(entry?.sizeBytes), reference).toBe(true);
      expect(entry?.sizeBytes as number, reference).toBeGreaterThan(0);
      // Both or neither, asserted here too: half a pin is what a partial publish leaves behind.
      expect(entry?.digest === null, reference).toBe(entry?.sizeBytes === null);
    }
  });
});
