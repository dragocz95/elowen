import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The root layout must OPT INTO dynamic rendering explicitly. Relying on the `no-store` theme fetch is
// not enough: fetchThemePayload's failure backoff returns early without touching fetch, and a render
// hitting that path uses no dynamic API — Next then classifies the route as static and bakes the
// built-in brand into the full route cache (a `next build` with the daemon down shipped an app whose
// every page said Elowen forever, whatever theme was active). Source-level pin on purpose: the
// classification happens at build time, where no unit test can observe it.
describe('root layout rendering mode', () => {
  it("exports dynamic = 'force-dynamic'", () => {
    const src = readFileSync(join(root, 'app', 'layout.tsx'), 'utf-8');
    expect(src).toContain("export const dynamic = 'force-dynamic';");
  });
});
