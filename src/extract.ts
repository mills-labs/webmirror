/**
 * Link and asset extraction for pass 1.
 *
 * Given a page's HTML, classifies every reference into navigable pages (kept
 * only when in page scope) and downloadable assets (kept from any host). All
 * URLs are resolved against the page's effective base (honouring a `<base>`
 * tag) and returned normalized and fragment-free.
 */

import * as cheerio from 'cheerio';
import { isInPageScope, isPageExtension, normalizeUrl } from './url-map';
import { posix } from 'path';

export interface ExtractResult {
  /** In-scope navigable page URLs (fragmentless, deduped). */
  pageLinks: string[];
  /** Asset URLs from any host (fragmentless, deduped). */
  assetLinks: string[];
}

/** rel tokens on <link> that identify a downloadable asset. */
const ASSET_LINK_RELS = new Set([
  'stylesheet',
  'icon',
  'shortcut icon',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'manifest',
  'preload',
  'prefetch',
  'mask-icon',
]);

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function extensionOf(pathname: string): string {
  const ext = posix.extname(pathname);
  return ext ? ext.slice(1).toLowerCase() : '';
}

/**
 * The effective base URL a browser uses to resolve a page's relative references:
 * the page URL, overridden by a `<base href>` tag when present. Pass 1 resolves
 * links against this; pass 2 must use the identical base so rewritten references
 * match the files that were actually downloaded.
 */
export function effectiveBaseUrl(html: string, pageUrl: string): string {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').first().attr('href');
  return baseHref ? normalizeUrl(baseHref, pageUrl) ?? pageUrl : pageUrl;
}

export function extractLinks(
  html: string,
  pageUrl: string,
  scopeRoot: string,
  allowSubdomains: boolean,
): ExtractResult {
  const $ = cheerio.load(html);

  const base = effectiveBaseUrl(html, pageUrl);

  const pages = new Set<string>();
  const assets = new Set<string>();

  const addAsset = (ref: string | undefined) => {
    if (!ref) return;
    const abs = normalizeUrl(ref, base);
    if (abs) assets.add(abs);
  };

  const addFromSrcset = (value: string | undefined) => {
    if (!value) return;
    for (const candidate of value.split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      addAsset(url);
    }
  };

  const addFromCss = (css: string | undefined) => {
    if (!css) return;
    let m: RegExpExecArray | null;
    CSS_URL_RE.lastIndex = 0;
    while ((m = CSS_URL_RE.exec(css)) !== null) {
      const ref = m[2].trim();
      if (!ref.startsWith('data:')) addAsset(ref);
    }
  };

  // Navigable links.
  $('a[href]').each((_, el) => {
    const abs = normalizeUrl($(el).attr('href')!, base);
    if (!abs) return;
    if (!isInPageScope(abs, scopeRoot, allowSubdomains)) return;
    // In-scope: HTML-ish/extensionless → page; a document extension → asset.
    const ext = extensionOf(new URL(abs).pathname);
    if (isPageExtension(ext)) pages.add(abs);
    else assets.add(abs);
  });

  $('iframe[src]').each((_, el) => {
    const abs = normalizeUrl($(el).attr('src')!, base);
    if (abs && isInPageScope(abs, scopeRoot, allowSubdomains)) pages.add(abs);
  });

  // Assets from any host.
  $('img[src]').each((_, el) => addAsset($(el).attr('src')));
  $('img[srcset], source[srcset]').each((_, el) => addFromSrcset($(el).attr('srcset')));
  $('script[src]').each((_, el) => addAsset($(el).attr('src')));
  $('source[src], video[src], audio[src], track[src], embed[src]').each((_, el) =>
    addAsset($(el).attr('src')),
  );
  $('video[poster]').each((_, el) => addAsset($(el).attr('poster')));
  $('object[data]').each((_, el) => addAsset($(el).attr('data')));

  $('link[href]').each((_, el) => {
    const rel = ($(el).attr('rel') ?? '').toLowerCase().trim();
    if (rel && (ASSET_LINK_RELS.has(rel) || rel.split(/\s+/).some((r) => ASSET_LINK_RELS.has(r)))) {
      addAsset($(el).attr('href'));
    }
  });

  $('[style]').each((_, el) => addFromCss($(el).attr('style')));
  $('style').each((_, el) => addFromCss($(el).html() ?? undefined));

  return { pageLinks: [...pages], assetLinks: [...assets] };
}

/** Extract `url(...)` and `@import` targets from a CSS stylesheet body. */
export function extractCssRefs(css: string, cssUrl: string): string[] {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;

  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(css)) !== null) {
    const ref = m[2].trim();
    if (ref.startsWith('data:')) continue;
    const abs = normalizeUrl(ref, cssUrl);
    if (abs) refs.add(abs);
  }

  const importRe = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/gi;
  while ((m = importRe.exec(css)) !== null) {
    const abs = normalizeUrl(m[2].trim(), cssUrl);
    if (abs) refs.add(abs);
  }

  return [...refs];
}
