import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = join(import.meta.dirname, '..', '..');

describe('settings surface stylesheet ownership', () => {
  it('loads shared settings primitives from the root layout for plugin routes too', () => {
    const layout = readFileSync(join(webRoot, 'app', 'layout.tsx'), 'utf8');
    const settingsPage = readFileSync(join(webRoot, 'app', 'settings', 'page.tsx'), 'utf8');

    expect(layout).toContain("import '../modules/settings/theme.css';");
    expect(settingsPage).not.toContain("modules/settings/theme.css");
  });
});
