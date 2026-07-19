# webmirror

> New to this tool? Read [HOW_TO_USE.md](HOW_TO_USE.md) — a plain-English guide
> with no technical background required.

Mirror a website for full offline navigation. `webmirror` crawls a site
breadth-first, downloads every page and asset (with an optional headless-browser
fallback for JavaScript-rendered pages), and rewrites all saved HTML and CSS so
the copy navigates entirely offline. A manifest records every URL's outcome and
drives resumable runs. 

# Intent of this tool 

One of my favourite websites disappeared without notice and it was the only niche website of its kind. I realized then, that the internet is a constantly changing resource and  knowledge can easily disappear or be changed. I struggled with trialware after they couldn't cope with multiple website levels and files so I built my own for offline personal knowledge capture. This tool is designed to be respect hosting services if slower fetch rates are used. 

## Install

```
npm install
npm run build
```

This produces the `webmirror` binary (see `bin/webmirror.js`).

## Command line

```
webmirror <url> [options]
```

| Option | Description |
| --- | --- |
| `--out <dir>` | Output directory (default: `./mirror-<hostname>`). |
| `--max-pages <n>` | Page limit; `0` = unlimited (default 0). |
| `--max-depth <n>` | Link-levels from the seed to follow; `0` = unlimited (default 0). |
| `--levels <n>` | Alias for `--max-depth`. |
| `--delay <ms>` | Base politeness delay between page fetches (default 500, jittered). |
| `--browser <mode>` | `auto` \| `never` \| `always` (default `auto`). |
| `--no-subdomains` | Restrict the crawl to the exact start host. |
| `--no-robots` | Ignore `robots.txt` (default: respect it for all fetches). |
| `--max-file-size <mb>` | Per-file cap in megabytes; `0` = unlimited (default 200). |
| `--exclude <pattern>` | Skip URLs containing this substring (repeatable). |
| `--user-agent <ua>` | Override the User-Agent header. |
| `--fresh` | Ignore any previous manifest and redownload everything. |

A run can be interrupted with Ctrl-C; the manifest is saved so a later run with
the same output directory resumes where it left off.

Example:

```
webmirror https://example.com --max-depth 2 --out ./example-mirror
```

## Browser control panel

```
webmirror ui [--port <n>] [--no-open]
```

Starts a local control panel on `127.0.0.1`, prints its URL, and opens it in the
browser (pass `--no-open` to suppress). Non-technical users can instead
double-click `Start Webmirror.command` in the repo root, which runs first-time
setup if needed and then launches the panel. `--port <n>` pins the port; the default
is a random free port. The panel runs one mirror at a time, streams live
progress (pages, assets, queue, bytes downloaded, and any failures) over
Server-Sent Events, and offers a **Stop** button that winds the run down
gracefully so it can be resumed.

The panel's fields mirror the CLI flags:

| Panel field | CLI flag |
| --- | --- |
| Website address | `<url>` |
| Levels deep | `--max-depth` |
| Save location | `--out` |
| Include subdomains | inverse of `--no-subdomains` |
| Page limit | `--max-pages` |
| JavaScript rendering | `--browser` |
| Skip URLs containing | `--exclude` (one pattern per line) |
| Max file size (MB) | `--max-file-size` |
| Politeness delay (ms) | `--delay` |
| Respect robots.txt | inverse of `--no-robots` |
| If a previous mirror exists (Resume / Fresh) | `--fresh` |

The panel is a single self-contained page served locally; it makes no external
network requests.

## Development

```
npm run build      # compile to dist/
npm run typecheck  # type-check src and test without emitting
npm test           # run the vitest suite
```

## Responsible use

This tool respects `robots.txt` by default (disable only with `--no-robots`, at your own risk) and
paces its requests with a politeness delay. Mirror only sites you are authorized to copy, and follow
each site's terms of use and applicable law. A mirror is a copy of someone else's content: the output
directory is git-ignored and is not part of this repository.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 [Mills Labs](https://github.com/mills-labs).
