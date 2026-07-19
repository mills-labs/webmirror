/**
 * Fetch + safe-filename helpers.
 *
 * Trimmed for webmirror: only the redirect-following fetch (fetchWithRedirects /
 * FetchOutcome) and the safe-filename helpers are kept. The scraper policy
 * filters (skip-path / non-English language filtering, same-domain / under-path
 * gates, PDF detection, URL normalization) were deliberately NOT ported — a
 * mirror downloads everything, and scope/normalization live in the mirror engine.
 */

/**
 * Generate a safe filename from a URL or title.
 */
export function safeFilename(name: string, ext: string, maxLength = 120): string {
  let safe = name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
  if (safe.length > maxLength) safe = safe.slice(0, maxLength).trim();
  return safe + ext;
}

/**
 * Generate a safe directory name.
 */
export function safeDirName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Generate a numbered filename from a URL for downloads.
 */
export function numberedFilename(url: string, index: number, suggestedName?: string): string {
  let name = suggestedName || '';
  if (!name) {
    try {
      const { pathname } = new URL(url);
      name = pathname.split('/').pop() || 'document';
      name = decodeURIComponent(name);
    } catch {
      name = 'document';
    }
  }
  name = name.replace(/[<>:"/\\|?*]/g, '_');
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  return `${String(index + 1).padStart(4, '0')}_${name}`;
}

/**
 * Max redirect following for fetch requests.
 */
export const MAX_REDIRECTS = 10;

export type FetchFailureKind = 'timeout' | 'dns' | 'tls' | 'connection' | 'redirect-limit' | 'bad-redirect' | 'network';

export type FetchOutcome =
  | { ok: true; response: Response; finalUrl: string; redirectChain: string[]; headers: Record<string, string> }
  | { ok: false; kind: FetchFailureKind; message: string };

/**
 * Classify a thrown fetch error into a FetchFailureKind.
 */
function classifyFetchError(err: any): { kind: FetchFailureKind; message: string } {
  const code: string = err?.cause?.code || err?.code || '';
  const name: string = err?.name || '';
  const message = code ? `${code}: ${err?.message ?? err}` : String(err?.message ?? err);

  if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'timeout', message };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', message };
  if (/CERT|TLS|SSL/i.test(code)) return { kind: 'tls', message };
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') return { kind: 'connection', message };
  return { kind: 'network', message };
}

export async function fetchWithRedirects(
  url: string,
  userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  timeout = 30000,
  extraHeaders: Record<string, string> = {},
): Promise<FetchOutcome> {
  let current = url;
  const redirectChain: string[] = [];
  const baseHeaders: Record<string, string> = {
    'User-Agent': userAgent,
    'Accept': 'application/pdf,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    ...extraHeaders,
  };
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    let res: Response;
    try {
      res = await fetch(current, {
        headers: baseHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err: any) {
      return { ok: false, ...classifyFetchError(err) };
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      redirectChain.push(`${res.status} ${current}`);
      // Cancel the hop body so keep-alive sockets are released.
      res.body?.cancel().catch(() => { /* best effort */ });
      const location = res.headers.get('location');
      if (!location) {
        return { ok: false, kind: 'bad-redirect', message: `${res.status} redirect without Location header at ${current}` };
      }
      try {
        current = new URL(location, current).href;
      } catch {
        return { ok: false, kind: 'bad-redirect', message: `invalid redirect target "${location}" at ${current}` };
      }
      continue;
    }

    redirectChain.push(`${res.status} ${current}`);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { ok: true, response: res, finalUrl: current, redirectChain, headers };
  }
  return { ok: false, kind: 'redirect-limit', message: `exceeded ${MAX_REDIRECTS} redirects starting from ${url}` };
}
