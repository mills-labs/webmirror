/**
 * Unit tests for src/url-map.ts (spec T-unit: mapping rules, relative-path
 * computation, scope rule). Written against the CURRENT implementation.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  sanitizeSegment,
  sanitizePathSegment,
  isPageExtension,
  computeScopeRoot,
  isInPageScope,
  normalizeUrl,
  mapUrlToLocal,
  relativeRef,
} from '../src/url-map';

const OUT = '/out';
const q8 = (query: string) => createHash('sha256').update(query).digest('hex').slice(0, 8);
/** Disambiguation hash a path segment gains once substitution alters it. */
const h8 = (decoded: string) => createHash('sha256').update(decoded).digest('hex').slice(0, 8);

describe('mapUrlToLocal — page mapping rules', () => {
  it('maps a root URL to <host>/index.html', () => {
    const m = mapUrlToLocal('https://example.com/', OUT, 'page');
    expect(m.relPath).toBe('example.com/index.html');
    expect(m.absPath).toBe(join(OUT, 'example.com/index.html'));
  });

  it('maps an empty-path URL to <host>/index.html', () => {
    const m = mapUrlToLocal('https://example.com', OUT, 'page');
    expect(m.relPath).toBe('example.com/index.html');
  });

  it('maps a trailing-slash directory URL to .../index.html', () => {
    const m = mapUrlToLocal('https://example.com/blog/', OUT, 'page');
    expect(m.relPath).toBe('example.com/blog/index.html');
  });

  it('appends .html to an extensionless last segment (page)', () => {
    const m = mapUrlToLocal('https://example.com/about', OUT, 'page');
    expect(m.relPath).toBe('example.com/about.html');
  });

  it('keeps an existing .html extension', () => {
    const m = mapUrlToLocal('https://example.com/page.html', OUT, 'page');
    expect(m.relPath).toBe('example.com/page.html');
  });

  it('keeps an existing .htm extension', () => {
    const m = mapUrlToLocal('https://example.com/page.htm', OUT, 'page');
    expect(m.relPath).toBe('example.com/page.htm');
  });

  it('appends .html to a non-HTML page extension so it opens offline', () => {
    const m = mapUrlToLocal('https://example.com/page.php', OUT, 'page');
    expect(m.relPath).toBe('example.com/page.php.html');
  });

  it('preserves nested directory segments', () => {
    const m = mapUrlToLocal('https://example.com/a/b/c', OUT, 'page');
    expect(m.relPath).toBe('example.com/a/b/c.html');
  });
});

describe('mapUrlToLocal — asset mapping rules', () => {
  it('maps an asset under _assets/<host>/<path>', () => {
    const m = mapUrlToLocal('https://cdn.example.com/img/logo.png', OUT, 'asset');
    expect(m.relPath).toBe('_assets/cdn.example.com/img/logo.png');
  });

  it('keeps an extensionless asset filename unchanged (no .html)', () => {
    const m = mapUrlToLocal('https://cdn.example.com/data', OUT, 'asset');
    expect(m.relPath).toBe('_assets/cdn.example.com/data');
  });

  it('maps a trailing-slash asset URL to .../index.html', () => {
    const m = mapUrlToLocal('https://cdn.example.com/dir/', OUT, 'asset');
    expect(m.relPath).toBe('_assets/cdn.example.com/dir/index.html');
  });
});

describe('mapUrlToLocal — query hash', () => {
  it('inserts _q<8 hex> before the extension for a page', () => {
    const m = mapUrlToLocal('https://example.com/search?q=foo', OUT, 'page');
    expect(m.relPath).toBe(`example.com/search_q${q8('q=foo')}.html`);
  });

  it('inserts _q<8 hex> before the extension for an asset', () => {
    const m = mapUrlToLocal('https://cdn.example.com/style.css?v=2', OUT, 'asset');
    expect(m.relPath).toBe(`_assets/cdn.example.com/style_q${q8('v=2')}.css`);
  });

  it('hashes the query string without the leading ?', () => {
    const m = mapUrlToLocal('https://example.com/x?a=1&b=2', OUT, 'page');
    expect(m.relPath).toBe(`example.com/x_q${q8('a=1&b=2')}.html`);
  });

  it('produces different files for different query strings, same path', () => {
    const a = mapUrlToLocal('https://example.com/x?a=1', OUT, 'page');
    const b = mapUrlToLocal('https://example.com/x?a=2', OUT, 'page');
    expect(a.relPath).not.toBe(b.relPath);
  });

  it('is deterministic (same URL → same mapping)', () => {
    const a = mapUrlToLocal('https://example.com/x?a=1', OUT, 'page');
    const b = mapUrlToLocal('https://example.com/x?a=1', OUT, 'page');
    expect(a.relPath).toBe(b.relPath);
  });
});

describe('mapUrlToLocal — segment sanitization', () => {
  it('percent-decodes, replaces disallowed characters with _, and disambiguates', () => {
    const m = mapUrlToLocal('https://example.com/foo bar/baz%20qux', OUT, 'page');
    // Substitution is lossy, so each altered path segment gains a hash of its
    // decoded original (inserted before the extension) to avoid collisions.
    expect(m.relPath).toBe(
      `example.com/foo_bar_h${h8('foo bar')}/baz_qux_h${h8('baz qux')}.html`,
    );
  });

  it('does not disambiguate an already-safe path (no substitution)', () => {
    const m = mapUrlToLocal('https://example.com/a/b/c', OUT, 'page');
    expect(m.relPath).toBe('example.com/a/b/c.html');
  });

  it('maps distinct URLs colliding under substitution to distinct files', () => {
    // café (%C3%A9) and cafè (%C3%A8) both replace to "caf_"; the guard keeps
    // them apart so one does not silently overwrite the other.
    const a = mapUrlToLocal('https://example.com/caf%C3%A9', OUT, 'page');
    const b = mapUrlToLocal('https://example.com/caf%C3%A8', OUT, 'page');
    expect(a.relPath).not.toBe(b.relPath);
    expect(a.relPath.startsWith('example.com/caf_')).toBe(true);
    expect(b.relPath.startsWith('example.com/caf_')).toBe(true);
  });

  it('sanitizes host characters (port colon → _) without a disambiguation hash', () => {
    const m = mapUrlToLocal('https://example.com:8080/', OUT, 'page');
    expect(m.relPath).toBe('example.com_8080/index.html');
  });
});

describe('sanitizePathSegment — collision guard', () => {
  it('leaves an already-safe segment untouched (no hash)', () => {
    expect(sanitizePathSegment('logo-2.min.js')).toBe('logo-2.min.js');
  });

  it('appends a hash before the extension when substitution alters the segment', () => {
    // The hash is of the whole decoded segment; it lands before the extension.
    expect(sanitizePathSegment('my file.png')).toBe(`my_file_h${h8('my file.png')}.png`);
  });

  it('keeps distinct originals distinct after substitution (café vs cafè)', () => {
    expect(sanitizePathSegment('caf%C3%A9')).not.toBe(sanitizePathSegment('caf%C3%A8'));
  });

  it('is deterministic (same input → same output)', () => {
    expect(sanitizePathSegment('café')).toBe(sanitizePathSegment('café'));
  });

  it('caps an over-long segment at 100 chars with an 8-hex suffix', () => {
    const out = sanitizePathSegment('a'.repeat(120));
    expect(out.length).toBe(100);
    expect(out).toMatch(/_[0-9a-f]{8}$/);
  });
});

describe('sanitizeSegment', () => {
  it('leaves an already-safe segment untouched', () => {
    expect(sanitizeSegment('logo-2.min.js')).toBe('logo-2.min.js');
  });

  it('replaces every character outside [A-Za-z0-9._-] with _', () => {
    expect(sanitizeSegment('a b/c')).toBe('a_b_c');
    expect(sanitizeSegment('café')).toBe('caf_');
  });

  it('percent-decodes before sanitizing', () => {
    expect(sanitizeSegment('a%20b')).toBe('a_b');
  });

  it('tolerates a malformed percent escape', () => {
    expect(sanitizeSegment('a%zzb')).toBe('a_zzb');
  });

  it('caps an over-long segment at 100 chars with an 8-hex suffix', () => {
    const long = 'a'.repeat(120);
    const out = sanitizeSegment(long);
    expect(out.length).toBe(100);
    expect(out.startsWith('a'.repeat(91) + '_')).toBe(true);
    expect(out).toMatch(/_[0-9a-f]{8}$/);
  });
});

describe('isPageExtension', () => {
  it('treats an empty extension as a page', () => {
    expect(isPageExtension('')).toBe(true);
  });

  it('treats HTML-ish extensions as pages (case-insensitive)', () => {
    expect(isPageExtension('html')).toBe(true);
    expect(isPageExtension('HTML')).toBe(true);
    expect(isPageExtension('php')).toBe(true);
    expect(isPageExtension('aspx')).toBe(true);
  });

  it('treats binary/asset extensions as non-pages', () => {
    expect(isPageExtension('png')).toBe(false);
    expect(isPageExtension('css')).toBe(false);
    expect(isPageExtension('pdf')).toBe(false);
  });
});

describe('computeScopeRoot', () => {
  it('strips a leading www.', () => {
    expect(computeScopeRoot('https://www.example.com/x')).toBe('example.com');
  });

  it('lowercases the host', () => {
    expect(computeScopeRoot('https://EXAMPLE.com/')).toBe('example.com');
  });

  it('keeps a non-www subdomain', () => {
    expect(computeScopeRoot('https://docs.example.com/')).toBe('docs.example.com');
  });
});

describe('isInPageScope — scope rule', () => {
  const root = 'example.com';

  it('accepts the exact host', () => {
    expect(isInPageScope('https://example.com/x', root, true)).toBe(true);
  });

  it('accepts a www. variant of the exact host even without subdomains', () => {
    expect(isInPageScope('https://www.example.com/x', root, false)).toBe(true);
  });

  it('accepts a subdomain when subdomains are allowed', () => {
    expect(isInPageScope('https://docs.example.com/x', root, true)).toBe(true);
  });

  it('rejects a subdomain when subdomains are disallowed (--no-subdomains)', () => {
    expect(isInPageScope('https://docs.example.com/x', root, false)).toBe(false);
  });

  it('rejects an unrelated domain', () => {
    expect(isInPageScope('https://evil.com/x', root, true)).toBe(false);
    expect(isInPageScope('https://notexample.com/x', root, true)).toBe(false);
  });

  it('rejects the ancestor domain when seeding a subdomain', () => {
    // Seeding docs.example.com must not pull in example.com.
    expect(isInPageScope('https://example.com/x', 'docs.example.com', true)).toBe(false);
  });

  it('rejects a sibling registrable-domain host (never registrable-domain logic)', () => {
    // Seeding foo.gov.uk must not pull in bar.gov.uk (or all of gov.uk).
    expect(isInPageScope('https://bar.gov.uk/x', 'foo.gov.uk', true)).toBe(false);
    expect(isInPageScope('https://gov.uk/x', 'foo.gov.uk', true)).toBe(false);
  });

  it('returns false for an unparseable URL', () => {
    expect(isInPageScope('http://[bad', root, true)).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('resolves a root-relative reference against a base', () => {
    expect(normalizeUrl('/about', 'https://example.com/blog/')).toBe('https://example.com/about');
  });

  it('resolves a document-relative reference against a base', () => {
    expect(normalizeUrl('page2', 'https://example.com/dir/page1')).toBe(
      'https://example.com/dir/page2',
    );
  });

  it('strips the fragment', () => {
    expect(normalizeUrl('https://example.com/x#sec')).toBe('https://example.com/x');
  });

  it('returns null for non-http(s) schemes', () => {
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('data:text/plain,hi')).toBeNull();
  });

  it('returns null for an unparseable reference', () => {
    expect(normalizeUrl('http://[bad')).toBeNull();
  });
});

describe('relativeRef — relative path between mapped locations', () => {
  it('computes a page → _assets reference from the site root', () => {
    expect(relativeRef('example.com/index.html', '_assets/cdn.example.com/logo.png')).toBe(
      '../_assets/cdn.example.com/logo.png',
    );
  });

  it('computes a nested page → _assets reference', () => {
    expect(
      relativeRef('example.com/blog/post.html', '_assets/example.com/img/x.png'),
    ).toBe('../../_assets/example.com/img/x.png');
  });

  it('computes a sibling page reference within the same directory', () => {
    expect(relativeRef('example.com/a.html', 'example.com/b.html')).toBe('b.html');
  });

  it('returns the basename when source and target are the same file', () => {
    expect(relativeRef('example.com/index.html', 'example.com/index.html')).toBe('index.html');
  });

  it('computes a nested page → shallower page reference', () => {
    expect(relativeRef('example.com/a/b/c.html', 'example.com/index.html')).toBe(
      '../../index.html',
    );
  });
});
