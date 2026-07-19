/**
 * End-to-end mirror test.
 *
 * Stands up a local HTTP fixture site (plus a second server on another port that
 * hosts one cross-host asset), mirrors it through the engine API, then walks
 * every saved HTML file and asserts the offline-navigability contract: every
 * internal href/src/url() resolves to a file that actually exists on disk, while
 * the link to a genuinely external site stays an absolute web URL.
 *
 * The fixture covers the specification's E2E cases: nested pages, an
 * extensionless URL, a query-string URL, CSS with url() + @import, an inline
 * <style> block and a style attribute, srcset, an image, a PDF-like binary, an
 * in-scope document linked as an asset, a cross-host asset, an external site
 * link, and a JS-shell page (saved as-is under --browser never).
 *
 * Playwright-dependent rendering and the example.com network smoke skip
 * gracefully when the browser or the network is unavailable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, posix } from 'path';
import * as cheerio from 'cheerio';

import { mirror, type MirrorOptions } from '../src/mirror';
import { mapUrlToLocal } from '../src/url-map';

// --- fixture assets ---------------------------------------------------------

/** A 1x1 transparent PNG — real bytes, so stored assets are non-trivial. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A minimal but structurally valid PDF blob (PDF magic bytes at the head). */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf-8',
);

const APP_MARKER = 'PLAYWRIGHT_RENDERED_MARKER_7f3a';
const APP_JS = `document.getElementById('root').textContent = '${APP_MARKER} ' + 'lorem '.repeat(40);`;

const LOREM =
  'This paragraph exists so the visible text of the page comfortably exceeds the ' +
  'one hundred and fifty character threshold that the JavaScript-shell heuristic ' +
  'uses, keeping static rendering deterministic for the navigability assertions.';

const EXTERNAL_SITE = 'https://example.com/about';

// --- fixture servers --------------------------------------------------------

interface Started {
  server: Server;
  port: number;
}

function startServer(routes: Map<string, { type: string; body: Buffer | string }>): Promise<Started> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://placeholder').pathname;
    const route = routes.get(path);
    if (!route) {
      // Unknown paths (including /robots.txt) 404 → engine treats robots as allow-all.
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': route.type });
    res.end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- offline / playwright capability probes (top-level so skipIf can read them) ---

async function detectOnline(): Promise<boolean> {
  try {
    const res = await fetch('https://example.com', { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function detectPlaywright(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

// Populated by the file-level beforeAll (top-level await is unavailable under
// this project's CommonJS module target); the conditional tests skip on false.
let online = false;
let hasPlaywright = false;

// --- HTML walk helpers ------------------------------------------------------

const URL_ATTR_SELECTORS: ReadonlyArray<{ selector: string; attr: string }> = [
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

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/gi;

/** Recursively list every *.html / *.htm file under a directory (POSIX rel paths). */
function listHtmlFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    const childRel = rel ? posix.join(rel, name) : name;
    const abs = join(root, childRel);
    if (statSync(abs).isDirectory()) {
      out.push(...listHtmlFiles(root, childRel));
    } else if (/\.html?$/i.test(name)) {
      out.push(childRel);
    }
  }
  return out;
}

function isExternalRef(ref: string): boolean {
  const l = ref.trim().toLowerCase();
  return /^[a-z][a-z0-9+.-]*:/.test(l) || l.startsWith('//');
}

function isNonNavigable(ref: string): boolean {
  const l = ref.trim().toLowerCase();
  return l === '' || l.startsWith('#') || /^(data|mailto|tel|javascript|blob|about):/.test(l);
}

/** Extract url() and @import targets from a CSS-ish string. */
function cssRefs(css: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(css)) !== null) refs.push(m[2].trim());
  CSS_IMPORT_RE.lastIndex = 0;
  while ((m = CSS_IMPORT_RE.exec(css)) !== null) refs.push(m[2].trim());
  return refs;
}

interface Classified {
  /** Relative refs and their resolved on-disk existence. */
  local: Array<{ ref: string; resolvedRel: string; exists: boolean }>;
  /** Absolute web / protocol-relative refs (should be external only). */
  external: string[];
}

/** Collect every URL-bearing reference in one saved HTML file and classify it. */
function classifyHtml(outDir: string, fileRel: string): Classified {
  const html = readFileSync(join(outDir, fileRel), 'utf-8');
  const $ = cheerio.load(html);
  const raw: string[] = [];

  for (const { selector, attr } of URL_ATTR_SELECTORS) {
    $(selector).each((_, el) => {
      const v = $(el).attr(attr);
      if (v !== undefined) raw.push(v);
    });
  }
  $('img[srcset], source[srcset]').each((_, el) => {
    const v = $(el).attr('srcset');
    if (!v) return;
    for (const cand of v.split(',')) {
      const url = cand.trim().split(/\s+/)[0];
      if (url) raw.push(url);
    }
  });
  $('[style]').each((_, el) => {
    raw.push(...cssRefs($(el).attr('style') ?? ''));
  });
  $('style').each((_, el) => {
    raw.push(...cssRefs($(el).html() ?? ''));
  });

  const local: Classified['local'] = [];
  const external: string[] = [];
  const fromDir = posix.dirname(fileRel);

  for (const ref of raw) {
    if (isNonNavigable(ref)) continue;
    if (isExternalRef(ref)) {
      external.push(ref.trim());
      continue;
    }
    const bare = ref.trim().split(/[?#]/)[0];
    if (!bare) continue;
    const resolvedRel = posix.normalize(posix.join(fromDir, bare));
    local.push({ ref: ref.trim(), resolvedRel, exists: existsSync(join(outDir, resolvedRel)) });
  }
  return { local, external };
}

// --- shared mirror run ------------------------------------------------------

let outDir: string;
let seedBase: string; // http://127.0.0.1:<portA>
let serverA: Started;
let serverB: Started;

function baseOptions(seedUrl: string, dir: string): MirrorOptions {
  return {
    seedUrl,
    outDir: dir,
    maxPages: 0,
    delayMs: 0,
    browser: 'never',
    subdomains: true,
    respectRobots: true,
    maxFileSizeBytes: 0,
    userAgent: 'webmirror-e2e-test',
    fresh: true,
  };
}

beforeAll(async () => {
  // Capability probes for the gracefully-skipping tests.
  [online, hasPlaywright] = await Promise.all([detectOnline(), detectPlaywright()]);

  // Second server (a different host string: localhost) hosts the cross-host asset.
  const routesB = new Map<string, { type: string; body: Buffer | string }>([
    ['/logo.png', { type: 'image/png', body: PNG }],
  ]);
  serverB = await startServer(routesB);
  const externalAsset = `http://localhost:${serverB.port}/logo.png`;

  const mainCss = `@import "base.css";\nbody { background: url("../img/bg.png"); }\n`;
  // base.css carries a cross-host url() so pass-2 CSS rewriting is genuinely exercised.
  const baseCss = `.x { background: url("../img/bg2.png"); }\n.y { background: url("${externalAsset}"); }\n`;

  const indexHtml = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Fixture Home</title>
<link rel="stylesheet" href="/styles/main.css">
<style>.hero { background: url('/img/bg.png'); }</style>
</head><body>
<h1>Home</h1>
<p>${LOREM}</p>
<nav>
  <a href="/about#intro">About</a>
  <a href="/blog/post.html">Post</a>
  <a href="/search?q=cats">Search cats</a>
  <a href="/app">App</a>
  <a href="/files/doc.pdf">Download PDF</a>
  <a href="${EXTERNAL_SITE}">External site</a>
</nav>
<img src="/img/photo.png" alt="photo">
<img srcset="/img/photo.png 1x, /img/photo2.png 2x" alt="responsive">
<img src="${externalAsset}" alt="cross-host asset">
<div style="background: url('/img/bg2.png')">styled</div>
</body></html>`;

  const aboutHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title></head><body>
<h1 id="intro">About</h1><p>${LOREM}</p>
<a href="/">Home</a>
<img src="/img/photo.png" alt="photo">
</body></html>`;

  const postHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Post</title></head><body>
<h1>Post</h1><p>${LOREM}</p>
<a href="/">Home</a> <a href="/about">About</a>
<img src="../img/photo.png" alt="relative cross-dir asset">
</body></html>`;

  const searchHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search</title></head><body>
<h1>Search results</h1><p>${LOREM}</p>
<a href="/">Home</a>
</body></html>`;

  const appHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head><body>
<div id="root"></div>
<script src="/app.js"></script>
<a href="/">Home</a>
</body></html>`;

  const routesA = new Map<string, { type: string; body: Buffer | string }>([
    ['/', { type: 'text/html; charset=utf-8', body: indexHtml }],
    ['/about', { type: 'text/html; charset=utf-8', body: aboutHtml }],
    ['/blog/post.html', { type: 'text/html; charset=utf-8', body: postHtml }],
    ['/search', { type: 'text/html; charset=utf-8', body: searchHtml }],
    ['/app', { type: 'text/html; charset=utf-8', body: appHtml }],
    ['/app.js', { type: 'application/javascript', body: APP_JS }],
    ['/styles/main.css', { type: 'text/css', body: mainCss }],
    ['/styles/base.css', { type: 'text/css', body: baseCss }],
    ['/img/photo.png', { type: 'image/png', body: PNG }],
    ['/img/photo2.png', { type: 'image/png', body: PNG }],
    ['/img/bg.png', { type: 'image/png', body: PNG }],
    ['/img/bg2.png', { type: 'image/png', body: PNG }],
    ['/files/doc.pdf', { type: 'application/pdf', body: PDF }],
  ]);
  serverA = await startServer(routesA);
  seedBase = `http://127.0.0.1:${serverA.port}`;

  outDir = mkdtempSync(join(tmpdir(), 'webmirror-e2e-'));
  await mirror(baseOptions(`${seedBase}/`, outDir));
}, 60000);

afterAll(async () => {
  if (serverA) await stopServer(serverA.server);
  if (serverB) await stopServer(serverB.server);
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

// helper to map a fixture URL to its expected on-disk absolute path
const mappedAbs = (url: string, kind: 'page' | 'asset') => mapUrlToLocal(url, outDir, kind).absPath;

describe('E2E: fixture-site mirror', () => {
  it('mirrors every fixture page and asset to its mapped location', () => {
    // Pages.
    expect(existsSync(mappedAbs(`${seedBase}/`, 'page'))).toBe(true); // seed → index.html
    expect(existsSync(mappedAbs(`${seedBase}/about`, 'page'))).toBe(true); // extensionless → about.html
    expect(existsSync(mappedAbs(`${seedBase}/blog/post.html`, 'page'))).toBe(true); // nested
    expect(existsSync(mappedAbs(`${seedBase}/search?q=cats`, 'page'))).toBe(true); // query → _q hash
    expect(existsSync(mappedAbs(`${seedBase}/app`, 'page'))).toBe(true); // JS-shell page

    // Assets (same host).
    expect(existsSync(mappedAbs(`${seedBase}/img/photo.png`, 'asset'))).toBe(true);
    expect(existsSync(mappedAbs(`${seedBase}/img/photo2.png`, 'asset'))).toBe(true);
    expect(existsSync(mappedAbs(`${seedBase}/img/bg.png`, 'asset'))).toBe(true);
    expect(existsSync(mappedAbs(`${seedBase}/img/bg2.png`, 'asset'))).toBe(true);
    expect(existsSync(mappedAbs(`${seedBase}/styles/main.css`, 'asset'))).toBe(true);
    expect(existsSync(mappedAbs(`${seedBase}/styles/base.css`, 'asset'))).toBe(true);
    expect(existsSync(mappedAbs(`${seedBase}/app.js`, 'asset'))).toBe(true);
    expect(existsSync(mappedAbs(`${seedBase}/files/doc.pdf`, 'asset'))).toBe(true); // in-scope document

    // The PDF was stored byte-for-byte.
    expect(readFileSync(mappedAbs(`${seedBase}/files/doc.pdf`, 'asset')).equals(PDF)).toBe(true);
  });

  it('writes a root entry index.html that points at the mirrored seed', () => {
    const entry = join(outDir, 'index.html');
    expect(existsSync(entry)).toBe(true);
    const { local } = classifyHtml(outDir, 'index.html');
    // The entry page's link resolves to the mirrored seed page on disk.
    expect(local.length).toBeGreaterThan(0);
    for (const ref of local) expect(ref.exists).toBe(true);
  });

  it('every internal href/src in every saved HTML resolves to a local file', () => {
    const files = listHtmlFiles(outDir);
    expect(files.length).toBeGreaterThanOrEqual(6); // index, seed, about, post, search, app

    const broken: string[] = [];
    for (const file of files) {
      const { local } = classifyHtml(outDir, file);
      for (const ref of local) {
        if (!ref.exists) broken.push(`${file} → ${ref.ref} (resolved ${ref.resolvedRel})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('leaves no root-relative internal reference in any saved HTML', () => {
    // A `/path` reference is not offline-navigable: a browser opening the file
    // resolves it against the filesystem root, not the mirror. Every mirrored
    // internal reference must be document-relative.
    const rootRelative: string[] = [];
    for (const file of listHtmlFiles(outDir)) {
      const { local } = classifyHtml(outDir, file);
      for (const ref of local) {
        if (ref.ref.startsWith('/')) rootRelative.push(`${file} → ${ref.ref}`);
      }
    }
    expect(rootRelative).toEqual([]);
  });

  it('keeps the external site link absolute and localizes every other reference', () => {
    const files = listHtmlFiles(outDir);
    const external = new Set<string>();
    for (const file of files) {
      for (const ref of classifyHtml(outDir, file).external) external.add(ref);
    }
    // The only absolute web reference left anywhere is the external site link;
    // the cross-host asset must have been rewritten to a relative local path.
    expect([...external]).toEqual([EXTERNAL_SITE]);
  });

  it('localizes the cross-host asset under _assets/<external-host>/', () => {
    const abs = mappedAbs(`http://localhost:${serverB.port}/logo.png`, 'asset');
    expect(abs).toContain(join('_assets', `localhost_${serverB.port}`));
    expect(existsSync(abs)).toBe(true);
    // The seed page's <img> for it is now a relative reference, not an absolute URL.
    const seedRel = mapUrlToLocal(`${seedBase}/`, outDir, 'page').relPath;
    const $ = cheerio.load(readFileSync(join(outDir, seedRel), 'utf-8'));
    const srcs = $('img[src]').map((_, el) => $(el).attr('src') ?? '').get();
    const crossHost = srcs.find((s) => /logo\.png$/.test(s));
    expect(crossHost).toBeDefined();
    expect(isExternalRef(crossHost as string)).toBe(false);
  });

  it('maps the extensionless URL to .html and preserves the link fragment', () => {
    expect(existsSync(mappedAbs(`${seedBase}/about`, 'page'))).toBe(true);
    const seedRel = mapUrlToLocal(`${seedBase}/`, outDir, 'page').relPath;
    const $ = cheerio.load(readFileSync(join(outDir, seedRel), 'utf-8'));
    const aboutHref = $('a').map((_, el) => $(el).attr('href') ?? '').get().find((h) => /about\.html/.test(h));
    expect(aboutHref).toBeDefined();
    expect(aboutHref).toMatch(/#intro$/); // fragment preserved through rewrite
    expect(isExternalRef(aboutHref as string)).toBe(false);
  });

  it('maps the query-string URL with a _q<hash> suffix', () => {
    const abs = mappedAbs(`${seedBase}/search?q=cats`, 'page');
    expect(/search_q[0-9a-f]{8}\.html$/.test(abs)).toBe(true);
    expect(existsSync(abs)).toBe(true);
    // A different query yields a different mapped file.
    const other = mappedAbs(`${seedBase}/search?q=dogs`, 'page');
    expect(other).not.toBe(abs);
  });

  it('rewrites CSS url() and @import to references that resolve on disk', () => {
    const mainCssRel = mapUrlToLocal(`${seedBase}/styles/main.css`, outDir, 'asset').relPath;
    const baseCssRel = mapUrlToLocal(`${seedBase}/styles/base.css`, outDir, 'asset').relPath;

    for (const rel of [mainCssRel, baseCssRel]) {
      const css = readFileSync(join(outDir, rel), 'utf-8');
      const refs = cssRefs(css);
      expect(refs.length).toBeGreaterThan(0);
      const fromDir = posix.dirname(rel);
      for (const ref of refs) {
        expect(isExternalRef(ref), `CSS ref should be localized: ${ref}`).toBe(false);
        const bare = ref.split(/[?#]/)[0];
        const resolved = posix.normalize(posix.join(fromDir, bare));
        expect(existsSync(join(outDir, resolved)), `missing ${resolved} from ${rel}`).toBe(true);
      }
    }
    // main.css reaches base.css via @import; base.css exists.
    expect(existsSync(join(outDir, baseCssRel))).toBe(true);
  });

  it('rewrites srcset candidates to resolvable local files', () => {
    const seedRel = mapUrlToLocal(`${seedBase}/`, outDir, 'page').relPath;
    const $ = cheerio.load(readFileSync(join(outDir, seedRel), 'utf-8'));
    const srcset = $('img[srcset]').first().attr('srcset');
    expect(srcset).toBeDefined();
    const candidates = (srcset as string).split(',').map((c) => c.trim());
    expect(candidates.length).toBe(2);
    const fromDir = posix.dirname(seedRel);
    for (const cand of candidates) {
      const [url, descriptor] = cand.split(/\s+/);
      expect(descriptor).toMatch(/^[12]x$/); // descriptor preserved
      expect(isExternalRef(url)).toBe(false);
      const resolved = posix.normalize(posix.join(fromDir, url.split(/[?#]/)[0]));
      expect(existsSync(join(outDir, resolved))).toBe(true);
    }
  });

  it('saves the JS-shell page as its static shell under --browser never', () => {
    const appRel = mapUrlToLocal(`${seedBase}/app`, outDir, 'page').relPath;
    const html = readFileSync(join(outDir, appRel), 'utf-8');
    // Static shell: the SPA mount stays empty and no browser-injected marker appears.
    expect(html).not.toContain(APP_MARKER);
    const $ = cheerio.load(html);
    expect($('#root').text().trim()).toBe('');
    // Its script asset was still downloaded and localized, so the shell resolves offline.
    const { local } = classifyHtml(outDir, appRel);
    for (const ref of local) expect(ref.exists).toBe(true);
  });
});

describe('E2E: Playwright rendering (skips if unavailable)', () => {
  it('renders a JS-shell page under --browser always', async (ctx) => {
    if (!hasPlaywright) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-e2e-pw-'));
    try {
      const opts = { ...baseOptions(`${seedBase}/app`, dir), browser: 'always' as const, maxPages: 1 };
      await mirror(opts);
      const appRel = mapUrlToLocal(`${seedBase}/app`, dir, 'page').relPath;
      const html = readFileSync(join(dir, appRel), 'utf-8');
      expect(html).toContain(APP_MARKER); // browser executed app.js and filled #root
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('E2E: example.com network smoke (skips if offline)', () => {
  it('mirrors a single real page and writes index.html', async (ctx) => {
    if (!online) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-e2e-smoke-'));
    try {
      const result = await mirror({ ...baseOptions('https://example.com', dir), maxPages: 1 });
      expect(existsSync(join(dir, 'index.html'))).toBe(true);
      expect(result.pages).toBeGreaterThanOrEqual(1);
      // The seed itself was fetched successfully (not merely the entry redirect page).
      const seedAbs = mapUrlToLocal('https://example.com/', dir, 'page').absPath;
      expect(existsSync(seedAbs)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45000);
});
