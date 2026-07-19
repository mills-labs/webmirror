/**
 * Unit tests for src/rewrite.ts (spec T-unit: srcset parsing, CSS url()
 * rewriting, HTML rewriting). Written against the CURRENT implementation.
 */

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  parseSrcset,
  rewriteSrcset,
  rewriteCss,
  rewriteHtml,
  type RefResolver,
} from '../src/rewrite';

/** Resolver factory: map listed refs to a localized value; everything else untouched. */
function localizer(map: Record<string, string>, localized = true): RefResolver {
  return (raw: string) => (raw in map ? { value: map[raw], localized } : null);
}

describe('parseSrcset', () => {
  it('parses candidates with density descriptors', () => {
    expect(parseSrcset('a.jpg 1x, b.jpg 2x')).toEqual([
      { url: 'a.jpg', descriptor: '1x' },
      { url: 'b.jpg', descriptor: '2x' },
    ]);
  });

  it('parses candidates with width descriptors', () => {
    expect(parseSrcset('a.jpg 640w, b.jpg 1280w')).toEqual([
      { url: 'a.jpg', descriptor: '640w' },
      { url: 'b.jpg', descriptor: '1280w' },
    ]);
  });

  it('parses a single URL with no descriptor', () => {
    expect(parseSrcset('a.jpg')).toEqual([{ url: 'a.jpg', descriptor: '' }]);
  });

  it('skips empty candidates and tolerates extra whitespace', () => {
    expect(parseSrcset('  a.jpg 1x ,, b.jpg 2x ')).toEqual([
      { url: 'a.jpg', descriptor: '1x' },
      { url: 'b.jpg', descriptor: '2x' },
    ]);
  });
});

describe('rewriteSrcset', () => {
  it('rewrites each URL and preserves its descriptor', () => {
    const resolve = localizer({ 'a.jpg': 'local/a.jpg', 'b.jpg': 'local/b.jpg' });
    expect(rewriteSrcset('a.jpg 1x, b.jpg 2x', resolve)).toBe('local/a.jpg 1x, local/b.jpg 2x');
  });

  it('leaves unresolved candidates unchanged', () => {
    const resolve = localizer({ 'a.jpg': 'local/a.jpg' });
    expect(rewriteSrcset('a.jpg 1x, b.jpg 2x', resolve)).toBe('local/a.jpg 1x, b.jpg 2x');
  });

  it('reassembles with a comma-space separator', () => {
    const resolve = localizer({});
    expect(rewriteSrcset('a.jpg 1x,b.jpg 2x', resolve)).toBe('a.jpg 1x, b.jpg 2x');
  });
});

describe('rewriteCss', () => {
  it('rewrites an unquoted url() target', () => {
    const resolve = localizer({ 'img.png': 'foo.png' });
    expect(rewriteCss('.x{background:url(img.png)}', resolve)).toBe('.x{background:url(foo.png)}');
  });

  it('preserves single quotes around a url() target', () => {
    const resolve = localizer({ 'img.png': 'foo.png' });
    expect(rewriteCss(".x{background:url('img.png')}", resolve)).toBe(
      ".x{background:url('foo.png')}",
    );
  });

  it('preserves double quotes around a url() target', () => {
    const resolve = localizer({ 'img.png': 'foo.png' });
    expect(rewriteCss('.x{background:url("img.png")}', resolve)).toBe(
      '.x{background:url("foo.png")}',
    );
  });

  it('trims whitespace inside url( ... ) before resolving', () => {
    const resolve = localizer({ 'img.png': 'foo.png' });
    expect(rewriteCss('.x{background:url(  img.png  )}', resolve)).toBe(
      '.x{background:url(foo.png)}',
    );
  });

  it('rewrites multiple url() targets', () => {
    const resolve = localizer({ 'a.png': 'x.png', 'b.png': 'y.png' });
    expect(rewriteCss('a{background:url(a.png)} b{background:url(b.png)}', resolve)).toBe(
      'a{background:url(x.png)} b{background:url(y.png)}',
    );
  });

  it('rewrites a quoted @import target', () => {
    const resolve = localizer({ 'base.css': 'local.css' });
    expect(rewriteCss("@import 'base.css';", resolve)).toBe("@import 'local.css';");
  });

  it('leaves url() targets the resolver declines unchanged', () => {
    const resolve = localizer({});
    expect(rewriteCss('.x{background:url(keep.png)}', resolve)).toBe('.x{background:url(keep.png)}');
  });
});

describe('rewriteHtml', () => {
  it('removes <base> tags', () => {
    const out = rewriteHtml('<base href="https://example.com/"><a href="y">l</a>', localizer({}));
    expect(out).not.toContain('<base');
  });

  it('rewrites a[href] and img[src]', () => {
    const resolve = localizer({ 'p.html': 'other.html', 'i.png': 'img.png' }, false);
    const out = rewriteHtml('<a href="p.html">l</a><img src="i.png">', resolve);
    const $ = cheerio.load(out);
    expect($('a').attr('href')).toBe('other.html');
    expect($('img').attr('src')).toBe('img.png');
  });

  it('leaves references the resolver declines unchanged', () => {
    const out = rewriteHtml('<a href="https://ext.com/x">l</a>', localizer({}));
    const $ = cheerio.load(out);
    expect($('a').attr('href')).toBe('https://ext.com/x');
  });

  it('strips integrity and crossorigin on a localized tag', () => {
    const resolve = localizer({ 's.js': 'local/s.js' }, true);
    const out = rewriteHtml(
      '<script src="s.js" integrity="sha256-x" crossorigin="anonymous"></script>',
      resolve,
    );
    const $ = cheerio.load(out);
    expect($('script').attr('src')).toBe('local/s.js');
    expect($('script').attr('integrity')).toBeUndefined();
    expect($('script').attr('crossorigin')).toBeUndefined();
  });

  it('keeps integrity and crossorigin when the target was not localized', () => {
    const resolve = localizer({ 's.js': 'https://cdn/s.js' }, false);
    const out = rewriteHtml(
      '<script src="s.js" integrity="sha256-x" crossorigin="anonymous"></script>',
      resolve,
    );
    const $ = cheerio.load(out);
    expect($('script').attr('src')).toBe('https://cdn/s.js');
    expect($('script').attr('integrity')).toBe('sha256-x');
    expect($('script').attr('crossorigin')).toBe('anonymous');
  });

  it('rewrites a srcset attribute', () => {
    const resolve = localizer({ 'a.jpg': 'local/a.jpg', 'b.jpg': 'local/b.jpg' });
    const out = rewriteHtml('<img srcset="a.jpg 1x, b.jpg 2x">', resolve);
    const $ = cheerio.load(out);
    expect($('img').attr('srcset')).toBe('local/a.jpg 1x, local/b.jpg 2x');
  });

  it('rewrites an inline style attribute', () => {
    const resolve = localizer({ 'bg.png': 'local/bg.png' });
    const out = rewriteHtml('<div style="background:url(bg.png)"></div>', resolve);
    const $ = cheerio.load(out);
    expect($('div').attr('style')).toBe('background:url(local/bg.png)');
  });

  it('rewrites a <style> block', () => {
    const resolve = localizer({ 'bg.png': 'local/bg.png' });
    const out = rewriteHtml('<style>.x{background:url(bg.png)}</style>', resolve);
    const $ = cheerio.load(out);
    expect($('style').html()).toContain('url(local/bg.png)');
  });
});
