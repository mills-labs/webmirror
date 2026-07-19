/**
 * Pass-2 rewriting primitives.
 *
 * These functions are purely mechanical: they locate every URL-bearing spot in
 * HTML, CSS, or a srcset attribute and hand each raw reference to a resolver.
 * The resolver (owned by the mirror engine) decides what a reference becomes —
 * a relative local path, an absolute web URL, or unchanged. Keeping the policy
 * in the resolver leaves this module small, deterministic, and easy to test.
 */

import * as cheerio from 'cheerio';

/**
 * Result of resolving one reference:
 *  - null           → leave the reference exactly as it is.
 *  - { value, localized } → replace with `value`; `localized` is true when the
 *    reference now points at a mirrored local file (so integrity/crossorigin
 *    can be stripped), false when it was rewritten to an absolute web URL.
 */
export type RefResolution = { value: string; localized: boolean } | null;
export type RefResolver = (rawRef: string) => RefResolution;

/** Plain URL attributes keyed by CSS selector. */
const URL_ATTRIBUTES: ReadonlyArray<{ selector: string; attr: string }> = [
  { selector: 'a[href]', attr: 'href' },
  { selector: 'link[href]', attr: 'href' },
  { selector: 'script[src]', attr: 'src' },
  { selector: 'img[src]', attr: 'src' },
  { selector: 'iframe[src]', attr: 'src' },
  { selector: 'source[src]', attr: 'src' },
  { selector: 'video[src]', attr: 'src' },
  { selector: 'video[poster]', attr: 'poster' },
  { selector: 'audio[src]', attr: 'src' },
  { selector: 'track[src]', attr: 'src' },
  { selector: 'object[data]', attr: 'data' },
  { selector: 'embed[src]', attr: 'src' },
];

/** srcset-valued attributes keyed by CSS selector. */
const SRCSET_ATTRIBUTES: ReadonlyArray<{ selector: string; attr: string }> = [
  { selector: 'img[srcset]', attr: 'srcset' },
  { selector: 'source[srcset]', attr: 'srcset' },
];

/**
 * Parse a srcset value into its candidates, preserving each descriptor
 * (e.g. `2x`, `640w`) and empty descriptors alike.
 */
export function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
  const out: Array<{ url: string; descriptor: string }> = [];
  for (const raw of value.split(',')) {
    const candidate = raw.trim();
    if (!candidate) continue;
    const spaceIdx = candidate.search(/\s/);
    if (spaceIdx === -1) {
      out.push({ url: candidate, descriptor: '' });
    } else {
      out.push({
        url: candidate.slice(0, spaceIdx),
        descriptor: candidate.slice(spaceIdx).trim(),
      });
    }
  }
  return out;
}

/** Rewrite every URL in a srcset value and reassemble it. */
export function rewriteSrcset(value: string, resolve: RefResolver): string {
  const candidates = parseSrcset(value);
  const rebuilt = candidates.map(({ url, descriptor }) => {
    const resolution = resolve(url);
    const newUrl = resolution ? resolution.value : url;
    return descriptor ? `${newUrl} ${descriptor}` : newUrl;
  });
  return rebuilt.join(', ');
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_STRING_RE = /@import\s+(['"])([^'"]+)\1/gi;

/**
 * Rewrite `url(...)` targets and bare-string `@import` targets in CSS text
 * (a stylesheet file, a `<style>` block, or a `style` attribute value).
 */
export function rewriteCss(css: string, resolve: RefResolver): string {
  let out = css.replace(CSS_URL_RE, (match, quote: string, ref: string) => {
    const trimmed = ref.trim();
    const resolution = resolve(trimmed);
    if (!resolution) return match;
    return `url(${quote}${resolution.value}${quote})`;
  });
  out = out.replace(CSS_IMPORT_STRING_RE, (match, quote: string, ref: string) => {
    const resolution = resolve(ref.trim());
    if (!resolution) return match;
    return `@import ${quote}${resolution.value}${quote}`;
  });
  return out;
}

/**
 * Rewrite an HTML document for offline navigation:
 *  - remove `<base>` tags (they break relative navigation);
 *  - rewrite plain URL attributes, srcset attributes, inline `style` attributes
 *    and `<style>` blocks;
 *  - on tags whose URL was localized, strip `integrity` and `crossorigin`.
 */
export function rewriteHtml(html: string, resolve: RefResolver): string {
  const $ = cheerio.load(html);

  $('base').remove();

  for (const { selector, attr } of URL_ATTRIBUTES) {
    $(selector).each((_, el) => {
      const node = $(el);
      const raw = node.attr(attr);
      if (raw === undefined) return;
      const resolution = resolve(raw);
      if (!resolution) return;
      node.attr(attr, resolution.value);
      if (resolution.localized) stripIntegrity(node);
    });
  }

  for (const { selector, attr } of SRCSET_ATTRIBUTES) {
    $(selector).each((_, el) => {
      const node = $(el);
      const raw = node.attr(attr);
      if (raw === undefined) return;
      const rewritten = rewriteSrcset(raw, resolve);
      if (rewritten !== raw) {
        node.attr(attr, rewritten);
        stripIntegrity(node);
      }
    });
  }

  $('[style]').each((_, el) => {
    const node = $(el);
    const raw = node.attr('style');
    if (raw === undefined) return;
    const rewritten = rewriteCss(raw, resolve);
    if (rewritten !== raw) node.attr('style', rewritten);
  });

  $('style').each((_, el) => {
    const node = $(el);
    const raw = node.html();
    if (raw === null) return;
    const rewritten = rewriteCss(raw, resolve);
    if (rewritten !== raw) node.text(rewritten);
  });

  return $.html();
}

function stripIntegrity(node: cheerio.Cheerio<any>): void {
  node.removeAttr('integrity');
  node.removeAttr('crossorigin');
}
