import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

/** The remaining subsystem extractions leave one-shot ConfigStore sweeps that re-enable the plugin which
 * took the behaviour over. Unit tests cover each sweep; this suite pins the boot path that invokes them. */
describe('buildBrainCore one-shot upgrade sweeps', () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A settings row as an install had it before the remaining extractions: no plugin or markers. */
  function seedPreExtractionInstall(): string {
    dir = mkdtempSync(join(tmpdir(), 'elowen-upgrade-'));
    const dbPath = join(dir, 'elowen.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      allowedExecs: ['sonnet'],
      lspEnabled: true,
      plugins: { enabled: ['files', 'terminal'], removed: [], config: {} },
    }));
    db.close();
    return dbPath;
  }

  const boot = (dbPath: string, migrate?: false) => buildBrainCore({
    dbPath,
    project: { id: 1, slug: 'upgrade', path: dir },
    tmux: new FakeTmuxDriver(),
    bootstrap: null,
    pluginDirs: [join(dir, 'plugins')],
    ...(migrate === false ? { migrate: false } : {}),
  });

  it('re-enables the remaining previously-core subsystems', async () => {
    const dbPath = seedPreExtractionInstall();
    const core = await boot(dbPath);
    try {
      const enabled = core.config.get().plugins.enabled;
      expect(enabled).toContain('lsp');
      expect(enabled).toContain('editor');
      // The operator's own choices are untouched by the sweeps.
      expect(enabled).toContain('files');
      expect(enabled).toContain('terminal');
    } finally { core.db.close(); }
  });

  it('marks them so a later deliberate disable is never undone by the next boot', async () => {
    const dbPath = seedPreExtractionInstall();
    const first = await boot(dbPath);
    first.config.update({ plugins: { enabled: ['files', 'terminal'] } }); // the admin turns them all off
    first.db.close();

    const second = await boot(dbPath);
    try {
      expect(second.config.get().plugins.enabled).not.toContain('lsp');
      expect(second.config.get().plugins.enabled).not.toContain('editor');
    } finally { second.db.close(); }
  });

  it('writes no settings at all in a sub-agent runner (migrate:false)', async () => {
    const dbPath = seedPreExtractionInstall();
    // A runner attaches to a database the daemon already prepared. Letting it run the sweeps would race
    // the daemon as a second writer of the same row — the same reason it never migrates the schema.
    const core = await boot(dbPath, false);
    try {
      expect(core.config.get().plugins.enabled).not.toContain('lsp');
    } finally { core.db.close(); }
  });
});
