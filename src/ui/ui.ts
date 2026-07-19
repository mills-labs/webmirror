// The webmirror localhost control panel server. `runUi` binds an http server to
// 127.0.0.1 (a random free port by default), serves the self-contained panel,
// and drives a single EngineApi run at a time. Progress from the engine's
// onProgress callback feeds an in-memory state snapshot that is streamed to the
// browser via Server-Sent Events.

import * as http from 'http';
import { spawn } from 'child_process';
import { AddressInfo } from 'net';
import {
  EngineApi,
  MirrorFailure,
  MirrorHandle,
  MirrorOptions,
  MirrorReport,
} from './engine-api';
import { PANEL_HTML } from './panel';

export interface RunUiOptions {
  /** Port to bind. Default 0 (a random free port). */
  port?: number;
  /** Spawn the OS 'open' command on the panel URL once listening. Default false. */
  openBrowser?: boolean;
  /**
   * Opens a native folder-picker dialog and resolves the chosen absolute path,
   * or null if the user cancelled. Default: the macOS chooser via osascript.
   * Injectable so tests never open a real dialog.
   */
  chooseFolder?: () => Promise<string | null>;
}

/** Native macOS folder picker (AppleScript). Resolves null on user cancel. */
function osascriptChooseFolder(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const script =
      'tell application "System Events" to activate\n' +
      'POSIX path of (choose folder with prompt "Choose where to save the mirror")';
    const child = spawn('osascript', ['-e', script]);
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out.trim() || null);
      } else if (/cancel/i.test(err)) {
        resolve(null);
      } else {
        reject(new Error('Folder dialog failed: ' + (err.trim() || 'exit code ' + code)));
      }
    });
  });
}

type RunStatus = 'idle' | 'running' | 'stopping' | 'done' | 'error';

interface UiState {
  status: RunStatus;
  phase: 'crawl' | 'rewrite' | null;
  pagesDone: number;
  assetsDone: number;
  queueSize: number;
  bytes: number;
  currentUrl: string;
  failures: MirrorFailure[];
  outDir: string | null;
  report: MirrorReport | null;
  error: string | null;
}

function initialState(): UiState {
  return {
    status: 'idle',
    phase: null,
    pagesDone: 0,
    assetsDone: 0,
    queueSize: 0,
    bytes: 0,
    currentUrl: '',
    failures: [],
    outDir: null,
    report: null,
    error: null,
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  options?: MirrorOptions;
}

/**
 * Validate a raw config object from the panel into MirrorOptions. Number fields
 * arrive as strings (possibly blank); non-numeric values are rejected with a
 * clear message rather than silently defaulted.
 */
export function validateConfig(raw: any): ValidationResult {
  const errors: string[] = [];
  const c = raw && typeof raw === 'object' ? raw : {};

  // URL: required and parseable as http/https. Scheme-less addresses
  // ("www.example.com") are accepted and normalized to https://.
  let urlStr = typeof c.url === 'string' ? c.url.trim() : '';
  let parsedUrl: URL | null = null;
  if (!urlStr) {
    errors.push('Website address is required.');
  } else {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;
    try {
      parsedUrl = new URL(urlStr);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        errors.push('Website address must start with http:// or https://.');
        parsedUrl = null;
      }
    } catch {
      errors.push('Website address is not a valid URL.');
    }
  }

  // Number fields: blank -> undefined (engine default); non-numeric -> error.
  const num = (val: unknown, label: string): number | undefined => {
    if (val === undefined || val === null || val === '') return undefined;
    const s = String(val).trim();
    if (s === '') return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) {
      errors.push(label + ' must be a number.');
      return undefined;
    }
    if (n < 0) {
      errors.push(label + ' cannot be negative.');
      return undefined;
    }
    return n;
  };

  const maxDepth = num(c.maxDepth, 'Levels deep');
  const maxPages = num(c.maxPages, 'Page limit');
  const maxFileSizeMb = num(c.maxFileSizeMb, 'Max file size');
  const delayMsLegacy = num(c.delayMs, 'Politeness delay');

  // Randomized delay range in seconds ("from x to y", 0.1s steps at run time).
  const delayFromS = num(c.delayFromS, 'Politeness delay (from)');
  const delayToS = num(c.delayToS, 'Politeness delay (to)');
  if (delayFromS !== undefined && delayToS !== undefined && delayFromS > delayToS) {
    errors.push("Politeness delay: 'from' cannot be greater than 'to'.");
  }
  const delayMs =
    delayFromS !== undefined ? Math.round(delayFromS * 1000)
    : delayToS !== undefined ? 0
    : delayMsLegacy;
  const delayMaxMs = delayToS !== undefined ? Math.round(delayToS * 1000) : undefined;

  // Enum: browser mode.
  let browser: MirrorOptions['browser'] | undefined;
  if (c.browser !== undefined && c.browser !== null && c.browser !== '') {
    if (c.browser === 'auto' || c.browser === 'never' || c.browser === 'always') {
      browser = c.browser;
    } else {
      errors.push('JavaScript rendering must be auto, never, or always.');
    }
  }

  // Exclude patterns: array of non-empty strings.
  let exclude: string[] | undefined;
  let excludeList: string[] = [];
  if (Array.isArray(c.exclude)) {
    excludeList = c.exclude.map((x: unknown) => String(x).trim()).filter((x: string) => x.length > 0);
  } else if (typeof c.exclude === 'string' && c.exclude.trim()) {
    excludeList = c.exclude.split('\n').map((x: string) => x.trim()).filter((x: string) => x.length > 0);
  }
  if (excludeList.length > 0) exclude = excludeList;

  if (errors.length) return { ok: false, errors };

  const outDir =
    typeof c.outDir === 'string' && c.outDir.trim()
      ? c.outDir.trim()
      : `mirror-${parsedUrl!.hostname.replace(/^www\./, '')}`;

  const options: MirrorOptions = {
    url: urlStr,
    outDir,
    maxDepth,
    maxPages,
    delayMs,
    delayMaxMs,
    browser,
    subdomains: c.subdomains !== false,
    respectRobots: c.respectRobots !== false,
    maxFileSizeMb,
    exclude,
    fresh: c.mode === 'fresh' || c.fresh === true,
  };

  return { ok: true, errors: [], options };
}

export function runUi(engine: EngineApi, opts: RunUiOptions = {}): http.Server {
  const state: UiState = initialState();
  let handle: MirrorHandle | null = null;
  const sseClients = new Set<http.ServerResponse>();
  const chooseFolder = opts.chooseFolder ?? osascriptChooseFolder;
  let chooserOpen = false;

  const snapshot = (): UiState => state;

  const broadcast = () => {
    const data = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
    for (const res of sseClients) {
      res.write(data);
    }
  };

  const startRun = (options: MirrorOptions) => {
    // Reset run-scoped state but keep serving.
    Object.assign(state, initialState(), {
      status: 'running' as RunStatus,
      outDir: options.outDir ?? null,
    });

    const withProgress: MirrorOptions = {
      ...options,
      onProgress: (p) => {
        state.phase = p.phase;
        state.pagesDone = p.pagesDone;
        state.assetsDone = p.assetsDone;
        state.queueSize = p.queueSize;
        state.bytes = p.bytes;
        state.currentUrl = p.currentUrl;
        state.failures = p.failures;
        broadcast();
      },
    };

    handle = engine.mirror(withProgress);

    handle.done.then(
      (report) => {
        state.status = 'done';
        state.report = report;
        state.outDir = report.outDir;
        state.failures = report.failures;
        state.phase = null;
        handle = null;
        broadcast();
      },
      (err) => {
        state.status = 'error';
        state.error = err instanceof Error ? err.message : String(err);
        handle = null;
        broadcast();
      }
    );
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1_000_000) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  };

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PANEL_HTML);
      return;
    }

    if (method === 'GET' && url === '/api/state') {
      json(res, 200, snapshot());
      return;
    }

    if (method === 'GET' && url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
      sseClients.add(res);
      const drop = () => sseClients.delete(res);
      req.on('close', drop);
      // A client that disconnects mid-broadcast can make a pending write emit an
      // 'error' on the response; without a listener that would crash the server.
      res.on('error', drop);
      return;
    }

    if (method === 'POST' && url === '/api/start') {
      if (state.status === 'running' || state.status === 'stopping') {
        json(res, 409, { errors: ['A mirror is already running.'] });
        return;
      }
      readBody(req)
        .then((body) => {
          let raw: unknown;
          try {
            raw = body ? JSON.parse(body) : {};
          } catch {
            json(res, 400, { errors: ['Request body is not valid JSON.'] });
            return;
          }
          const result = validateConfig(raw);
          if (!result.ok) {
            json(res, 400, { errors: result.errors });
            return;
          }
          startRun(result.options!);
          json(res, 200, { ok: true, outDir: result.options!.outDir });
        })
        .catch(() => json(res, 400, { errors: ['Could not read request body.'] }));
      return;
    }

    if (method === 'POST' && url === '/api/stop') {
      if (state.status !== 'running' || !handle) {
        json(res, 409, { errors: ['No mirror is currently running.'] });
        return;
      }
      state.status = 'stopping';
      broadcast();
      handle.stop().catch(() => {});
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url === '/api/choose-folder') {
      if (chooserOpen) {
        json(res, 409, { errors: ['A folder dialog is already open.'] });
        return;
      }
      chooserOpen = true;
      chooseFolder()
        .then((path) => {
          if (path) json(res, 200, { path });
          else json(res, 200, { canceled: true });
        })
        .catch((err) => {
          json(res, 500, { errors: [err instanceof Error ? err.message : String(err)] });
        })
        .finally(() => { chooserOpen = false; });
      return;
    }

    if (method === 'POST' && url === '/api/open') {
      if (!state.outDir) {
        json(res, 409, { errors: ['No mirror directory is available yet.'] });
        return;
      }
      // macOS: reveal the mirror directory in Finder.
      spawn('open', [state.outDir], { stdio: 'ignore', detached: true }).unref();
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { errors: ['Not found.'] });
  });

  server.listen(opts.port ?? 0, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo;
    const uiUrl = `http://127.0.0.1:${addr.port}/`;
    // eslint-disable-next-line no-console
    console.log(`webmirror control panel: ${uiUrl}`);
    if (opts.openBrowser) {
      spawn('open', [uiUrl], { stdio: 'ignore', detached: true }).unref();
    }
  });

  return server;
}
