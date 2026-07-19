/**
 * Fetching and rendering.
 *
 * Static-first: every URL is fetched with the ported redirect-following fetch.
 * HTML that looks like a JavaScript shell (or every page, in `--browser always`)
 * is re-rendered through Playwright. Challenge pages are detected via the ported
 * header/body markers so the engine can record them and, in browser modes, retry
 * them once through a real browser.
 */

import type { Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import { fetchWithRedirects, type FetchFailureKind } from './utils/url-helpers';
import { detectChallenge, detectChallengeHeaders, type ChallengeResult } from './provenance/detect-challenge';

export type Fetcher = 'static' | 'playwright' | 'none';

export interface StaticFetchResult {
  ok: boolean;
  finalUrl: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
  challenge: ChallengeResult;
  /** Present only when ok === false. */
  error?: { kind: FetchFailureKind; message: string };
}

/** True when the fetched content type is HTML/XHTML. */
export function isHtmlContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml');
}

/**
 * Fetch a URL statically. Network failures return `ok: false` with an error;
 * a completed response returns the body as a Buffer plus any detected challenge
 * (from headers first, then body markers for HTML).
 */
export async function fetchStatic(
  url: string,
  userAgent: string,
  timeout = 30000,
): Promise<StaticFetchResult> {
  const outcome = await fetchWithRedirects(url, userAgent, timeout);
  if (!outcome.ok) {
    return {
      ok: false,
      finalUrl: url,
      status: 0,
      contentType: '',
      headers: {},
      body: Buffer.alloc(0),
      challenge: null,
      error: { kind: outcome.kind, message: outcome.message },
    };
  }

  const arrayBuffer = await outcome.response.arrayBuffer();
  const body = Buffer.from(arrayBuffer);
  const contentType = outcome.headers['content-type'] ?? '';

  let challenge = detectChallengeHeaders(outcome.headers);
  if (!challenge && isHtmlContentType(contentType)) {
    challenge = detectChallenge(body);
  }

  return {
    ok: true,
    finalUrl: outcome.finalUrl,
    status: outcome.response.status,
    contentType,
    headers: outcome.headers,
    body,
    challenge,
  };
}

const SPA_MOUNT_SELECTOR = '#root, #app, #__next, #__nuxt, [data-reactroot]';

/**
 * JS-shell heuristic for `--browser auto`. A page needs rendering when, after
 * removing script/style/noscript/template, its visible text is under 150 chars
 * and it carries scripts, or when its body is a bare single-page-app mount
 * (an empty #root/#app/#__next style container).
 */
export function needsRendering(html: string): boolean {
  const $ = cheerio.load(html);

  const hasScripts = $('script').toArray().some((el) => {
    const node = $(el);
    return !!node.attr('src') || node.text().trim().length > 0;
  });

  const mount = $(SPA_MOUNT_SELECTOR).first();
  const bareMount =
    mount.length > 0 && mount.children().length === 0 && mount.text().trim() === '';

  $('script, style, noscript, template').remove();
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();

  if (visibleText.length < 150 && hasScripts) return true;
  return bareMount;
}

/**
 * Lazily-launched Playwright renderer. Playwright is a peer dependency; if it
 * is not installed the renderer degrades gracefully and every render reports
 * itself unavailable, so `--browser auto` falls back to the static HTML.
 */
export class Renderer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private available: boolean | null = null;

  constructor(private readonly userAgent: string) {}

  private async ensure(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({ userAgent: this.userAgent });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /**
   * Render a URL and return the settled HTML. Waits for network idle, capped at
   * 15s; on timeout the partially-loaded content is still returned.
   */
  async render(url: string): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
    if (!(await this.ensure()) || !this.context) {
      return { ok: false, reason: 'playwright-unavailable' };
    }

    const page = await this.context.newPage();
    try {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      } catch {
        // Timeout or navigation error — fall through and read whatever loaded.
      }
      const html = await page.content();
      return { ok: true, html };
    } catch (err: any) {
      return { ok: false, reason: String(err?.message ?? err) };
    } finally {
      await page.close().catch(() => { /* best effort */ });
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => { /* best effort */ });
    await this.browser?.close().catch(() => { /* best effort */ });
    this.context = null;
    this.browser = null;
  }
}
