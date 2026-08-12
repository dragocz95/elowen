import { describe, it, expect } from 'vitest';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { eventTone, eventIcon, markerTone } = await import('./eventMeta');

describe('eventTone', () => {
  it('maps types to tones', () => {
    expect(eventTone('task')).toBe('accent');
    expect(eventTone('mission')).toBe('accent');
    expect(eventTone('signal')).toBe('muted');
    expect(eventTone('other')).toBe('default');
  });
});

describe('eventIcon', () => {
  it('returns a distinct icon per known type and a fallback otherwise', () => {
    expect(eventIcon('task')).not.toBe(eventIcon('mission'));
    expect(eventIcon('review')).not.toBe(eventIcon('signal'));
    expect(eventIcon('whatever')).toBe(eventIcon('whatever')); // stable fallback
  });
});

describe('markerTone', () => {
  it('colours review verdicts by their outcome prefix', () => {
    expect(markerTone('review', 'approved: looks good')).toBe('success');
    expect(markerTone('review', 'escalated: missing tests')).toBe('danger');
  });
  it('colours task statuses (open green, closed red, working amber)', () => {
    expect(markerTone('task', 'open')).toBe('success');
    expect(markerTone('task', 'closed')).toBe('danger');
    expect(markerTone('signal', 'working')).toBe('warning');
  });
  it('falls back to the kind tone for an unknown detail', () => {
    expect(markerTone('mission', 'whatever')).toBe('accent');
  });
});
