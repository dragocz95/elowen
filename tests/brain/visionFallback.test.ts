import { describe, it, expect } from 'vitest';
import { decideVisionHop } from '../../src/brain/visionFallback.js';

describe('decideVisionHop — the vision-fallback decision, isolated from session plumbing', () => {
  it('an image turn on a text-only model with a configured fallback hops onto it', () => {
    expect(decideVisionHop({ hasImages: true, visionCapable: false, onFallback: false, visionModel: 'gpt-5.5', visionModelProvider: 'oai' }))
      .toEqual({ action: 'hop', provider: 'oai', model: 'gpt-5.5' });
  });

  it('an empty provider normalizes to undefined (start falls back to the default provider)', () => {
    expect(decideVisionHop({ hasImages: true, visionCapable: false, onFallback: false, visionModel: 'v', visionModelProvider: '' }))
      .toEqual({ action: 'hop', provider: undefined, model: 'v' });
  });

  it('an image turn WITHOUT a configured fallback stays put (the model just gets the marker)', () => {
    expect(decideVisionHop({ hasImages: true, visionCapable: false, onFallback: false }))
      .toEqual({ action: 'none' });
  });

  it('an image turn on a vision-capable model never hops', () => {
    expect(decideVisionHop({ hasImages: true, visionCapable: true, onFallback: false, visionModel: 'v' }))
      .toEqual({ action: 'none' });
  });

  it('a text-only turn while parked on the fallback hops back to the normal model', () => {
    expect(decideVisionHop({ hasImages: false, visionCapable: true, onFallback: true }))
      .toEqual({ action: 'hop-back' });
  });

  it('a text-only turn on the normal model does nothing', () => {
    expect(decideVisionHop({ hasImages: false, visionCapable: false, onFallback: false, visionModel: 'v' }))
      .toEqual({ action: 'none' });
  });

  it('consecutive image turns on the fallback stay put (capable now → no re-hop)', () => {
    expect(decideVisionHop({ hasImages: true, visionCapable: true, onFallback: true, visionModel: 'v' }))
      .toEqual({ action: 'none' });
  });

  it('does NOT hop when the current model already IS the vision model (no churn, image sent through)', () => {
    // The common operator setup: main model and vision model both point at one multimodal model. Inline
    // model descriptors carry no vision metadata (visionCapable=false), so without this guard every image
    // turn would pointlessly dispose + respawn the session onto the model it is already on.
    expect(decideVisionHop({ hasImages: true, visionCapable: false, onFallback: false, currentModel: 'kimi', visionModel: 'kimi', visionModelProvider: 'relay' }))
      .toEqual({ action: 'none' });
  });
});
