/**
 * Detect whether a 200-response body is actually a WAF / Cloudflare / AWS
 * challenge HTML page rather than the expected artifact.
 *
 * A content mismatch (expected PDF, body is not PDF) is NOT a challenge —
 * it is reported separately so callers can classify it as
 * 'content-validation-failed' (not retriable) rather than
 * 'challenge-not-passable' (retriable).
 */

const CHALLENGE_MARKERS: ReadonlyArray<{ marker: string; source: string }> = [
  { marker: '<title>just a moment', source: 'cloudflare' },
  { marker: 'awswafcookiedomainlist', source: 'aws-waf' },
  { marker: 'window.gokuprops', source: 'aws-waf' },
  { marker: 'cf-mitigated', source: 'cloudflare-header' },
  { marker: 'challenges.cloudflare.com', source: 'cloudflare' },
  { marker: 'attention required! | cloudflare', source: 'cloudflare' },
  { marker: 'checking your browser before accessing', source: 'cloudflare-legacy' },
  { marker: '<title>access denied</title>', source: 'akamai' },
];

export type ChallengeResult =
  | { kind: 'challenge'; source: string; marker: string }
  | { kind: 'content-mismatch'; detail: string }   // expected PDF, body is not PDF
  | null;

export function detectChallenge(body: Buffer, expectedFormat?: string): ChallengeResult {
  // PDF magic bytes — if format is pdf and bytes don't match, it's not a PDF.
  if (expectedFormat === 'pdf' || expectedFormat === 'application/pdf') {
    if (body.length < 5 || body.slice(0, 5).toString('ascii') !== '%PDF-') {
      // Sniff for known challenge markers; if found, return that source.
      const sniffed = sniffMarkers(body);
      if (sniffed) return sniffed;
      // Otherwise it's a plain content mismatch, not a challenge.
      return { kind: 'content-mismatch', detail: 'expected-pdf-magic-bytes' };
    }
    // Genuine PDF — definitely not a challenge.
    return null;
  }

  return sniffMarkers(body);
}

function sniffMarkers(body: Buffer): ChallengeResult {
  // Only look at the first 4 KB — challenge pages are small.
  const head = body.slice(0, 4096).toString('utf-8').toLowerCase();
  for (const { marker, source } of CHALLENGE_MARKERS) {
    if (head.includes(marker)) {
      return { kind: 'challenge', source, marker };
    }
  }
  return null;
}

/**
 * Inspect HTTP response headers for challenge indicators.
 * Some WAFs return challenge in headers even when body looks fine.
 * Returns a challenge result or null — never a content mismatch.
 */
export function detectChallengeHeaders(headers: Record<string, string>): ChallengeResult {
  const cfMitigated = headers['cf-mitigated'];
  if (cfMitigated && cfMitigated.toLowerCase() === 'challenge') {
    return { kind: 'challenge', source: 'cloudflare-header', marker: 'cf-mitigated: challenge' };
  }
  const wafAction = headers['x-amzn-waf-action'];
  if (wafAction && wafAction.toLowerCase() === 'challenge') {
    return { kind: 'challenge', source: 'aws-waf-header', marker: 'x-amzn-waf-action: challenge' };
  }
  return null;
}
