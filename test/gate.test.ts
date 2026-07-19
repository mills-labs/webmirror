/**
 * Unit coverage for the crawl-enqueue gates (spec addendum A1/A2). The engine
 * uses these pure predicates to decide whether a discovered link is followed
 * (depth) and whether a URL is skipped (exclude). Tested in isolation here, and
 * end-to-end through mirror() in addendum.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { withinDepth, matchesExclude } from '../src/mirror';

describe('withinDepth — crawl-depth enqueue gate (A1)', () => {
  it('treats maxDepth 0 as unlimited', () => {
    expect(withinDepth(1, 0)).toBe(true);
    expect(withinDepth(50, 0)).toBe(true);
  });

  it('treats an undefined maxDepth as unlimited (the default)', () => {
    expect(withinDepth(1, undefined)).toBe(true);
    expect(withinDepth(999, undefined)).toBe(true);
  });

  it('at maxDepth 1 admits the seed level but no deeper links', () => {
    // Seed is depth 1; its links enqueue at childDepth 2.
    expect(withinDepth(1, 1)).toBe(true);
    expect(withinDepth(2, 1)).toBe(false);
  });

  it('at maxDepth 2 admits the seed and its direct links but not theirs', () => {
    expect(withinDepth(2, 2)).toBe(true); // direct links of the seed
    expect(withinDepth(3, 2)).toBe(false); // one level further
  });
});

describe('matchesExclude — URL exclude gate (A2)', () => {
  it('returns false when no patterns are supplied', () => {
    expect(matchesExclude('https://x.test/a', undefined)).toBe(false);
    expect(matchesExclude('https://x.test/a', [])).toBe(false);
  });

  it('matches a plain substring anywhere in the URL', () => {
    expect(matchesExclude('https://x.test/blog/post', ['/blog/'])).toBe(true);
    expect(matchesExclude('https://x.test/img/deep.png', ['deep.png'])).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesExclude('https://x.test/Admin/Panel', ['admin'])).toBe(true);
    expect(matchesExclude('https://X.TEST/a', ['x.test'])).toBe(true);
  });

  it('does not match when no pattern is a substring', () => {
    expect(matchesExclude('https://x.test/about', ['/blog/', 'deep.png'])).toBe(false);
  });

  it('matches when any one of several patterns hits', () => {
    expect(matchesExclude('https://x.test/a-deep', ['/private', '-deep'])).toBe(true);
  });

  it('ignores empty patterns (never excludes everything)', () => {
    expect(matchesExclude('https://x.test/a', [''])).toBe(false);
  });
});
