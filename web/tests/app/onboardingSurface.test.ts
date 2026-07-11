import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'app/onboarding/page.tsx'), 'utf8');

describe('Onboarding shared surface structure', () => {
  it('uses the shared mascot once and shared control surfaces for setup sections', () => {
    expect(source).toContain("from '../../components/ui/SpatialMascot'");
    expect(source.match(/<SpatialMascot\b/g)).toHaveLength(1);
    expect(source).not.toContain('ElowenPresence');
    expect(source).toContain("from '../../components/ui/ControlSurface'");
    expect(source).toContain('<ControlSurfaceDocument');
    expect(source).toContain('<ControlSurfaceToolbar');
  });
});
