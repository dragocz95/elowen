import { afterEach, describe, expect, it } from 'vitest';
import { announceLocation, hrefPathname } from '../../lib/sameDocumentNavigation';

afterEach(() => { window.history.replaceState(null, '', '/'); });

describe('hrefPathname', () => {
  it('keeps only the path, whatever the href carries after it', () => {
    expect(hrefPathname('/account')).toBe('/account');
    expect(hrefPathname('/account?cat=security')).toBe('/account');
    expect(hrefPathname('/account?cat=profile&row=account.name')).toBe('/account');
    expect(hrefPathname('/settings?cat=models#top')).toBe('/settings');
    expect(hrefPathname('/settings#top')).toBe('/settings');
  });

  /** An address on another origin is never the document the reader is standing in, and the comparison has
   *  to say so rather than matching on the tail of the URL. */
  it('does not reduce an absolute URL to a path', () => {
    expect(hrefPathname('https://example.test/account?cat=cli')).not.toBe('/account');
  });
});

describe('announceLocation', () => {
  it('rewrites the address in place and announces it with a popstate', () => {
    window.history.replaceState(null, '', '/account?cat=profile');
    const entries = window.history.length;
    const heard: string[] = [];
    const listen = () => heard.push(window.location.search);
    window.addEventListener('popstate', listen);

    announceLocation('/account?cat=security');
    window.removeEventListener('popstate', listen);

    expect(window.location.pathname).toBe('/account');
    expect(window.location.search).toBe('?cat=security');
    // The listeners read the live address, so the announcement has to arrive AFTER the rewrite.
    expect(heard).toEqual(['?cat=security']);
    // A section is the same page by another spelling, not a step in the reader's history.
    expect(window.history.length).toBe(entries);
  });

  /** Next keeps its router tree in `history.state`; replacing it with null leaves a later back/forward
   *  with nothing to restore from. */
  it('carries the existing history state over', () => {
    window.history.replaceState({ __NA: true, tree: 'router' }, '', '/settings?cat=system');
    announceLocation('/settings?cat=models');
    expect(window.history.state).toEqual({ __NA: true, tree: 'router' });
  });
});
