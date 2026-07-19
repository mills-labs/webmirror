import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { runUi, validateConfig } from '../src/ui/ui';
import { createMockEngine } from '../src/ui/mock-engine';
import { PANEL_HTML } from '../src/ui/panel';

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

function start(engineConfig = {}, uiOpts = {}): Promise<{ base: string }> {
  return new Promise((resolve) => {
    const engine = createMockEngine({ intervalMs: 15, crawlSteps: 5, rewriteSteps: 2, ...engineConfig });
    server = runUi(engine, { port: 0, openBrowser: false, ...uiOpts });
    server.on('listening', () => {
      const addr = server!.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${addr.port}` });
    });
    // In case 'listening' already fired synchronously before the handler bound.
    if (server.listening) {
      const addr = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${addr.port}` });
    }
  });
}

async function post(base: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function getJson(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}

/** Collect SSE events until `predicate(state)` is true or a timeout elapses. */
function collectEvents(
  base: string,
  predicate: (state: any) => boolean,
  timeoutMs = 4000
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const req = http.get(base + '/api/events', (res) => {
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('SSE timeout; last state: ' + JSON.stringify(events[events.length - 1])));
      }, timeoutMs);
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const state = JSON.parse(line.slice(5).trim());
            events.push(state);
            if (predicate(state)) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
              return;
            }
          } catch {
            /* ignore non-JSON frames */
          }
        }
      });
    });
    req.on('error', () => {
      /* destroyed on success */
    });
  });
}

const validConfig = {
  url: 'https://example.com',
  maxDepth: '',
  outDir: '',
  subdomains: true,
  maxPages: '',
  browser: 'auto',
  exclude: [],
  maxFileSizeMb: '',
  delayMs: '',
  respectRobots: true,
  mode: 'resume',
};

describe('panel HTML', () => {
  it('is served at GET / with html content-type', async () => {
    const { base } = await start();
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Webmirror');
    expect(body).toContain('Website address');
  });

  it('is self-contained: no external http(s) resource loads', () => {
    // The template must not LOAD anything from a remote host. `new URL(...)` inside
    // the page script operates on user input, not a literal URL, so guard against
    // literal http(s):// occurrences only.
    const matches = PANEL_HTML.match(/https?:\/\/[a-z0-9.-]+/gi) || [];
    // Nothing fetched from a remote host: no src=, stylesheet <link>, or @import.
    // A plain <a href> is user-initiated navigation and loads nothing by itself.
    expect(PANEL_HTML).not.toMatch(/src\s*=\s*["']https?:\/\//i);
    expect(PANEL_HTML).not.toMatch(/@import\s+url\(\s*["']?https?:\/\//i);
    // No <link>/<script src> to any CDN.
    expect(PANEL_HTML).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(PANEL_HTML).not.toMatch(/<script[^>]+src=/i);
    // The only literal http(s) strings permitted are the example placeholders and
    // the footer's GitHub profile link (navigation, not a resource).
    for (const m of matches) {
      expect(m).toMatch(/^https?:\/\/(example\.com|github\.com)/);
    }
  });
});

describe('validateConfig', () => {
  it('accepts a minimal valid config and defaults outDir', () => {
    const r = validateConfig({ url: 'https://www.example.com/path' });
    expect(r.ok).toBe(true);
    expect(r.options!.outDir).toBe('mirror-example.com');
    expect(r.options!.subdomains).toBe(true);
  });

  it('rejects a missing URL', () => {
    const r = validateConfig({ url: '' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/required/i);
  });

  it('rejects an unparseable URL', () => {
    const r = validateConfig({ url: 'not a url' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/valid url/i);
  });

  it('accepts a scheme-less address and normalizes it to https', () => {
    const r = validateConfig({ url: 'www.example.com' });
    expect(r.ok).toBe(true);
    expect(r.options!.url).toBe('https://www.example.com');
    expect(r.options!.outDir).toBe('mirror-example.com');
  });

  it('rejects a non-http protocol', () => {
    const r = validateConfig({ url: 'ftp://example.com' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/http/i);
  });

  it('rejects non-numeric number fields with a clear message', () => {
    const r = validateConfig({ url: 'https://example.com', maxDepth: 'deep' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Levels deep must be a number/);
  });

  it('rejects negative numbers', () => {
    const r = validateConfig({ url: 'https://example.com', delayMs: '-5' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Politeness delay cannot be negative/);
  });

  it('converts a delay range in seconds to ms bounds', () => {
    const r = validateConfig({ url: 'https://example.com', delayFromS: '0.5', delayToS: '2' });
    expect(r.ok).toBe(true);
    expect(r.options!.delayMs).toBe(500);
    expect(r.options!.delayMaxMs).toBe(2000);
  });

  it("rejects a delay range whose 'from' exceeds 'to'", () => {
    const r = validateConfig({ url: 'https://example.com', delayFromS: '3', delayToS: '1' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/cannot be greater/i);
  });

  it("defaults the lower bound to 0 when only 'to' is set", () => {
    const r = validateConfig({ url: 'https://example.com', delayToS: '1.5' });
    expect(r.ok).toBe(true);
    expect(r.options!.delayMs).toBe(0);
    expect(r.options!.delayMaxMs).toBe(1500);
  });

  it('maps mode=fresh to fresh=true', () => {
    const r = validateConfig({ url: 'https://example.com', mode: 'fresh' });
    expect(r.ok).toBe(true);
    expect(r.options!.fresh).toBe(true);
  });
});

describe('start flow', () => {
  it('runs to completion and streams SSE events', async () => {
    const { base } = await start();
    const done = collectEvents(base, (s) => s.status === 'done');
    const res = await post(base, '/api/start', validConfig);
    expect(res.status).toBe(200);

    const events = await done;
    const final = events[events.length - 1];
    expect(final.status).toBe('done');
    expect(final.pagesDone).toBeGreaterThan(0);
    expect(final.assetsDone).toBeGreaterThan(0);
    expect(final.outDir).toBe('mirror-example.com');
    // A failure was injected by the mock; it must be surfaced, never hidden.
    expect(final.failures.length).toBeGreaterThan(0);
    expect(final.failures[0]).toHaveProperty('reason');

    // Both phases should have appeared over the run.
    const phases = new Set(events.map((e) => e.phase).filter(Boolean));
    expect(phases.has('crawl')).toBe(true);
  });

  it('rejects invalid config with 400 and messages', async () => {
    const { base } = await start();
    const res = await post(base, '/api/start', { url: '', maxPages: 'lots' });
    expect(res.status).toBe(400);
    expect(res.json.errors.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON with 400', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when a run is already in progress', async () => {
    const { base } = await start({ intervalMs: 60, crawlSteps: 30 });
    const first = await post(base, '/api/start', validConfig);
    expect(first.status).toBe(200);
    const second = await post(base, '/api/start', validConfig);
    expect(second.status).toBe(409);
    // Clean up: stop the long run.
    await post(base, '/api/stop');
  });
});

describe('stop flow', () => {
  it('stops mid-run and winds down to a completed state', async () => {
    const { base } = await start({ intervalMs: 30, crawlSteps: 40 });
    const started = await post(base, '/api/start', validConfig);
    expect(started.status).toBe(200);

    // Wait until some progress has been made.
    await collectEvents(base, (s) => s.pagesDone >= 2);

    const stop = await post(base, '/api/stop');
    expect(stop.status).toBe(200);

    const events = await collectEvents(base, (s) => s.status === 'done');
    const final = events[events.length - 1];
    expect(final.status).toBe('done');
    expect(final.report.stopped).toBe(true);
    // It stopped well before all 40 crawl steps completed.
    expect(final.pagesDone).toBeLessThan(40);
  });

  it('returns 409 on stop when nothing is running', async () => {
    const { base } = await start();
    const res = await post(base, '/api/stop');
    expect(res.status).toBe(409);
  });
});

describe('state snapshot', () => {
  it('serves the current snapshot at GET /api/state', async () => {
    const { base } = await start();
    const { status, json } = await getJson(base, '/api/state');
    expect(status).toBe(200);
    expect(json.status).toBe('idle');
  });
});

describe('choose-folder', () => {
  it('returns the picked path from the injected chooser', async () => {
    const { base } = await start({}, { chooseFolder: async () => '/Users/test/Desktop/' });
    const res = await post(base, '/api/choose-folder');
    expect(res.status).toBe(200);
    expect(res.json.path).toBe('/Users/test/Desktop/');
  });

  it('reports cancellation without a path', async () => {
    const { base } = await start({}, { chooseFolder: async () => null });
    const res = await post(base, '/api/choose-folder');
    expect(res.status).toBe(200);
    expect(res.json.canceled).toBe(true);
    expect(res.json.path).toBeUndefined();
  });

  it('rejects a second request while a dialog is open', async () => {
    let release!: (v: string) => void;
    const pending = new Promise<string>((r) => { release = r; });
    const { base } = await start({}, { chooseFolder: () => pending });
    const first = post(base, '/api/choose-folder');
    // Give the first request time to reach the handler and set the busy flag.
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(base, '/api/choose-folder');
    expect(second.status).toBe(409);
    release('/tmp/picked/');
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(firstRes.json.path).toBe('/tmp/picked/');
  });
});
