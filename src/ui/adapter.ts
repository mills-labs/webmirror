// The single translation point between the UI's `EngineApi` contract and the
// real mirror engine. `runUi` and the mock both speak the `EngineApi` shape in
// ./engine-api; the real engine's `mirror()` does not, so this adapter reconciles
// the differences and nothing else does:
//
//  - the real `mirror(options)` resolves a `MirrorResult` promise; the UI wants a
//    `MirrorHandle` with `done` + `stop()`. The adapter drives stop() through an
//    AbortSignal (the engine's own cooperative wind-down lever) and maps the
//    resolved `MirrorResult` into a `MirrorReport`.
//  - option field names/units differ: UI `url`→`seedUrl`, `maxFileSizeMb`→
//    `maxFileSizeBytes`, and the engine requires a `userAgent` the panel never
//    supplies. The adapter renames, converts units, and fills engine defaults for
//    any UI field left undefined.
//  - failure shapes differ: the engine uses `{ url, status, error }`; the UI uses
//    `{ url, category, reason }`.
//  - progress failures differ: the engine's `MirrorProgress.failures` is a COUNT,
//    while the UI's is a LIST. The engine surfaces per-failure detail only in the
//    final `MirrorResult`, so live progress carries an empty list and the completed
//    report carries the full, detailed list — every failure shown, none hidden.

import { mirror, type MirrorOptions as EngineOptions, type MirrorFailure as EngineFailure } from '../mirror';
import { DEFAULT_USER_AGENT } from '../cli';
import type {
  EngineApi,
  MirrorFailure,
  MirrorHandle,
  MirrorOptions,
  MirrorReport,
} from './engine-api';

const MB = 1024 * 1024;

/** Human-readable fallback when the engine records a failure without an error string. */
const STATUS_TEXT: Record<string, string> = {
  failed: 'Fetch failed',
  'too-large': 'Exceeded the maximum file size',
  challenge: 'Blocked by an anti-bot challenge',
  robots: 'Disallowed by robots.txt',
  excluded: 'Matched an exclude pattern',
};

function toUiFailure(f: EngineFailure): MirrorFailure {
  return {
    url: f.url,
    category: f.status,
    reason: f.error && f.error.length ? f.error : (STATUS_TEXT[f.status] ?? f.status),
  };
}

/** Map the UI's option shape onto the engine's, filling engine defaults. */
function toEngineOptions(ui: MirrorOptions, signal: AbortSignal): EngineOptions {
  const outDir =
    ui.outDir && ui.outDir.trim()
      ? ui.outDir
      : `mirror-${safeHost(ui.url)}`;
  return {
    seedUrl: ui.url,
    outDir,
    maxPages: ui.maxPages ?? 0,
    delayMs: ui.delayMs ?? 500,
    delayMaxMs: ui.delayMaxMs,
    browser: ui.browser ?? 'auto',
    subdomains: ui.subdomains ?? true,
    respectRobots: ui.respectRobots ?? true,
    maxFileSizeBytes: (ui.maxFileSizeMb ?? 200) * MB,
    userAgent: ui.userAgent ?? DEFAULT_USER_AGENT,
    fresh: ui.fresh ?? false,
    maxDepth: ui.maxDepth,
    exclude: ui.exclude,
    signal,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'site';
  } catch {
    return 'site';
  }
}

/**
 * Build an `EngineApi` bound to the real mirror engine. `runUi` treats this and
 * the mock interchangeably.
 */
export function createRealEngine(): EngineApi {
  return {
    mirror(uiOptions: MirrorOptions): MirrorHandle {
      const controller = new AbortController();
      let aborted = false;
      const startedAt = Date.now();

      const engineOptions = toEngineOptions(uiOptions, controller.signal);

      // The engine's progress carries a failure count, not a list; per-failure
      // detail is only available in the final result. Live progress therefore
      // reports an empty failure list, and the completed report carries the full
      // detailed list (see the mapping in `done` below).
      engineOptions.onProgress = (p) => {
        uiOptions.onProgress?.({
          phase: p.phase,
          pagesDone: p.pagesDone,
          assetsDone: p.assetsDone,
          queueSize: p.queueSize,
          bytes: p.bytes,
          failures: [],
          currentUrl: p.currentUrl,
        });
      };

      const done: Promise<MirrorReport> = mirror(engineOptions).then((result) => ({
        outDir: engineOptions.outDir,
        pages: result.pages,
        assets: result.assets,
        bytes: result.bytes,
        failures: result.failures.map(toUiFailure),
        robotsSkipped: result.robotsSkipped,
        excluded: result.excluded,
        durationMs: Date.now() - startedAt,
        stopped: aborted,
      }));

      return {
        done,
        async stop(): Promise<void> {
          aborted = true;
          controller.abort();
        },
      };
    },
  };
}
