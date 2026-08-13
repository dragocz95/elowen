import { describe, it, expect, vi } from 'vitest';
import { detectClis } from '../../../plugins/agents/src/lib/cliDetection.js';

// Every detectClis() call spawns 9 real binaries with --version, and one of them (kilo) boots a
// daemon to answer, so a single case costs ~2.5s idle. Vitest's 5s default left only 2x headroom,
// which the full 400-file suite eats: these cases timed out on a loaded machine and passed on re-run.
// The work is genuinely slow, not stuck — the limit was wrong, so give it a real one.
vi.setConfig({ testTimeout: 30_000 });

describe('cli detection unit', () => {
  it('returns correct shape with tools array and summary', async () => {
    const result = await detectClis();
    expect(result).toHaveProperty('tools');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBe(9);
    result.tools.forEach((t) => {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('installed');
      expect(t).toHaveProperty('functional');
      expect(t).toHaveProperty('version');
      expect(t).toHaveProperty('error');
    });
    expect(typeof result.summary.allInstalled).toBe('boolean');
    expect(typeof result.summary.allFunctional).toBe('boolean');
  });

  it('lists all expected CLI tools', async () => {
    const result = await detectClis();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['claude', 'codex', 'git', 'kilo', 'node', 'omp', 'opencode', 'pi', 'tmux']);
  });

  it('excludes optional agent CLIs from the install/functional summary', async () => {
    // kilo/pi/omp are detected and displayed, but a box without them must not read as "missing tools".
    // The required set is the 6 non-optional tools; the summary is computed only over those.
    const result = await detectClis();
    expect(result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['kilo', 'pi', 'omp']));
  });

  it('detects fresh install when context indicates no config, no api key, no custom setup', async () => {
    const result = await detectClis({
      configPersisted: false, hasApiKey: false, hasCustomSetup: false,
    });
    expect(result.freshInstall.noConfigPersisted).toBe(true);
    expect(result.freshInstall.noApiKey).toBe(true);
    expect(result.freshInstall.noCustomSetup).toBe(true);
  });

  it('detects non-fresh install when config has been persisted', async () => {
    const result = await detectClis({
      configPersisted: true, hasApiKey: false, hasCustomSetup: false,
    });
    expect(result.freshInstall.noConfigPersisted).toBe(false);
  });

  it('detects non-fresh install when api key is set', async () => {
    const result = await detectClis({
      configPersisted: true, hasApiKey: true, hasCustomSetup: false,
    });
    expect(result.freshInstall.noApiKey).toBe(false);
  });
});
