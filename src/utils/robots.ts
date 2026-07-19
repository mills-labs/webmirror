/**
 * robots.txt parser — extracted from scrape-site.ts
 *
 * Supports Allow and Disallow with `*` wildcards and `$` end anchors.
 * Precedence follows Google semantics: longest pattern wins; Allow wins ties.
 * Group selection matches the ACTUAL crawl user agent (case-insensitive
 * substring match on the group's product token), falling back to `*`.
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;                  // raw pattern text (for length-based precedence)
  regex: RegExp;
}

export interface RobotsRules {
  rules: RobotsRule[];
  crawlDelay: number | null;
}

/**
 * Compile a robots.txt path pattern to a regex.
 * `*` matches any sequence; a trailing `$` anchors the end; everything else is literal.
 */
function compilePattern(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let out = '^';
  for (const ch of body) {
    out += ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (anchored) out += '$';
  return new RegExp(out);
}

interface RobotsGroup {
  agents: string[];                 // lowercased user-agent tokens
  rules: RobotsRule[];
  crawlDelay: number | null;
}

/**
 * Parse robots.txt text, keeping only the groups that apply to `userAgent`.
 * A group applies when one of its user-agent tokens appears (case-insensitively)
 * in the crawl UA; if no specific group matches, the `*` groups apply.
 */
export function parseRobotsTxt(text: string, userAgent: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let inAgentHeader = false;        // consecutive user-agent lines share one group

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().split('#')[0].trim();
    if (!line) continue;

    const [directive, ...valueParts] = line.split(':');
    const key = directive.trim().toLowerCase();
    const value = valueParts.join(':').trim();

    if (key === 'user-agent') {
      if (!inAgentHeader || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        inAgentHeader = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    inAgentHeader = false;
    if (!current) continue;

    if ((key === 'disallow' || key === 'allow') && value) {
      current.rules.push({ allow: key === 'allow', pattern: value, regex: compilePattern(value) });
    }

    if (key === 'crawl-delay') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && parsed > 0) {
        if (current.crawlDelay === null || parsed > current.crawlDelay) {
          current.crawlDelay = parsed;
        }
      }
    }
  }

  const uaLower = userAgent.toLowerCase();
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && a !== '' && uaLower.includes(a)));
  const applicable = specific.length > 0 ? specific : groups.filter(g => g.agents.includes('*'));

  const rules: RobotsRules = { rules: [], crawlDelay: null };
  for (const group of applicable) {
    rules.rules.push(...group.rules);
    if (group.crawlDelay !== null) {
      if (rules.crawlDelay === null || group.crawlDelay > rules.crawlDelay) {
        rules.crawlDelay = group.crawlDelay;
      }
    }
  }
  return rules;
}

export async function fetchRobotsTxt(baseUrl: string, userAgent: string): Promise<RobotsRules> {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const res = await fetch(robotsUrl, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { rules: [], crawlDelay: null };

    return parseRobotsTxt(await res.text(), userAgent);
  } catch {
    // Could not fetch robots.txt — proceed with defaults
    return { rules: [], crawlDelay: null };
  }
}

export function isDisallowed(pathname: string, rules: RobotsRules): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (!rule.regex.test(pathname)) continue;
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best !== null && !best.allow;
}

/**
 * Determine the effective delay, respecting robots.txt Crawl-delay.
 */
export function effectiveDelay(baseDelay: number, robotsCrawlDelay: number | null): number {
  if (robotsCrawlDelay === null) return baseDelay;
  const robotsMs = robotsCrawlDelay * 1000;
  return Math.max(baseDelay, robotsMs);
}
