import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = process.cwd();
const primitiveRoot = path.join(webRoot, 'components/ui/shadcn');

type PrimitiveContract = {
  radix: string | null;
  cva: boolean;
};

/** The complete primitive layer. A file cannot quietly become "shadcn-shaped" without its real owner. */
const primitives = {
  'alert-dialog.tsx': { radix: '@radix-ui/react-alert-dialog', cva: false },
  'avatar.tsx': { radix: '@radix-ui/react-avatar', cva: false },
  'badge.tsx': { radix: '@radix-ui/react-slot', cva: true },
  'button.tsx': { radix: '@radix-ui/react-slot', cva: true },
  'checkbox.tsx': { radix: '@radix-ui/react-checkbox', cva: true },
  'context-menu.tsx': { radix: '@radix-ui/react-context-menu', cva: true },
  'dialog.tsx': { radix: '@radix-ui/react-dialog', cva: true },
  'dropdown-menu.tsx': { radix: '@radix-ui/react-dropdown-menu', cva: true },
  'empty.tsx': { radix: null, cva: false },
  'input.tsx': { radix: null, cva: true },
  'label.tsx': { radix: '@radix-ui/react-label', cva: true },
  'popover.tsx': { radix: '@radix-ui/react-popover', cva: false },
  'radio-group.tsx': { radix: '@radix-ui/react-radio-group', cva: true },
  'select.tsx': { radix: '@radix-ui/react-select', cva: true },
  'skeleton.tsx': { radix: null, cva: false },
  'slider.tsx': { radix: '@radix-ui/react-slider', cva: true },
  'switch.tsx': { radix: '@radix-ui/react-switch', cva: true },
  'textarea.tsx': { radix: null, cva: true },
  'toast.tsx': { radix: '@radix-ui/react-toast', cva: true },
  // The tooltip intentionally uses a non-modal Popover: hover/focus open, Escape close, no focus move.
  'tooltip.tsx': { radix: '@radix-ui/react-popover', cva: false },
} satisfies Record<string, PrimitiveContract>;

function source(file: string): string {
  return readFileSync(path.join(primitiveRoot, file), 'utf8');
}

function aliasResolves(alias: string): boolean {
  const target = path.join(webRoot, alias.slice(2));
  return [target, `${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts'), path.join(target, 'index.tsx')]
    .some((candidate) => existsSync(candidate));
}

describe('shadcn adoption contract', () => {
  it('keeps a valid components.json whose aliases resolve to the adopted primitive directory', () => {
    const configPath = path.join(webRoot, 'components.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { aliases?: Record<string, string> };

    expect(config.aliases?.ui).toBe('@/components/ui/shadcn');
    for (const [name, alias] of Object.entries(config.aliases ?? {})) {
      expect(alias, `${name} must use the web-root @/ alias`).toMatch(/^@\//);
      expect(aliasResolves(alias), `${name} alias must resolve`).toBe(true);
    }
  });

  it('registers every primitive file exactly once', () => {
    const files = readdirSync(primitiveRoot).filter((file) => file.endsWith('.tsx')).sort();
    expect(files).toEqual(Object.keys(primitives).sort());
  });

  it('keeps Radix-backed primitives on their declared Radix package', () => {
    for (const [file, contract] of Object.entries(primitives)) {
      if (!contract.radix) continue;
      expect(source(file), `${file} must import ${contract.radix}`).toContain(`from '${contract.radix}'`);
    }
  });

  it('keeps every primitive-owned variant axis in CVA', () => {
    for (const [file, contract] of Object.entries(primitives)) {
      if (!contract.cva) continue;
      const text = source(file);
      expect(text, `${file} must import class-variance-authority`).toContain("from 'class-variance-authority'");
      expect(text, `${file} must declare variants through cva()`).toContain('cva(');
    }
  });
});
