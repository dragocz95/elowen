import { describe, it, expect } from 'vitest';
import { trimTrailingSlash, trimAllTrailingSlashes, stripTrailingV1 } from '../../src/shared/url.js';

describe('trimTrailingSlash', () => {
  it('removes a single trailing slash', () => {
    expect(trimTrailingSlash('https://x/v1/')).toBe('https://x/v1');
    expect(trimTrailingSlash('https://x/')).toBe('https://x');
    expect(trimTrailingSlash('https://x')).toBe('https://x');
    expect(trimTrailingSlash('')).toBe('');
  });

  it('removes exactly one slash, matching the old /\/$/ pattern', () => {
    expect(trimTrailingSlash('https://x//')).toBe('https://x/');
  });
});

describe('trimAllTrailingSlashes', () => {
  it('removes every trailing slash', () => {
    expect(trimAllTrailingSlashes('https://x/')).toBe('https://x');
    expect(trimAllTrailingSlashes('https://x//')).toBe('https://x');
    expect(trimAllTrailingSlashes('https://x/////')).toBe('https://x');
    expect(trimAllTrailingSlashes('https://x')).toBe('https://x');
    expect(trimAllTrailingSlashes('')).toBe('');
    expect(trimAllTrailingSlashes('/')).toBe('');
  });

  it('leaves inner slashes and the rest of the path alone', () => {
    expect(trimAllTrailingSlashes('https://x/openai/v1/')).toBe('https://x/openai/v1');
    expect(trimAllTrailingSlashes('https://x//openai//v1//')).toBe('https://x//openai//v1');
    expect(trimAllTrailingSlashes('/openai/v1')).toBe('/openai/v1');
  });

  it('differs from trimTrailingSlash by more than its name', () => {
    expect(trimTrailingSlash('https://x//')).toBe('https://x/');
    expect(trimAllTrailingSlashes('https://x//')).toBe('https://x');
  });
});

describe('stripTrailingV1', () => {
  it('removes a trailing /v1 segment', () => {
    expect(stripTrailingV1('https://x/v1')).toBe('https://x');
    expect(stripTrailingV1('https://x')).toBe('https://x');
    expect(stripTrailingV1('')).toBe('');
  });

  it('is case-sensitive — /V1 is left alone', () => {
    expect(stripTrailingV1('https://x/V1')).toBe('https://x/V1');
  });

  it('strips only a version segment at the very end', () => {
    expect(stripTrailingV1('https://x/v1/embeddings')).toBe('https://x/v1/embeddings');
    expect(stripTrailingV1('https://x/v1/')).toBe('https://x/v1/');
  });
});
