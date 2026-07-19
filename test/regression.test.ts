/**
 * Regression coverage for three pass-2 / fetch defects:
 *  - a page's <base href> is honoured when rewriting (relative links/assets map
 *    to the files that were actually downloaded), not ignored;
 *  - directory-style links (`../`, `.`) whose target is mirrored are rewritten
 *    to the concrete index.html, not left pointing at a bare directory;
 *  - an in-scope HTTP error (404/500) is recorded as a failure, its body is not
 *    persisted as valid content, and the link to it stays an absolute web URL.
 *
 * Exercised through the public mirror() API against a small local HTTP fixture.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, posix } from 'path';
import * as cheerio from 'cheerio';

import { mirror, type MirrorOptions } from '../src/mirror';
import { mapUrlToLocal } from '../src/url-map';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Route {
  type: string;
  body: Buffer | string;
  status?: number;
}

function startServer(routes: Map<string, Route>): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://placeholder').pathname;
    const route = routes.get(path);
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': route.type });
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

let server: Server;
let seedBase: string;
let outDir: string;

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
    userAgent: 'webmirror-regression-test',
    fresh: true,
  };
}

beforeAll(async () => {
  const home = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title></head><body>
<h1>Home</h1>
<a href="/based/">Based</a>
<a href="/missing">Missing</a>
</body></html>`;

  // A page whose <base href> redirects relative resolution to a deeper path.
  const based = `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="/based/deep/"><title>Based</title></head><body>
<h1>Based</h1>
<a href="child.html">Child</a>
<img src="pic.png" alt="pic">
</body></html>`;

  // A nested page linking to the site root via a directory-style link.
  const child = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Child</title></head><body>
<h1>Child</h1>
<a href="../../">Home</a>
</body></html>`;

  const routes = new Map<string, Route>([
    ['/', { type: 'text/html; charset=utf-8', body: home }],
    ['/based/', { type: 'text/html; charset=utf-8', body: based }],
    ['/based/deep/child.html', { type: 'text/html; charset=utf-8', body: child }],
    ['/based/deep/pic.png', { type: 'image/png', body: PNG }],
    ['/missing', { status: 404, type: 'text/plain', body: 'nf' }],
  ]);

  const started = await startServer(routes);
  server = started.server;
  seedBase = `http://127.0.0.1:${started.port}`;
  outDir = mkdtempSync(join(tmpdir(), 'webmirror-regression-'));
  await mirror(baseOptions(`${seedBase}/`, outDir));
}, 30000);

afterAll(async () => {
  if (server) await stopServer(server);
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const pageRel = (path: string) => mapUrlToLocal(`${seedBase}${path}`, outDir, 'page').relPath;
const assetRel = (path: string) => mapUrlToLocal(`${seedBase}${path}`, outDir, 'asset').relPath;

const isAbsoluteRef = (ref: string) => /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//');

/** Resolve a document-relative ref from a file and report on-disk status. */
function resolveLocal(fileRel: string, ref: string): { rel: string; exists: boolean; isFile: boolean } {
  const bare = ref.split(/[?#]/)[0];
  const rel = posix.normalize(posix.join(posix.dirname(fileRel), bare));
  const abs = join(outDir, rel);
  const exists = existsSync(abs);
  return { rel, exists, isFile: exists && statSync(abs).isFile() };
}

describe('regression: <base href> honoured in pass-2 rewriting', () => {
  it('rewrites relative link and asset on a <base>-carrying page to the downloaded files', () => {
    // The downloaded files live under /based/deep/ (per <base href>).
    expect(existsSync(join(outDir, pageRel('/based/deep/child.html')))).toBe(true);
    expect(existsSync(join(outDir, assetRel('/based/deep/pic.png')))).toBe(true);

    const fileRel = pageRel('/based/');
    const $ = cheerio.load(readFileSync(join(outDir, fileRel), 'utf-8'));

    const childHref = $('a').filter((_, el) => ($(el).text().trim() === 'Child')).attr('href') ?? '';
    expect(childHref).not.toBe('');
    expect(isAbsoluteRef(childHref)).toBe(false); // not left as a wrong absolute URL
    const childTarget = resolveLocal(fileRel, childHref);
    expect(childTarget.isFile).toBe(true);
    expect(childTarget.rel).toBe(pageRel('/based/deep/child.html'));

    const imgSrc = $('img').attr('src') ?? '';
    expect(isAbsoluteRef(imgSrc)).toBe(false);
    const imgTarget = resolveLocal(fileRel, imgSrc);
    expect(imgTarget.isFile).toBe(true);
    expect(imgTarget.rel).toBe(assetRel('/based/deep/pic.png'));
  });
});

describe('regression: directory-style links resolve to index.html', () => {
  it('rewrites a `../../` link whose target is mirrored to the concrete index file', () => {
    const fileRel = pageRel('/based/deep/child.html');
    const $ = cheerio.load(readFileSync(join(outDir, fileRel), 'utf-8'));
    const href = $('a').first().attr('href') ?? '';

    // It must not be left as a bare directory reference (which opens a listing,
    // not the page) — it must resolve to an existing regular file.
    expect(href.endsWith('/')).toBe(false);
    const target = resolveLocal(fileRel, href);
    expect(target.isFile).toBe(true);
    expect(target.rel).toBe(pageRel('/')); // the mirrored site root index.html
  });
});

describe('regression: in-scope HTTP error is a failure, not content', () => {
  it('records the 404 as failed, does not persist its body, and keeps the link absolute', () => {
    const manifest = JSON.parse(readFileSync(join(outDir, 'mirror-manifest.json'), 'utf-8'));
    const missing = manifest.entries[`${seedBase}/missing`];
    expect(missing).toBeDefined();
    expect(missing.status).toBe('failed');
    expect(missing.path).toBe(''); // nothing written to disk

    // The error body was never saved as an asset.
    expect(existsSync(join(outDir, assetRel('/missing')))).toBe(false);

    // The report surfaces it as a failure.
    const report = JSON.parse(readFileSync(join(outDir, 'mirror-report.json'), 'utf-8'));
    const reported = report.failures.find((f: { url: string }) => f.url === `${seedBase}/missing`);
    expect(reported).toBeDefined();
    expect(reported.status).toBe('failed');

    // The home link to the unmirrored 404 stays an absolute web URL.
    const $ = cheerio.load(readFileSync(join(outDir, pageRel('/')), 'utf-8'));
    const href = $('a').filter((_, el) => $(el).text().trim() === 'Missing').attr('href') ?? '';
    expect(href).toBe(`${seedBase}/missing`);
  });
});
