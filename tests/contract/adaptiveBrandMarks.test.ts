import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(process.cwd(), 'web');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next') return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('adaptive provider and model marks', () => {
  it('keeps raw provider asset reads behind ProviderIcon', () => {
    const offenders = sourceFiles(WEB_ROOT)
      .filter((path) => !path.endsWith('/modules/settings/providers.tsx'))
      .filter((path) => readFileSync(path, 'utf8').includes('meta.icon'))
      .map((path) => relative(WEB_ROOT, path));
    expect(offenders).toEqual([]);
  });

  it('does not apply a root-theme invert to monochrome model icons', () => {
    const source = readFileSync(join(WEB_ROOT, 'components/ui/ModelIcon.tsx'), 'utf8');
    expect(source).toContain('AdaptiveBrandMark');
    expect(source).not.toMatch(/className=.*\binvert\b/);
  });
});
