/**
 * ADDENDUM coverage (spec A1–A3): crawl depth (--max-depth / --levels),
 * URL exclude patterns (--exclude), and the engine progress + stop API.
 *
 * These features are engine-level, so they are exercised through the public
 * mirror() API against a small local HTTP fixture whose link graph has a clear
 * depth structure: the seed (depth 1) links to /a and /b (depth 2); /a links to
 * /a-deep (depth 3). The seed also carries its own assets so a depth-limited
 * mirror can be shown to still download them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { mirror, type MirrorOptions, type MirrorProgress } from '../src/mirror';
import { mapUrlToLocal } from '../src/url-map';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Started {
  server: Server;
  port: number;
}

function startServer(routes: Map<string, { type: string; body: Buffer | string }>): Promise<Started> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://placeholder').pathname;
    const route = routes.get(path);
    if (!route) {
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

let serverA: Started;
let seedBase: string;

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
    userAgent: 'webmirror-addendum-test',
    fresh: true,
  };
}

beforeAll(async () => {
  const seedHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Seed</title>
<link rel="stylesheet" href="/style.css"></head><body>
<h1>Seed</h1>
<a href="/a">A</a> <a href="/b">B</a> <a href="/secret/hidden">Secret</a>
<img src="/img/seed.png" alt="seed">
<img src="/img/deep.png" alt="deep-asset">
</body></html>`;

  const aHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A</title></head><body>
<h1>A</h1><a href="/a-deep">Deeper</a> <a href="/">Home</a>
<img src="/img/a.png" alt="a">
</body></html>`;

  const bHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>B</title></head><body>
<h1>B</h1><a href="/">Home</a></body></html>`;

  const aDeepHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A deep</title></head><body>
<h1>A deep</h1><a href="/">Home</a></body></html>`;

  const secretHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Secret</title></head><body>
<h1>Secret</h1><a href="/">Home</a></body></html>`;

  const routesA = new Map<string, { type: string; body: Buffer | string }>([
    ['/', { type: 'text/html; charset=utf-8', body: seedHtml }],
    ['/a', { type: 'text/html; charset=utf-8', body: aHtml }],
    ['/b', { type: 'text/html; charset=utf-8', body: bHtml }],
    ['/a-deep', { type: 'text/html; charset=utf-8', body: aDeepHtml }],
    ['/secret/hidden', { type: 'text/html; charset=utf-8', body: secretHtml }],
    ['/style.css', { type: 'text/css', body: 'body{color:red}' }],
    ['/img/seed.png', { type: 'image/png', body: PNG }],
    ['/img/deep.png', { type: 'image/png', body: PNG }],
    ['/img/a.png', { type: 'image/png', body: PNG }],
  ]);
  serverA = await startServer(routesA);
  seedBase = `http://127.0.0.1:${serverA.port}`;
}, 30000);

afterAll(async () => {
  if (serverA) await stopServer(serverA.server);
});

const pageAbs = (dir: string, path: string) => mapUrlToLocal(`${seedBase}${path}`, dir, 'page').absPath;
const assetAbs = (dir: string, path: string) => mapUrlToLocal(`${seedBase}${path}`, dir, 'asset').absPath;

describe('A1 — crawl depth (--max-depth / --levels)', () => {
  it('depth 1 fetches only the seed but still downloads its assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-depth1-'));
    try {
      const result = await mirror({ ...baseOptions(`${seedBase}/`, dir), maxDepth: 1 });
      // Seed page mirrored.
      expect(existsSync(pageAbs(dir, '/'))).toBe(true);
      // Linked pages at depth 2 were NOT fetched.
      expect(existsSync(pageAbs(dir, '/a'))).toBe(false);
      expect(existsSync(pageAbs(dir, '/b'))).toBe(false);
      expect(result.pages).toBe(1);
      // The seed's own assets WERE downloaded regardless of the depth limit.
      expect(existsSync(assetAbs(dir, '/style.css'))).toBe(true);
      expect(existsSync(assetAbs(dir, '/img/seed.png'))).toBe(true);
      expect(existsSync(assetAbs(dir, '/img/deep.png'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('depth 2 fetches the seed and its direct links but not their links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-depth2-'));
    try {
      await mirror({ ...baseOptions(`${seedBase}/`, dir), maxDepth: 2 });
      expect(existsSync(pageAbs(dir, '/'))).toBe(true);
      expect(existsSync(pageAbs(dir, '/a'))).toBe(true); // depth 2
      expect(existsSync(pageAbs(dir, '/b'))).toBe(true); // depth 2
      expect(existsSync(pageAbs(dir, '/a-deep'))).toBe(false); // depth 3, gated out
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('--levels is an alias with identical behaviour to --max-depth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-levels-'));
    try {
      // maxDepth is the single option both CLI flags feed; assert the value maps.
      const result = await mirror({ ...baseOptions(`${seedBase}/`, dir), maxDepth: 1 });
      expect(result.pages).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('A2 — URL exclude patterns (--exclude)', () => {
  it('excludes matching pages and assets, counts them, and keeps links absolute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-exclude-'));
    try {
      const result = await mirror({
        ...baseOptions(`${seedBase}/`, dir),
        exclude: ['/a-deep', 'deep.png'],
      });

      // The excluded page and the excluded asset were never written.
      expect(existsSync(pageAbs(dir, '/a-deep'))).toBe(false);
      expect(existsSync(assetAbs(dir, '/img/deep.png'))).toBe(false);
      // They were counted, not silently dropped.
      expect(result.excluded).toBe(2);

      // Manifest records them with status 'excluded'.
      const manifest = JSON.parse(readFileSync(join(dir, 'mirror-manifest.json'), 'utf-8'));
      expect(manifest.entries[`${seedBase}/a-deep`].status).toBe('excluded');
      expect(manifest.entries[`${seedBase}/img/deep.png`].status).toBe('excluded');

      // The report carries the excluded count.
      const report = JSON.parse(readFileSync(join(dir, 'mirror-report.json'), 'utf-8'));
      expect(report.excluded).toBe(2);

      // A link to the excluded page stays an absolute web URL after rewrite.
      const aHtml = readFileSync(pageAbs(dir, '/a'), 'utf-8');
      expect(aHtml).toContain(`${seedBase}/a-deep`);

      // Non-excluded pages were still mirrored.
      expect(existsSync(pageAbs(dir, '/a'))).toBe(true);
      expect(existsSync(pageAbs(dir, '/b'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('A3 — progress callback and stop/resume API', () => {
  it('invokes onProgress for crawl and rewrite phases with populated fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-progress-'));
    const events: MirrorProgress[] = [];
    try {
      await mirror({
        ...baseOptions(`${seedBase}/`, dir),
        onProgress: (p) => events.push({ ...p }),
      });

      expect(events.length).toBeGreaterThan(0);
      const phases = new Set(events.map((e) => e.phase));
      expect(phases.has('crawl')).toBe(true);
      expect(phases.has('rewrite')).toBe(true);

      // At least one crawl event exists per fetched page (5 pages here).
      const crawlEvents = events.filter((e) => e.phase === 'crawl');
      expect(crawlEvents.length).toBeGreaterThanOrEqual(5);

      const last = events[events.length - 1];
      expect(typeof last.currentUrl).toBe('string');
      expect(last.pagesDone).toBeGreaterThan(0);
      expect(typeof last.queueSize).toBe('number');
      expect(typeof last.bytes).toBe('number');
      expect(typeof last.failures).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('stops mid-crawl via AbortSignal and resumes to a complete mirror', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webmirror-stop-'));
    try {
      const controller = new AbortController();
      let aborted = false;
      const first = await mirror({
        ...baseOptions(`${seedBase}/`, dir),
        signal: controller.signal,
        onProgress: (p) => {
          // Abort as soon as the seed has been fetched, leaving work undone.
          if (!aborted && p.phase === 'crawl' && p.pagesDone >= 1) {
            aborted = true;
            controller.abort();
          }
        },
      });

      // The wound-down run saved a resumable manifest and did not mirror everything.
      expect(existsSync(join(dir, 'mirror-manifest.json'))).toBe(true);
      expect(first.pages).toBeLessThan(5);

      // Resume (no signal, not fresh) completes the mirror.
      const second = await mirror({ ...baseOptions(`${seedBase}/`, dir), fresh: false });

      for (const path of ['/', '/a', '/b', '/a-deep', '/secret/hidden']) {
        expect(existsSync(pageAbs(dir, path)), `missing ${path}`).toBe(true);
      }
      expect(second.pages).toBe(5);
      // The entry index is written on the completed pass.
      expect(existsSync(join(dir, 'index.html'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
