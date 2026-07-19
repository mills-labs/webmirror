/**
 * @local/webmirror — library entry point.
 *
 * Re-exports the mirror engine API and the pure mapping/rewrite helpers so the
 * tool can be driven programmatically as well as from the CLI.
 */

export { mirror } from './mirror';
export type {
  MirrorOptions,
  MirrorProgress,
  MirrorResult,
  MirrorFailure,
  MirrorStatus,
  ManifestEntry,
  MirrorManifest,
} from './mirror';

export {
  computeScopeRoot,
  isInPageScope,
  normalizeUrl,
  mapUrlToLocal,
  relativeRef,
  sanitizeSegment,
  isPageExtension,
} from './url-map';
export type { ResourceKind, MappedTarget } from './url-map';

export { rewriteHtml, rewriteCss, rewriteSrcset, parseSrcset } from './rewrite';
export type { RefResolver, RefResolution } from './rewrite';

export { extractLinks, extractCssRefs } from './extract';
export type { ExtractResult } from './extract';

export { fetchStatic, needsRendering, isHtmlContentType, Renderer } from './fetch-render';
export type { StaticFetchResult, Fetcher } from './fetch-render';

export { main } from './cli';
