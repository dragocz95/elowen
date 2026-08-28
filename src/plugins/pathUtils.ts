import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export function realAbs(path: string): string {
  const abs = resolve(path);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length ? join(real, ...missing) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function realPathWithin(path: string, roots: string[]): string | null {
  const abs = realAbs(path);
  const within = (root: string): boolean => {
    const real = realAbs(root);
    const base = real.endsWith(sep) ? real.slice(0, -1) : real;
    return abs === base || abs.startsWith(`${base}${sep}`);
  };
  return roots.some(within) ? abs : null;
}
