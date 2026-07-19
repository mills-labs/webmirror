/**
 * webmirror command-line interface.
 *
 * Parses the flags from the specification, runs the mirror engine, and prints a
 * completion summary. `main()` is exported for the bin shim.
 */

import { mirror, type MirrorOptions, type MirrorResult } from './mirror';
import { runUi } from './ui/ui';
import { createRealEngine } from './ui/adapter';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const USAGE = `webmirror <url> [options]
  webmirror ui [--port <n>] [--no-open]   open the browser control panel

  --out <dir>            output directory (default: ./mirror-<hostname>)
  --max-pages <n>        page limit, 0 = unlimited (default 0)
  --max-depth <n>        link-levels from the seed to follow, 0 = unlimited (default 0)
  --levels <n>           alias for --max-depth
  --delay <ms>           base politeness delay between page fetches (default 500, jittered)
  --delay-min <seconds>  lower bound of a randomized delay range (decimals allowed)
  --delay-max <seconds>  upper bound of the range; each page waits a random
                         duration between min and max, in 0.1s steps
  --browser <mode>       auto | never | always   (default auto)
  --no-subdomains        restrict to the exact start host
  --no-robots            ignore robots.txt (default: respect it for all fetches)
  --max-file-size <mb>   per-file cap, 0 = unlimited (default 200)
  --exclude <pattern>    skip URLs containing this substring (repeatable)
  --user-agent <ua>      override UA
  --fresh                ignore previous manifest, redownload everything`;

class CliError extends Error {}

/** Parse an integer flag, rejecting non-numeric input instead of defaulting. */
function parseIntFlag(name: string, value: string | undefined): number {
  if (value === undefined) throw new CliError(`Missing value for ${name}`);
  if (!/^\d+$/.test(value)) throw new CliError(`${name} expects a non-negative integer, got "${value}"`);
  return parseInt(value, 10);
}

function parseSecondsFlag(name: string, value: string | undefined): number {
  if (value === undefined) throw new CliError(`Missing value for ${name}`);
  if (!/^\d+(\.\d+)?$/.test(value)) throw new CliError(`${name} expects seconds (e.g. 1.5), got "${value}"`);
  return parseFloat(value);
}

interface ParsedArgs {
  options: MirrorOptions;
}

function parseArgs(argv: string[]): ParsedArgs {
  let seedUrl: string | undefined;
  let out: string | undefined;
  let maxPages = 0;
  let maxDepth = 0;
  let delayMs = 500;
  let delayMaxMs: number | undefined;
  let browser: MirrorOptions['browser'] = 'auto';
  let subdomains = true;
  let respectRobots = true;
  let maxFileSizeMb = 200;
  let userAgent = DEFAULT_USER_AGENT;
  let fresh = false;
  const exclude: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--out':
        out = argv[++i];
        if (out === undefined) throw new CliError('Missing value for --out');
        break;
      case '--max-pages':
        maxPages = parseIntFlag('--max-pages', argv[++i]);
        break;
      case '--max-depth':
      case '--levels':
        maxDepth = parseIntFlag(arg, argv[++i]);
        break;
      case '--exclude': {
        const pattern = argv[++i];
        if (pattern === undefined) throw new CliError('Missing value for --exclude');
        exclude.push(pattern);
        break;
      }
      case '--delay':
        delayMs = parseIntFlag('--delay', argv[++i]);
        break;
      case '--delay-min':
        delayMs = Math.round(parseSecondsFlag('--delay-min', argv[++i]) * 1000);
        break;
      case '--delay-max':
        delayMaxMs = Math.round(parseSecondsFlag('--delay-max', argv[++i]) * 1000);
        break;
      case '--browser': {
        const mode = argv[++i];
        if (mode !== 'auto' && mode !== 'never' && mode !== 'always') {
          throw new CliError(`--browser expects auto|never|always, got "${mode ?? ''}"`);
        }
        browser = mode;
        break;
      }
      case '--no-subdomains':
        subdomains = false;
        break;
      case '--no-robots':
        respectRobots = false;
        break;
      case '--max-file-size':
        maxFileSizeMb = parseIntFlag('--max-file-size', argv[++i]);
        break;
      case '--user-agent':
        userAgent = argv[++i];
        if (userAgent === undefined) throw new CliError('Missing value for --user-agent');
        break;
      case '--fresh':
        fresh = true;
        break;
      case '-h':
      case '--help':
        throw new CliError(USAGE);
      default:
        if (arg.startsWith('-')) throw new CliError(`Unknown option: ${arg}`);
        if (seedUrl !== undefined) throw new CliError(`Unexpected argument: ${arg}`);
        seedUrl = arg;
    }
  }

  if (seedUrl === undefined) throw new CliError(`Missing <url>.\n\n${USAGE}`);

  if (delayMaxMs !== undefined && delayMaxMs < delayMs) {
    throw new CliError('--delay-max cannot be smaller than --delay-min.');
  }

  // Accept scheme-less addresses the way people actually type them.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(seedUrl)) seedUrl = `https://${seedUrl}`;

  let hostname: string;
  try {
    hostname = new URL(seedUrl).hostname;
  } catch {
    throw new CliError(`Invalid URL: ${seedUrl}`);
  }

  const outDir = out ?? `./mirror-${hostname}`;

  return {
    options: {
      seedUrl,
      outDir,
      maxPages,
      maxDepth,
      delayMs,
      delayMaxMs,
      browser,
      subdomains,
      respectRobots,
      maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
      userAgent,
      fresh,
      exclude,
    },
  };
}

function printSummary(result: MirrorResult): void {
  const mb = (result.bytes / 1024 / 1024).toFixed(1);
  console.log('');
  console.log('Mirror complete.');
  console.log(`  Pages:          ${result.pages}`);
  console.log(`  Assets:         ${result.assets}`);
  console.log(`  Bytes:          ${result.bytes} (${mb} MB)`);
  console.log(`  Robots-skipped: ${result.robotsSkipped}`);
  console.log(`  Excluded:       ${result.excluded}`);
  console.log(`  Failures:       ${result.failures.length}`);
  for (const f of result.failures) {
    console.log(`    - [${f.status}] ${f.url}${f.error ? ` — ${f.error}` : ''}`);
  }
  console.log('');
  console.log(`  Manifest: ${result.manifestPath}`);
  console.log(`  Report:   ${result.reportPath}`);
}

/**
 * Parse the `ui` subcommand flags: `--port <n>` pins the port (default: a random
 * free port), `--no-open` suppresses opening the browser.
 */
function parseUiArgs(argv: string[]): { port?: number; openBrowser: boolean } {
  let port: number | undefined;
  let openBrowser = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port':
        port = parseIntFlag('--port', argv[++i]);
        break;
      case '--no-open':
        openBrowser = false;
        break;
      case '-h':
      case '--help':
        throw new CliError(USAGE);
      default:
        throw new CliError(`Unknown option for 'ui': ${arg}`);
    }
  }
  return { port, openBrowser };
}

/**
 * Start the browser control panel bound to the real engine. `runUi` prints the
 * panel URL, opens the browser (unless suppressed), and keeps the process alive
 * via its listening server.
 */
function runUiCommand(argv: string[]): void {
  let opts: { port?: number; openBrowser: boolean };
  try {
    opts = parseUiArgs(argv);
  } catch (err) {
    console.error(err instanceof CliError ? err.message : String(err));
    process.exit(1);
  }
  runUi(createRealEngine(), { port: opts.port, openBrowser: opts.openBrowser });
}

/**
 * CLI entry point. Parses argv (defaults to process.argv), runs the mirror, and
 * prints a summary. Argument errors exit the process with code 1.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // The `ui` subcommand must be detected before parseArgs, which treats any
  // non-flag token as the seed URL (an unguarded `ui` would become an invalid URL).
  if (argv[0] === 'ui') {
    runUiCommand(argv.slice(1));
    return;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof CliError ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Mirroring ${parsed.options.seedUrl} → ${parsed.options.outDir}`);
  const result = await mirror(parsed.options);
  printSummary(result);
}
