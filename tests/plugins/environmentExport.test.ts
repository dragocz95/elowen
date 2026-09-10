import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { removeOwnedArtifact } from '../../plugins/sandbox/lib/environmentExport.mjs';

test('removeOwnedArtifact retires an owned directory tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'environment-export-'));
  try {
    const artifact = join(root, 'migration');
    mkdirSync(join(artifact, 'workspace'), { recursive: true });
    writeFileSync(join(artifact, 'workspace', 'owned.txt'), 'staged');

    removeOwnedArtifact(artifact);

    assert.equal(existsSync(artifact), false);
    assert.doesNotThrow(() => removeOwnedArtifact(artifact), 'retirement stays idempotent after the tree is gone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
