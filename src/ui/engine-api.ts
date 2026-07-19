// Engine contract for the webmirror UI (spec ADDENDUM A3).
//
// This file is the STABLE CONTRACT the UI codes against. `runUi` accepts any
// object satisfying `EngineApi`: the mock (`createMockEngine`) implements it
// directly for tests and demos, and `createRealEngine` in ./adapter binds it to
// the real engine's `mirror()` export. The real engine does not match this
// shape exactly — its `mirror()` resolves a `MirrorResult` promise rather than
// returning a `MirrorHandle`, its progress carries a failure count rather than a
// list, and it uses `seedUrl`/`maxFileSizeBytes` — so ./adapter is the single
// translation point that reconciles those differences (see its header).

/** Browser-rendering mode for JS-shell pages (owner decision: default 'auto'). */
export type BrowserMode = 'auto' | 'never' | 'always';

/** Crawl phase reported by progress callbacks. */
export type MirrorPhase = 'crawl' | 'rewrite';

/**
 * A single failed URL, surfaced so the UI can list failures with reasons.
 * (A3 lists `failures` in MirrorProgress without a shape; the UI requires the
 * reason per URL and must never hide failures, so it is modelled as a list.)
 */
export interface MirrorFailure {
  url: string;
  /** Failure category, mirroring the manifest statuses, e.g. 'failed' | 'too-large' | 'robots' | 'challenge' | 'excluded'. */
  category: string;
  /** Human-readable reason (HTTP status text, error message, etc.). */
  reason: string;
}

/**
 * Progress snapshot delivered to `onProgress` at least once per fetched URL
 * (spec A3). Counts are cumulative; `failures` is the full list so far.
 */
export interface MirrorProgress {
  phase: MirrorPhase;
  pagesDone: number;
  assetsDone: number;
  queueSize: number;
  bytes: number;
  failures: MirrorFailure[];
  currentUrl: string;
}

/**
 * Options accepted by `mirror()`. Fields mirror the CLI flags plus the A1/A2/A3
 * additions (maxDepth, exclude, onProgress, signal).
 */
export interface MirrorOptions {
  /** Seed URL to mirror. Required. */
  url: string;
  /** Output directory. Default: ./mirror-<hostname>. */
  outDir?: string;
  /** Link-levels to follow from the seed. 0 or omitted = unlimited (A1). */
  maxDepth?: number;
  /** Page limit. 0 or omitted = unlimited. */
  maxPages?: number;
  /** Base politeness delay between page fetches, milliseconds (jittered). Default 500. */
  delayMs?: number;
  /** Upper bound of a randomized delay range [delayMs, delayMaxMs], 0.1s steps. */
  delayMaxMs?: number;
  /** JS rendering mode. Default 'auto'. */
  browser?: BrowserMode;
  /** Include subdomains of the start host in page scope. Default true. */
  subdomains?: boolean;
  /** Respect robots.txt for all fetches. Default true. */
  respectRobots?: boolean;
  /** Per-file cap in megabytes. 0 or omitted = unlimited. Default 200. */
  maxFileSizeMb?: number;
  /** Override the User-Agent header. */
  userAgent?: string;
  /** Ignore the previous manifest and redownload everything. Default false (resume). */
  fresh?: boolean;
  /** Substring patterns (case-insensitive); matching URLs are excluded (A2). */
  exclude?: string[];
  /** Progress callback, invoked at least once per fetched URL (A3). */
  onProgress?: (p: MirrorProgress) => void;
  /**
   * Optional abort signal. Aborting triggers the same graceful wind-down as
   * SIGINT: manifest saved, partial mirror resumable (A3). Equivalent to
   * calling `handle.stop()`.
   */
  signal?: AbortSignal;
}

/** Final report resolved when a run completes or winds down. */
export interface MirrorReport {
  outDir: string;
  pages: number;
  assets: number;
  bytes: number;
  failures: MirrorFailure[];
  robotsSkipped: number;
  excluded: number;
  durationMs: number;
  /** True when the run ended via stop()/abort rather than natural completion. */
  stopped: boolean;
}

/**
 * Handle returned by `mirror()`. `done` resolves with the report when the run
 * finishes (naturally or via wind-down); `stop()` requests a graceful
 * wind-down and resolves once the wind-down has been acknowledged (A3).
 */
export interface MirrorHandle {
  /** Resolves with the final report; rejects only on unexpected engine error. */
  done: Promise<MirrorReport>;
  /** Request a graceful stop (manifest saved, partial mirror resumable). */
  stop(): Promise<void>;
}

/**
 * The engine surface the UI depends on. The real engine module exposes a
 * `mirror` function with this signature; the mock engine implements the same
 * interface for tests and demos.
 */
export interface EngineApi {
  mirror(options: MirrorOptions): MirrorHandle;
}
