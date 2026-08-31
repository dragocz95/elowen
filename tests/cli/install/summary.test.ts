import { describe, expect, it } from 'vitest';
import * as installer from '../../../src/cli/install/index.js';

type ServiceSummary = (mac: boolean) => string[];

describe('install service summary', () => {
  it('teaches Linux operators the canonical non-blocking restart command', () => {
    const serviceSummary = (installer as unknown as { serviceSummary?: ServiceSummary }).serviceSummary;
    expect(typeof serviceSummary).toBe('function');
    if (!serviceSummary) return;

    const lines = serviceSummary(false);

    expect(lines).toContain('Restart    elowen restart all');
    expect(lines.join('\n')).not.toContain('systemctl restart');
  });

  it('keeps the native launchctl guidance on macOS', () => {
    const serviceSummary = (installer as unknown as { serviceSummary?: ServiceSummary }).serviceSummary;
    expect(typeof serviceSummary).toBe('function');
    if (!serviceSummary) return;
    expect(serviceSummary(true)).toContain('Restart    launchctl kickstart -k gui/$(id -u)/io.elowen.daemon');
  });
});
