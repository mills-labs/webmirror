/**
 * Two-pass mirror engine.
 *
 * Pass 1 crawls the seed site breadth-first, downloading pages (static-first,
 * with a Playwright fallback for JavaScript shells) and their assets from any
 * host. Pass 2 rewrites every saved HTML and CSS file so the mirror navigates
 * entirely offline. A manifest records every URL's outcome and drives resume;
 * cooperative shutdown lets an interrupted run wind down and resume cleanly.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, posix } from 'path';

import { writeJsonAtomic, writeFileAtomic, readJsonOrRecover } from './utils/fs-atomic';
import { initShutdown, isShuttingDown, onShutdown } from './utils/shutdown';
import { jitteredDelay, rangeDelay } from './utils/delay';
import {
  fetchRobotsTxt,
  isDisallowed,
  effectiveDelay,
  type RobotsRules,
} from './utils/robots';
import {
  computeScopeRoot,
  isInPageScope,
  normalizeUrl,
  mapUrlToLocal,
  relativeRef,
  type ResourceKind,
} from './url-map';
import { extractLinks, extractCssRefs, effectiveBaseUrl } from './extract';
import {
  fetchStatic,
  needsRendering,
  isHtmlContentType,
  Renderer,
  type Fetcher,
} from './fetch-render';
import { rewriteHtml, rewriteCss, type RefResolution, type RefResolver } from './rewrite';

export type MirrorStatus = 'ok' | 'failed' | 'too-large' | 'robots' | 'challenge' | 'excluded';

export interface ManifestEntry {
  url: string;
  path: string; // POSIX path relative to the output directory
  status: MirrorStatus;
  kind: ResourceKind;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  fetcher: Fetcher;
  error?: string;
}

export interface MirrorManifest {
  seed: string;
  scopeRoot: string;
  startedAt: string;
  updatedAt: string;
  entries: Record<string, ManifestEntry>;
}

export interface MirrorOptions {
  seedUrl: string;
  outDir: string;
  /** 0 = unlimited. */
  maxPages: number;
  /** Base politeness delay between page fetches, in ms (jittered). */
  delayMs: number;
  /**
   * Optional upper bound for a randomized delay range: each page fetch waits a
   * uniformly random duration in [delayMs, delayMaxMs], quantized to 0.1s steps.
   * Omitted = legacy jitter (100-175% of delayMs). robots.txt Crawl-delay still
   * raises the lower bound.
   */
  delayMaxMs?: number;
  browser: 'auto' | 'never' | 'always';
  /** false = restrict to the exact start host. */
  subdomains: boolean;
  /** false = ignore robots.txt. */
  respectRobots: boolean;
  /** Per-file cap in bytes; 0 = unlimited. */
  maxFileSizeBytes: number;
  userAgent: string;
  /** Ignore any previous manifest and redownload everything. */
  fresh: boolean;
  /**
   * Max link-depth from the seed to follow. Depth 1 = the seed page (and all its
   * assets) only; depth 2 = seed + pages it links to; and so on. 0 or omitted =
   * unlimited (the whole site within scope). Assets are always downloaded for any
   * fetched page regardless of depth.
   */
  maxDepth?: number;
  /**
   * Plain substring patterns (case-insensitive) matched against the full URL.
   * Matching pages and assets are never fetched; they are recorded with status
   * 'excluded' rather than silently dropped.
   */
  exclude?: string[];
  /** Progress callback, invoked at least once per fetched URL. */
  onProgress?: (p: MirrorProgress) => void;
  /**
   * Optional abort signal. Aborting triggers the same cooperative wind-down as
   * SIGINT: the manifest is saved and the partial mirror is resumable.
   */
  signal?: AbortSignal;
}

export interface MirrorProgress {
  phase: 'crawl' | 'rewrite';
  pagesDone: number;
  assetsDone: number;
  queueSize: number;
  bytes: number;
  failures: number;
  currentUrl: string;
}

export interface MirrorFailure {
  url: string;
  status: MirrorStatus;
  error?: string;
}

export interface MirrorResult {
  pages: number;
  assets: number;
  bytes: number;
  failures: MirrorFailure[];
  robotsSkipped: number;
  excluded: number;
  manifestPath: string;
  reportPath: string;
}

const MANIFEST_FILE = 'mirror-manifest.json';
const REPORT_FILE = 'mirror-report.json';
const ASSET_CONCURRENCY = 4;
const ASSET_SPACING_MS = 100;
const CSS_MAX_DEPTH = 5;

interface AssetJob {
  url: string;
  depth: number;
}

interface PageJob {
  url: string;
  /** Link-level from the seed; the seed itself is depth 1. */
  depth: number;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** True when the path exists and is a regular file (not a directory). */
function isLocalFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Enqueue gate for crawl depth (spec A1). True when a link discovered at
 * `childDepth` may be followed. Depth 1 is the seed; a `maxDepth` of 0 (or
 * undefined) means unlimited.
 */
export function withinDepth(childDepth: number, maxDepth: number | undefined): boolean {
  const max = maxDepth ?? 0;
  return max === 0 || childDepth <= max;
}

/**
 * Exclude matcher (spec A2). Case-insensitive substring match of a URL against
 * any non-empty exclude pattern.
 */
export function matchesExclude(url: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const lower = url.toLowerCase();
  return patterns.some((p) => p.length > 0 && lower.includes(p.toLowerCase()));
}

class MirrorEngine {
  private readonly opts: MirrorOptions;
  private readonly scopeRoot: string;
  private readonly seed: string;
  private readonly renderer: Renderer;

  private manifest: MirrorManifest;
  private readonly manifestPath: string;
  private writesSinceSave = 0;

  private readonly pageQueue: PageJob[] = [];
  private readonly pageSeen = new Set<string>();
  private readonly assetQueue: AssetJob[] = [];
  private readonly assetSeen = new Set<string>();
  private pagesDownloaded = 0;
  private stopped = false;

  private readonly robotsCache = new Map<string, RobotsRules>();

  constructor(opts: MirrorOptions) {
    this.opts = opts;
    const seed = normalizeUrl(opts.seedUrl);
    if (!seed) throw new Error(`Invalid seed URL: ${opts.seedUrl}`);
    this.seed = seed;
    this.scopeRoot = computeScopeRoot(seed);
    this.renderer = new Renderer(opts.userAgent);
    this.manifestPath = join(opts.outDir, MANIFEST_FILE);
    this.manifest = this.loadManifest();
  }

  private loadManifest(): MirrorManifest {
    if (!this.opts.fresh) {
      const existing = readJsonOrRecover<MirrorManifest>(this.manifestPath, 'mirror-manifest');
      if (existing && existing.entries) {
        existing.seed = this.seed;
        existing.scopeRoot = this.scopeRoot;
        return existing;
      }
    }
    return {
      seed: this.seed,
      scopeRoot: this.scopeRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: {},
    };
  }

  private saveManifest(force = false): void {
    if (!force && this.writesSinceSave < 10) return;
    this.manifest.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.manifestPath, this.manifest);
    this.writesSinceSave = 0;
  }

  private record(entry: ManifestEntry): void {
    this.manifest.entries[entry.url] = entry;
    this.writesSinceSave++;
    this.saveManifest();
  }

  private isDone(url: string): boolean {
    return !this.opts.fresh && this.manifest.entries[url]?.status === 'ok';
  }

  private async getRobots(url: string): Promise<RobotsRules> {
    const host = new URL(url).host;
    let rules = this.robotsCache.get(host);
    if (!rules) {
      rules = await fetchRobotsTxt(url, this.opts.userAgent);
      this.robotsCache.set(host, rules);
    }
    return rules;
  }

  /** True when robots permits fetching this URL (always true if robots off). */
  private async allowed(url: string, rules: RobotsRules): Promise<boolean> {
    if (!this.opts.respectRobots) return true;
    return !isDisallowed(new URL(url).pathname, rules);
  }

  // ---- Pass 1 -----------------------------------------------------------

  /** True when either a signal or an abort has begun a cooperative wind-down. */
  private windingDown(): boolean {
    return isShuttingDown() || this.stopped;
  }

  async run(): Promise<MirrorResult> {
    initShutdown();
    const unregister = onShutdown(() => {
      try {
        writeJsonAtomic(this.manifestPath, this.manifest);
      } catch {
        /* best effort */
      }
    });

    // The API stop mechanism: aborting the signal winds the run down like SIGINT.
    const signal = this.opts.signal;
    const onAbort = () => {
      this.stopped = true;
      try {
        writeJsonAtomic(this.manifestPath, this.manifest);
      } catch {
        /* best effort */
      }
    };
    if (signal) {
      if (signal.aborted) this.stopped = true;
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      this.enqueuePage(this.seed, 1);
      await this.crawlPages();
      await this.drainAssets();
      this.saveManifest(true);

      if (!this.windingDown()) {
        this.rewriteAll();
        this.writeEntryIndex();
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      await this.renderer.close();
      this.saveManifest(true);
      unregister();
    }

    return this.buildResult();
  }

  private enqueuePage(url: string, depth: number): void {
    if (this.pageSeen.has(url)) return;
    this.pageSeen.add(url);
    if (this.isExcluded(url)) {
      this.record(this.stub(url, 'page', 'excluded'));
      return;
    }
    this.pageQueue.push({ url, depth });
  }

  private enqueueAsset(url: string, depth = 0): void {
    if (this.assetSeen.has(url)) return;
    this.assetSeen.add(url);
    if (this.isExcluded(url)) {
      this.record(this.stub(url, 'asset', 'excluded'));
      return;
    }
    this.assetQueue.push({ url, depth });
  }

  /** Case-insensitive substring match of the URL against any exclude pattern. */
  private isExcluded(url: string): boolean {
    return matchesExclude(url, this.opts.exclude);
  }

  /**
   * True when a link discovered at childDepth may be followed. Depth 1 is the
   * seed; a maxDepth of 0 (or omitted) means unlimited.
   */
  private withinDepth(childDepth: number): boolean {
    return withinDepth(childDepth, this.opts.maxDepth);
  }

  private async crawlPages(): Promise<void> {
    while (this.pageQueue.length > 0 && !this.windingDown()) {
      if (this.opts.maxPages > 0 && this.pagesDownloaded >= this.opts.maxPages) break;
      const { url, depth } = this.pageQueue.shift()!;

      // Resume: an already-mirrored page is not refetched, but its saved HTML is
      // re-parsed so the crawl frontier and asset set are rebuilt.
      if (this.isDone(url)) {
        const entry = this.manifest.entries[url];
        if (entry && entry.kind === 'page') {
          const abs = join(this.opts.outDir, entry.path);
          if (existsSync(abs)) this.harvest(readFileSync(abs, 'utf-8'), url, depth);
        }
        continue;
      }

      const rules = await this.getRobots(url);
      if (!(await this.allowed(url, rules))) {
        this.record(this.stub(url, 'page', 'robots'));
        continue;
      }

      await this.fetchPage(url, depth);
      this.pagesDownloaded++;
      this.emitProgress('crawl', url);

      const delay = effectiveDelay(this.opts.delayMs, rules.crawlDelay);
      if (this.opts.delayMaxMs !== undefined) {
        await rangeDelay(delay, Math.max(delay, this.opts.delayMaxMs));
      } else {
        await jitteredDelay(delay);
      }
    }
  }

  private async fetchPage(url: string, depth: number): Promise<void> {
    const result = await fetchStatic(url, this.opts.userAgent);
    if (!result.ok) {
      this.record(this.stub(url, 'page', 'failed', result.error?.message));
      return;
    }

    if (this.tooLarge(result.body)) {
      this.record(this.stub(url, 'page', 'too-large', undefined, result.contentType));
      return;
    }

    // Challenge page: record as a failure; retry once via Playwright in browser
    // modes. Checked before the status guard because challenges commonly arrive
    // with an error status (e.g. 403/503).
    if (result.challenge && result.challenge.kind === 'challenge') {
      if (this.opts.browser === 'auto' || this.opts.browser === 'always') {
        const rendered = await this.renderer.render(url);
        if (rendered.ok) {
          this.savePage(url, rendered.html, result.contentType, 'playwright', depth);
          return;
        }
      }
      this.record(this.stub(url, 'page', 'challenge', result.challenge.source, result.contentType));
      return;
    }

    // HTTP error status → a failure, never valid content. Persisting a 404/500
    // body would masquerade as a real page and hide the broken link.
    if (result.status >= 400) {
      this.record(this.stub(url, 'page', 'failed', `HTTP ${result.status}`, result.contentType));
      return;
    }

    // Non-HTML response → store as a file asset and stop.
    if (!isHtmlContentType(result.contentType)) {
      this.storeAsset(url, result.body, result.contentType, 'static');
      return;
    }

    let html = result.body.toString('utf-8');
    let fetcher: Fetcher = 'static';

    if (this.opts.browser === 'always') {
      const rendered = await this.renderer.render(url);
      if (rendered.ok) {
        html = rendered.html;
        fetcher = 'playwright';
      }
    } else if (this.opts.browser === 'auto' && needsRendering(html)) {
      const rendered = await this.renderer.render(url);
      if (rendered.ok) {
        html = rendered.html;
        fetcher = 'playwright';
      }
    }

    this.savePage(url, html, result.contentType, fetcher, depth);
  }

  private savePage(url: string, html: string, contentType: string, fetcher: Fetcher, depth: number): void {
    const mapped = mapUrlToLocal(url, this.opts.outDir, 'page');
    writeFileAtomic(mapped.absPath, html);
    const buf = Buffer.from(html, 'utf-8');
    this.record({
      url,
      path: mapped.relPath,
      status: 'ok',
      kind: 'page',
      contentType,
      sha256: sha256Hex(buf),
      sizeBytes: buf.length,
      fetcher,
    });
    this.harvest(html, url, depth);
  }

  private harvest(html: string, pageUrl: string, depth: number): void {
    const { pageLinks, assetLinks } = extractLinks(
      html,
      pageUrl,
      this.scopeRoot,
      this.opts.subdomains,
    );
    // Assets are always downloaded for a fetched page, regardless of depth.
    for (const asset of assetLinks) this.enqueueAsset(asset);
    // Links enqueue one level deeper, gated by --max-depth.
    const childDepth = depth + 1;
    if (this.withinDepth(childDepth)) {
      for (const link of pageLinks) this.enqueuePage(link, childDepth);
    }
  }

  // ---- Pass 1: assets ---------------------------------------------------

  private async drainAssets(): Promise<void> {
    const worker = async () => {
      while (this.assetQueue.length > 0 && !this.windingDown()) {
        const job = this.assetQueue.shift()!;
        await this.fetchAsset(job);
        this.emitProgress('crawl', job.url);
        await jitteredDelay(ASSET_SPACING_MS);
      }
    };
    const workers = Array.from({ length: ASSET_CONCURRENCY }, () => worker());
    await Promise.all(workers);
  }

  private async fetchAsset(job: AssetJob): Promise<void> {
    const { url, depth } = job;
    if (this.isDone(url)) {
      this.followCss(url, depth);
      return;
    }

    const rules = await this.getRobots(url);
    if (!(await this.allowed(url, rules))) {
      this.record(this.stub(url, 'asset', 'robots'));
      return;
    }

    const result = await fetchStatic(url, this.opts.userAgent);
    if (!result.ok) {
      this.record(this.stub(url, 'asset', 'failed', result.error?.message));
      return;
    }
    if (this.tooLarge(result.body)) {
      this.record(this.stub(url, 'asset', 'too-large', undefined, result.contentType));
      return;
    }
    // HTTP error status → a failure, not content; never persist the error body.
    if (result.status >= 400) {
      this.record(this.stub(url, 'asset', 'failed', `HTTP ${result.status}`, result.contentType));
      return;
    }

    this.storeAsset(url, result.body, result.contentType, 'static');

    // Nested references inside downloaded CSS join the queue (bounded depth).
    if (this.isCss(url, result.contentType) && depth < CSS_MAX_DEPTH) {
      const refs = extractCssRefs(result.body.toString('utf-8'), url);
      for (const ref of refs) this.enqueueAsset(ref, depth + 1);
    }
  }

  private followCss(url: string, depth: number): void {
    const entry = this.manifest.entries[url];
    if (!entry || !this.isCss(url, entry.contentType) || depth >= CSS_MAX_DEPTH) return;
    const abs = join(this.opts.outDir, entry.path);
    if (!existsSync(abs)) return;
    const refs = extractCssRefs(readFileSync(abs, 'utf-8'), url);
    for (const ref of refs) this.enqueueAsset(ref, depth + 1);
  }

  private storeAsset(url: string, body: Buffer, contentType: string, fetcher: Fetcher): void {
    const mapped = mapUrlToLocal(url, this.opts.outDir, 'asset');
    writeFileAtomic(mapped.absPath, body);
    this.record({
      url,
      path: mapped.relPath,
      status: 'ok',
      kind: 'asset',
      contentType,
      sha256: sha256Hex(body),
      sizeBytes: body.length,
      fetcher,
    });
  }

  private isCss(url: string, contentType: string): boolean {
    if (contentType.toLowerCase().includes('text/css')) return true;
    return new URL(url).pathname.toLowerCase().endsWith('.css');
  }

  private tooLarge(body: Buffer): boolean {
    return this.opts.maxFileSizeBytes > 0 && body.length > this.opts.maxFileSizeBytes;
  }

  private stub(
    url: string,
    kind: ResourceKind,
    status: MirrorStatus,
    error?: string,
    contentType = '',
  ): ManifestEntry {
    return {
      url,
      path: '',
      status,
      kind,
      contentType,
      sha256: '',
      sizeBytes: 0,
      fetcher: 'none',
      error,
    };
  }

  // ---- Pass 2 -----------------------------------------------------------

  /** Emit a progress snapshot when a caller has supplied a callback. */
  private emitProgress(phase: MirrorProgress['phase'], currentUrl: string): void {
    const cb = this.opts.onProgress;
    if (!cb) return;
    let pagesDone = 0;
    let assetsDone = 0;
    let bytes = 0;
    let failures = 0;
    for (const e of Object.values(this.manifest.entries)) {
      if (e.status === 'ok') {
        bytes += e.sizeBytes;
        if (e.kind === 'page') pagesDone++;
        else assetsDone++;
      } else if (e.status === 'failed' || e.status === 'too-large' || e.status === 'challenge') {
        failures++;
      }
    }
    cb({
      phase,
      pagesDone,
      assetsDone,
      queueSize: this.pageQueue.length + this.assetQueue.length,
      bytes,
      failures,
      currentUrl,
    });
  }

  private rewriteAll(): void {
    this.emitProgress('rewrite', this.seed);
    for (const entry of Object.values(this.manifest.entries)) {
      if (entry.status !== 'ok' || !entry.path) continue;
      const lower = entry.path.toLowerCase();
      const isHtml = lower.endsWith('.html') || lower.endsWith('.htm');
      const isCss = lower.endsWith('.css') || entry.contentType.toLowerCase().includes('text/css');
      if (!isHtml && !isCss) continue;

      const abs = join(this.opts.outDir, entry.path);
      if (!existsSync(abs)) continue;

      const original = readFileSync(abs, 'utf-8');
      // Resolve relative references against the same effective base pass 1 used:
      // a page's own URL, overridden by its <base href>. CSS has no <base>, so
      // its base is the stylesheet URL. Using the page URL alone would mis-resolve
      // every relative reference on a page that carries a <base> tag.
      const base = isHtml ? effectiveBaseUrl(original, entry.url) : entry.url;
      const resolver = this.makeResolver(base, entry.path);
      const rewritten = isHtml ? rewriteHtml(original, resolver) : rewriteCss(original, resolver);
      if (rewritten !== original) writeFileAtomic(abs, rewritten);
    }
  }

  /**
   * Build a resolver for one file: rewrite references to mirrored resources to a
   * relative local path; make in-scope-but-unmirrored (and out-of-scope relative)
   * references absolute so no link is left broken; leave everything else alone.
   */
  private makeResolver(baseUrl: string, fileRelPath: string): RefResolver {
    return (rawRef: string): RefResolution => {
      const ref = rawRef.trim();
      if (!ref || ref.startsWith('#')) return null;
      const lower = ref.toLowerCase();
      if (/^(data|mailto|tel|javascript|blob|about):/.test(lower)) return null;

      const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//');

      let u: URL;
      try {
        u = new URL(ref, baseUrl);
      } catch {
        return null;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

      const fragment = u.hash;
      u.hash = '';

      // A mirrored target always wins: rewrite it to the relative local path.
      // Checked before the idempotency guard so a directory-style link (`../`,
      // `.`) whose resolved URL IS mirrored points at the concrete index.html
      // rather than at a bare directory, and so a <base href>-relative link
      // resolves to the file that was actually downloaded.
      const entry = this.manifest.entries[u.href];
      if (entry && entry.status === 'ok' && entry.path) {
        return { value: relativeRef(fileRelPath, entry.path) + fragment, localized: true };
      }

      // Idempotency: a document-relative ref already pointing at an existing
      // local FILE (a previously-rewritten link) is left untouched. It must
      // require a regular file, not merely an existing path — an existing
      // directory (e.g. a `../` link whose target dir exists) would otherwise be
      // treated as already-localized and left pointing at a directory, which does
      // not open a page offline. Root-relative refs (`/about.html`) are excluded:
      // posix.join would collapse the leading slash onto this file's directory
      // and mask a link a browser resolves to the filesystem root.
      if (!isAbsolute && !ref.startsWith('/')) {
        const bare = ref.split(/[?#]/)[0];
        const localTarget = posix.normalize(posix.join(posix.dirname(fileRelPath), bare));
        if (!localTarget.startsWith('..') && isLocalFile(join(this.opts.outDir, localTarget))) {
          return null;
        }
      }

      // Not mirrored: keep already-absolute refs as they are; absolutize what was
      // relative so it stays a working (online) link rather than a broken one.
      if (isAbsolute) return null;
      return { value: u.href + fragment, localized: false };
    };
  }

  private writeEntryIndex(): void {
    const seedEntry = this.manifest.entries[this.seed];
    const target = seedEntry && seedEntry.status === 'ok' ? seedEntry.path : null;
    const href = target ? relativeRef('index.html', target) : this.seed;
    const escaped = href.replace(/"/g, '%22');
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${escaped}">
<title>Offline mirror of ${this.seed}</title>
</head>
<body>
<p>Redirecting to the mirrored start page. If nothing happens, open
<a href="${escaped}">${href}</a>.</p>
</body>
</html>
`;
    writeFileAtomic(join(this.opts.outDir, 'index.html'), html);
  }

  // ---- Result -----------------------------------------------------------

  private buildResult(): MirrorResult {
    let pages = 0;
    let assets = 0;
    let bytes = 0;
    let robotsSkipped = 0;
    let excluded = 0;
    const failures: MirrorFailure[] = [];

    for (const entry of Object.values(this.manifest.entries)) {
      if (entry.status === 'ok') {
        bytes += entry.sizeBytes;
        if (entry.kind === 'page') pages++;
        else assets++;
      } else if (entry.status === 'robots') {
        robotsSkipped++;
      } else if (entry.status === 'excluded') {
        excluded++;
      } else {
        failures.push({ url: entry.url, status: entry.status, error: entry.error });
      }
    }

    const reportPath = join(this.opts.outDir, REPORT_FILE);
    const report = {
      seed: this.seed,
      scopeRoot: this.scopeRoot,
      finishedAt: new Date().toISOString(),
      interrupted: this.windingDown(),
      pages,
      assets,
      bytes,
      robotsSkipped,
      excluded,
      failures,
    };
    writeJsonAtomic(reportPath, report);

    return { pages, assets, bytes, failures, robotsSkipped, excluded, manifestPath: this.manifestPath, reportPath };
  }
}

/**
 * Mirror a website for offline navigation. Resolves with a summary of pages,
 * assets, bytes, failures, and robots-skipped counts once both passes complete
 * (or the run winds down cooperatively).
 */
export async function mirror(options: MirrorOptions): Promise<MirrorResult> {
  const engine = new MirrorEngine(options);
  return engine.run();
}
