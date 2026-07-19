/**
 * URL → local path mapping and scope rules.
 *
 * Pure functions only: given the same URL and output directory they always
 * produce the same mapped location, in both crawl (pass 1) and rewrite
 * (pass 2). Nothing here depends on fetch results — the mapping is decided
 * from the URL and a page/asset classification alone.
 */

import { createHash } from 'crypto';
import { posix, join } from 'path';

export type ResourceKind = 'page' | 'asset';

export interface MappedTarget {
  /** Absolute filesystem path of the mapped file. */
  absPath: string;
  /** POSIX path of the mapped file relative to the output directory. */
  relPath: string;
}

/** HTML-ish extensions: a link with one of these (or none) is treated as a page. */
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'php', 'asp', 'aspx', 'jsp', 'cfm', 'shtml']);

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stripWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

/**
 * Percent-decode a single path/host segment, tolerating malformed escapes.
 */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * Sanitize a single path or host segment: percent-decode, replace every
 * character outside [A-Za-z0-9._-] with '_', and cap the length at 100 chars
 * (overflow is truncated and given an 8-hex hash suffix so it stays unique).
 */
export function sanitizeSegment(seg: string): string {
  const decoded = decodeSegment(seg);
  let safe = decoded.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe.length > 100) {
    safe = safe.slice(0, 91) + '_' + sha256Hex(seg).slice(0, 8);
  }
  return safe;
}

/**
 * Sanitize a path segment with a collision guard. Plain '_' substitution is
 * lossy: distinct originals whose only differences are disallowed characters
 * (e.g. `café` and `cafè`, both → `caf_`) would otherwise map to the same file,
 * silently overwriting one another. When substitution actually altered the
 * segment (and no length-overflow hash already made it unique) a short hash of
 * the decoded original is inserted before the extension so distinct segments map
 * to distinct files. Applied to path segments only; hosts do not collide in
 * practice (ports are numeric) and stay readable.
 */
export function sanitizePathSegment(seg: string): string {
  const decoded = decodeSegment(seg);
  const safe = decoded.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe.length > 100) {
    // Overflow already receives a unique hash suffix, which also disambiguates.
    return safe.slice(0, 91) + '_' + sha256Hex(seg).slice(0, 8);
  }
  if (safe === decoded) return safe;
  const hash = sha256Hex(decoded).slice(0, 8);
  const ext = posix.extname(safe);
  const base = ext ? safe.slice(0, safe.length - ext.length) : safe;
  return `${base}_h${hash}${ext}`;
}

/** POSIX extension (without the dot, lowercased) of a filename, or '' if none. */
function extensionOf(name: string): string {
  const ext = posix.extname(name);
  return ext ? ext.slice(1).toLowerCase() : '';
}

/**
 * True when a link's last-segment extension marks it as a navigable page
 * (HTML-ish or extensionless) rather than a downloadable file asset.
 */
export function isPageExtension(ext: string): boolean {
  return ext === '' || PAGE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * The scope root for a seed URL: its hostname with a leading `www.` removed.
 */
export function computeScopeRoot(seedUrl: string): string {
  return stripWww(new URL(seedUrl).hostname.toLowerCase());
}

/**
 * Page-scope test. A URL is in scope iff its www-stripped hostname equals the
 * scope root, or (when subdomains are allowed) ends with `.` + scope root.
 * Deliberately not registrable-domain logic: seeding docs.example.com must not
 * pull in example.com, and seeding a *.gov.uk site must not pull in gov.uk.
 */
export function isInPageScope(url: string, scopeRoot: string, allowSubdomains: boolean): boolean {
  let host: string;
  try {
    host = stripWww(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
  if (host === scopeRoot) return true;
  if (allowSubdomains && host.endsWith('.' + scopeRoot)) return true;
  return false;
}

/**
 * Normalize a reference to an absolute http(s) URL with the fragment removed.
 * Returns null for non-navigable schemes (data:, mailto:, javascript:, …) and
 * for anything that fails to parse.
 */
export function normalizeUrl(ref: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(ref, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  return u.href;
}

/**
 * Map a URL to its local file location. The result depends only on the URL,
 * the output directory, and whether the URL is a page or an asset.
 *
 * Layout:
 *  - pages:  <out>/<host>/<path>
 *  - assets: <out>/_assets/<host>/<path>
 * Rules: trailing-slash / empty path → index.html; an extensionless last
 * segment becomes `<segment>.html` for pages but keeps its name for assets;
 * existing .html/.htm is kept; a page with a non-HTML extension gains a
 * trailing `.html` so it opens offline; a query string contributes
 * `_q<8 hex of sha256(query)>` inserted before the extension.
 */
export function mapUrlToLocal(url: string, outDir: string, kind: ResourceKind): MappedTarget {
  const u = new URL(url);
  const host = sanitizeSegment(u.host);

  const rawSegments = u.pathname.split('/').filter((s) => s.length > 0);
  const sanitizedSegments = rawSegments.map(sanitizePathSegment);

  let dirSegments: string[];
  let fileName: string;

  if (u.pathname === '' || u.pathname.endsWith('/')) {
    // Directory-style URL → index document.
    dirSegments = sanitizedSegments;
    fileName = 'index.html';
  } else {
    fileName = sanitizedSegments.pop() ?? 'index.html';
    dirSegments = sanitizedSegments;
    fileName = applyExtensionRule(fileName, kind);
  }

  if (u.search) {
    fileName = insertQueryHash(fileName, u.search.slice(1));
  }

  const relPath = posix.join(prefixFor(kind), host, ...dirSegments, fileName);
  const absPath = join(outDir, relPath);
  return { absPath, relPath };
}

function prefixFor(kind: ResourceKind): string {
  return kind === 'asset' ? '_assets' : '';
}

/**
 * Ensure a page filename ends in a browser-openable HTML extension; leave
 * asset filenames (including extensionless ones) untouched.
 */
function applyExtensionRule(fileName: string, kind: ResourceKind): string {
  if (kind === 'asset') return fileName;
  const ext = extensionOf(fileName);
  if (ext === 'html' || ext === 'htm') return fileName;
  return fileName + '.html';
}

/** Insert `_q<hash>` before the filename's extension. */
function insertQueryHash(fileName: string, query: string): string {
  const hash = sha256Hex(query).slice(0, 8);
  const ext = posix.extname(fileName);
  const base = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  return `${base}_q${hash}${ext}`;
}

/**
 * Relative reference (POSIX) from one mapped file to another, suitable as an
 * href/src value. Computed from the containing file's directory to the target.
 */
export function relativeRef(fromRelPath: string, toRelPath: string): string {
  const fromDir = posix.dirname(fromRelPath);
  const rel = posix.relative(fromDir, toRelPath);
  return rel === '' ? posix.basename(toRelPath) : rel;
}
