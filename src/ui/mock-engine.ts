// A fake EngineApi for tests and local UI demos. It does not touch the network
// or filesystem: it emits a scripted sequence of MirrorProgress events on a
// timer, honours stop()/abort by winding down early, and resolves with a
// plausible MirrorReport. The event shapes are identical to the real engine's,
// so the UI cannot tell the difference.

import {
  EngineApi,
  MirrorFailure,
  MirrorHandle,
  MirrorOptions,
  MirrorProgress,
} from './engine-api';

export interface MockEngineConfig {
  /** Delay between scripted events, milliseconds. Default 40. */
  intervalMs?: number;
  /** Number of crawl steps before the rewrite phase. Default 6. */
  crawlSteps?: number;
  /** Number of rewrite steps. Default 2. */
  rewriteSteps?: number;
  /** Inject a sample failure partway through the crawl. Default true. */
  injectFailure?: boolean;
}

export function createMockEngine(config: MockEngineConfig = {}): EngineApi {
  const intervalMs = config.intervalMs ?? 40;
  const crawlSteps = config.crawlSteps ?? 6;
  const rewriteSteps = config.rewriteSteps ?? 2;
  const injectFailure = config.injectFailure ?? true;

  return {
    mirror(options: MirrorOptions): MirrorHandle {
      const startedAt = Date.now();
      const host = safeHost(options.url);
      const outDir = options.outDir || `./mirror-${host}`;

      let pagesDone = 0;
      let assetsDone = 0;
      let queueSize = crawlSteps; // pages still to visit
      let bytes = 0;
      const failures: MirrorFailure[] = [];

      let stopping = false;
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      let resolveDone!: (r: import('./engine-api').MirrorReport) => void;
      const done = new Promise<import('./engine-api').MirrorReport>((res) => {
        resolveDone = res;
      });

      const emit = (phase: MirrorProgress['phase'], currentUrl: string) => {
        options.onProgress?.({
          phase,
          pagesDone,
          assetsDone,
          queueSize,
          bytes,
          failures: failures.slice(),
          currentUrl,
        });
      };

      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        resolveDone({
          outDir,
          pages: pagesDone,
          assets: assetsDone,
          bytes,
          failures: failures.slice(),
          robotsSkipped: 0,
          excluded: options.exclude?.length ? 1 : 0,
          durationMs: Date.now() - startedAt,
          stopped: stopping,
        });
      };

      // Phase state machine driven by a single interval.
      let phase: MirrorProgress['phase'] = 'crawl';
      let step = 0;

      const tick = () => {
        if (finished) return;

        // A stop request winds the run down: finish after the current tick.
        if (stopping) {
          emit(phase, '(winding down)');
          finish();
          return;
        }

        if (phase === 'crawl') {
          step += 1;
          pagesDone += 1;
          assetsDone += 2;
          bytes += 40_000 + step * 1500;
          queueSize = Math.max(0, crawlSteps - step);
          if (injectFailure && step === Math.ceil(crawlSteps / 2)) {
            failures.push({
              url: `https://${host}/broken-link`,
              category: 'failed',
              reason: 'HTTP 404 Not Found',
            });
          }
          emit('crawl', `https://${host}/page-${step}`);
          if (step >= crawlSteps) {
            phase = 'rewrite';
            step = 0;
            queueSize = rewriteSteps;
          }
          return;
        }

        // rewrite phase
        step += 1;
        queueSize = Math.max(0, rewriteSteps - step);
        emit('rewrite', `rewriting file ${step}/${rewriteSteps}`);
        if (step >= rewriteSteps) {
          finish();
        }
      };

      // Abort signal maps to stop().
      if (options.signal) {
        if (options.signal.aborted) stopping = true;
        else options.signal.addEventListener('abort', () => (stopping = true), { once: true });
      }

      timer = setInterval(tick, intervalMs);
      // Emit an immediate first event so subscribers see activity at once.
      queueMicrotask(() => emit('crawl', `https://${host}/`));

      return {
        done,
        async stop(): Promise<void> {
          stopping = true;
        },
      };
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'site';
  } catch {
    return 'site';
  }
}
