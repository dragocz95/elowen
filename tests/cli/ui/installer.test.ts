import { describe, expect, it } from 'vitest';
import { InstallerModel } from '../../../src/cli/ui/installer.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const SPINNER = ['-', '\\', '|', '/'];

describe('installer panel model (progress row state)', () => {
  it('a step begins running and settles to a final state', () => {
    const m = new InstallerModel();
    const id = m.begin('Installing tmux');
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]!.state).toBe('run');
    expect(m.running).toBe(true);

    m.settle(id, 'success', 'Installing tmux ok');
    expect(m.rows[0]!.state).toBe('success');
    expect(m.rows[0]!.label).toBe('Installing tmux ok');
    expect(m.running).toBe(false);
  });

  it('a failed step settles to error and stops the animation', () => {
    const m = new InstallerModel();
    const id = m.begin('Configuring systemd');
    m.settle(id, 'error', 'Configuring systemd failed');
    expect(m.rows[0]!.state).toBe('error');
    expect(m.running).toBe(false);
  });

  it('stays running while any of several steps is still in flight', () => {
    const m = new InstallerModel();
    const a = m.begin('A');
    m.begin('B');
    m.settle(a, 'success');
    expect(m.running).toBe(true); // B still running
  });

  it('routes standalone log lines into static rows with a mapped state', () => {
    const m = new InstallerModel();
    m.line('warn', 'Terminal streaming unavailable');
    m.line('info', 'Admin already exists');
    expect(m.rows.map((r) => r.state)).toEqual(['warn', 'info']);
    expect(m.running).toBe(false);
  });

  it('renders a spinner glyph for running rows that advances with the frame', () => {
    const m = new InstallerModel();
    m.begin('Working');
    expect(stripAnsi(m.bodyLines()[0]!)).toBe(`${SPINNER[0]} Working`);
    m.frame = 2;
    expect(stripAnsi(m.bodyLines()[0]!)).toBe(`${SPINNER[2]} Working`);
  });

  it('renders a status dot for settled and log rows', () => {
    const m = new InstallerModel();
    const id = m.begin('Step');
    m.settle(id, 'success', 'Step ok');
    m.line('error', 'Boom');
    const lines = m.bodyLines().map(stripAnsi);
    expect(lines[0]).toBe('● Step ok');
    expect(lines[1]).toBe('● Boom');
  });

  it('ignores settle for an unknown id (no throw, no row change)', () => {
    const m = new InstallerModel();
    m.begin('Only');
    m.settle(999, 'success');
    expect(m.rows[0]!.state).toBe('run');
  });
});
