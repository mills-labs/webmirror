// The webmirror control panel: a single self-contained HTML page (inline CSS +
// JS, zero external requests). Exported as a template string so the UI server
// can serve it verbatim from GET /. Layout follows spec ADDENDUM A4 and the
// owner's field decisions.
//
// The inner <script> deliberately avoids backticks and ${...} so this file's
// own template literal does not need escaping.

export const PANEL_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webmirror</title>
<style>
  :root {
    --bg: #f4f5f7;
    --card: #ffffff;
    --ink: #1c2430;
    --muted: #64707d;
    --line: #d9dee4;
    --accent: #2563eb;
    --accent-ink: #ffffff;
    --ok: #15803d;
    --warn: #b45309;
    --err: #b91c1c;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  header h1 { font-size: 22px; margin: 0 0 4px; }
  header p { margin: 0 0 24px; color: var(--muted); }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 22px;
    margin-bottom: 18px;
  }
  label { display: block; font-weight: 600; margin-bottom: 5px; }
  .hint { font-weight: 400; color: var(--muted); font-size: 13px; }
  input[type=text], input[type=number], select, textarea {
    width: 100%;
    padding: 9px 11px;
    border: 1px solid var(--line);
    border-radius: 7px;
    font: inherit;
    color: var(--ink);
    background: #fff;
  }
  textarea { resize: vertical; min-height: 74px; font-family: var(--mono); font-size: 13px; }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  .row > .field { flex: 1 1 200px; }
  .pick { display: flex; gap: 8px; }
  .pick input { flex: 1; min-width: 0; }
  .pick button { white-space: nowrap; padding: 9px 14px; }
  .check { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; }
  .check input { margin-top: 3px; }
  .check label { margin: 0; }
  details { border-top: 1px solid var(--line); margin-top: 6px; padding-top: 14px; }
  summary { cursor: pointer; font-weight: 600; user-select: none; }
  summary::marker { color: var(--muted); }
  .adv { margin-top: 18px; }
  .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  button {
    font: inherit;
    font-weight: 600;
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 10px 18px;
    cursor: pointer;
  }
  button.primary { background: var(--accent); color: var(--accent-ink); }
  button.primary:disabled { background: #9db4ee; cursor: not-allowed; }
  button.ghost { background: #fff; border-color: var(--line); color: var(--ink); }
  button.ghost:disabled { color: var(--muted); cursor: not-allowed; }
  .errbox {
    display: none;
    background: #fdecec;
    border: 1px solid #f3b9b9;
    color: var(--err);
    border-radius: 7px;
    padding: 12px 14px;
    margin-bottom: 16px;
  }
  .errbox ul { margin: 6px 0 0; padding-left: 20px; }
  .status { font-weight: 600; }
  .status[data-s=running] { color: var(--accent); }
  .status[data-s=stopping] { color: var(--warn); }
  .status[data-s=done] { color: var(--ok); }
  .status[data-s=error] { color: var(--err); }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 14px; margin: 16px 0; }
  .metric { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .metric .k { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
  .metric .v { font-size: 19px; font-weight: 700; margin-top: 3px; }
  .current { font-family: var(--mono); font-size: 13px; color: var(--muted); word-break: break-all; margin-bottom: 12px; }
  .failures h3 { margin: 4px 0 8px; font-size: 14px; color: var(--err); }
  .failures ul { list-style: none; margin: 0; padding: 0; }
  .failures li { border: 1px solid #f0cfcf; background: #fdf5f5; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; font-size: 13px; }
  .failures .u { font-family: var(--mono); word-break: break-all; }
  .failures .r { color: var(--err); }
  .winddown { color: var(--warn); font-size: 13px; margin-top: 8px; }
  #progressCard { display: none; }
  footer { margin-top: 28px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
  footer a:hover { color: var(--accent); }
  footer .sep { margin: 0 6px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Webmirror</h1>
    <p>Download a website for full offline navigation.</p>
  </header>

  <div class="errbox" id="errbox"></div>

  <form id="form" class="card" autocomplete="off">
    <div class="field">
      <label for="url">Website address</label>
      <input type="text" id="url" name="url" placeholder="https://example.com" spellcheck="false">
    </div>

    <div class="row">
      <div class="field">
        <label for="maxDepth">Levels deep <span class="hint">(blank = whole site)</span></label>
        <input type="text" id="maxDepth" name="maxDepth" inputmode="numeric" placeholder="whole site">
      </div>
      <div class="field">
        <label for="outDir">Save location</label>
        <div class="pick">
          <input type="text" id="outDir" name="outDir" spellcheck="false" placeholder="mirror-example.com">
          <button type="button" class="ghost" id="chooseBtn">Choose&hellip;</button>
        </div>
      </div>
    </div>

    <details id="advanced">
      <summary>Advanced options</summary>
      <div class="adv">
        <div class="check">
          <input type="checkbox" id="subdomains" name="subdomains" checked>
          <label for="subdomains">Include subdomains <span class="hint">— pages on sub.example.com count as part of the site</span></label>
        </div>

        <div class="row">
          <div class="field">
            <label for="maxPages">Page limit <span class="hint">(blank = no limit)</span></label>
            <input type="text" id="maxPages" name="maxPages" inputmode="numeric" placeholder="no limit">
          </div>
          <div class="field">
            <label for="browser">JavaScript rendering</label>
            <select id="browser" name="browser">
              <option value="auto" selected>Automatic (render JS-heavy pages)</option>
              <option value="never">Never (static HTML only)</option>
              <option value="always">Always (render every page)</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label for="exclude">Skip URLs containing <span class="hint">(one pattern per line)</span></label>
          <textarea id="exclude" name="exclude" placeholder="/logout&#10;?print=1&#10;/cgi-bin/"></textarea>
        </div>

        <div class="row">
          <div class="field">
            <label for="maxFileSizeMb">Max file size (MB) <span class="hint">(blank = no cap)</span></label>
            <input type="text" id="maxFileSizeMb" name="maxFileSizeMb" inputmode="numeric" placeholder="200">
          </div>
          <div class="field">
            <label for="delayFromS">Politeness delay (seconds) <span class="hint">— random wait per page, 0.1&thinsp;s steps</span></label>
            <div class="pick">
              <input type="text" id="delayFromS" name="delayFromS" inputmode="decimal" placeholder="from 0.5">
              <input type="text" id="delayToS" name="delayToS" inputmode="decimal" placeholder="to 2">
            </div>
          </div>
        </div>

        <div class="check">
          <input type="checkbox" id="respectRobots" name="respectRobots" checked>
          <label for="respectRobots">Respect robots.txt</label>
        </div>

        <div class="field">
          <label for="mode">If a previous mirror exists</label>
          <select id="mode" name="mode">
            <option value="resume" selected>Resume — keep what was downloaded, fetch the rest</option>
            <option value="fresh">Fresh — ignore it and redownload everything</option>
          </select>
        </div>
      </div>
    </details>
  </form>

  <div class="card actions">
    <button type="button" class="primary" id="startBtn">Start</button>
    <button type="button" class="ghost" id="stopBtn" disabled>Stop</button>
    <button type="button" class="ghost" id="openBtn" style="display:none">Open mirror</button>
  </div>

  <div class="card" id="progressCard">
    <div>Status: <span class="status" id="status" data-s="idle">Idle</span></div>
    <div class="winddown" id="winddown" style="display:none">Winding down gracefully — saving progress so the mirror can be resumed.</div>
    <div class="metrics">
      <div class="metric"><div class="k">Pages</div><div class="v" id="mPages">0</div></div>
      <div class="metric"><div class="k">Assets</div><div class="v" id="mAssets">0</div></div>
      <div class="metric"><div class="k">Queue</div><div class="v" id="mQueue">0</div></div>
      <div class="metric"><div class="k">Downloaded</div><div class="v" id="mBytes">0 B</div></div>
    </div>
    <div class="current" id="current">&nbsp;</div>
    <div class="failures" id="failures"></div>
  </div>

  <footer>
    <span>&copy; 2026 Mills Labs</span><span class="sep">&middot;</span><a href="https://github.com/mills-labs" target="_blank" rel="noopener">GitHub</a>
  </footer>
</div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var startBtn = $('startBtn'), stopBtn = $('stopBtn'), openBtn = $('openBtn');
  var errbox = $('errbox'), progressCard = $('progressCard');
  var evtSource = null;

  function humanBytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(n) / Math.log(1024));
    if (i >= u.length) i = u.length - 1;
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function defaultOut(url) {
    try {
      if (url && url.indexOf('://') === -1) url = 'https://' + url;
      var h = new URL(url).hostname.replace(/^www\\./, '');
      return h ? 'mirror-' + h : '';
    } catch (e) { return ''; }
  }

  $('url').addEventListener('input', function () {
    var d = defaultOut($('url').value.trim());
    $('outDir').placeholder = d || 'mirror-<sitename>';
  });

  function showErrors(list) {
    if (!list || !list.length) { errbox.style.display = 'none'; return; }
    var html = '<strong>Please fix the following:</strong><ul>';
    for (var i = 0; i < list.length; i++) {
      html += '<li>' + escapeHtml(list[i]) + '</li>';
    }
    errbox.innerHTML = html + '</ul>';
    errbox.style.display = 'block';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function collectConfig() {
    var excludeLines = $('exclude').value.split('\\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
    return {
      url: $('url').value.trim(),
      maxDepth: $('maxDepth').value.trim(),
      outDir: $('outDir').value.trim(),
      subdomains: $('subdomains').checked,
      maxPages: $('maxPages').value.trim(),
      browser: $('browser').value,
      exclude: excludeLines,
      maxFileSizeMb: $('maxFileSizeMb').value.trim(),
      delayFromS: $('delayFromS').value.trim(),
      delayToS: $('delayToS').value.trim(),
      respectRobots: $('respectRobots').checked,
      mode: $('mode').value
    };
  }

  function render(state) {
    progressCard.style.display = 'block';
    var st = $('status');
    var labels = { idle: 'Idle', running: 'Running', stopping: 'Stopping', done: 'Completed', error: 'Failed' };
    st.textContent = labels[state.status] || state.status;
    st.setAttribute('data-s', state.status);

    $('winddown').style.display = state.status === 'stopping' ? 'block' : 'none';

    $('mPages').textContent = state.pagesDone || 0;
    $('mAssets').textContent = state.assetsDone || 0;
    $('mQueue').textContent = state.queueSize || 0;
    $('mBytes').textContent = humanBytes(state.bytes || 0);

    if (state.phase && state.currentUrl) {
      $('current').textContent = '[' + state.phase + '] ' + state.currentUrl;
    }

    var fails = state.failures || [];
    var fx = $('failures');
    if (fails.length) {
      var html = '<h3>Failures (' + fails.length + ')</h3><ul>';
      for (var i = 0; i < fails.length; i++) {
        var f = fails[i];
        html += '<li><span class="u">' + escapeHtml(f.url) + '</span><br>' +
          '<span class="r">' + escapeHtml(f.category + ': ' + f.reason) + '</span></li>';
      }
      fx.innerHTML = html + '</ul>';
    } else {
      fx.innerHTML = '';
    }

    var running = state.status === 'running' || state.status === 'stopping';
    startBtn.disabled = running;
    stopBtn.disabled = state.status !== 'running';
    openBtn.style.display = (state.status === 'done' && state.outDir) ? 'inline-block' : 'none';
  }

  function subscribe() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource('/api/events');
    evtSource.onmessage = function (e) {
      try { render(JSON.parse(e.data)); } catch (err) {}
    };
  }

  startBtn.addEventListener('click', function () {
    showErrors(null);
    startBtn.disabled = true;
    fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectConfig())
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    }).then(function (res) {
      if (res.ok) { subscribe(); return; }
      startBtn.disabled = false;
      if (res.status === 409) { showErrors(['A mirror is already running. Stop it before starting another.']); }
      else { showErrors(res.body && res.body.errors ? res.body.errors : ['Could not start the mirror.']); }
    }).catch(function () {
      startBtn.disabled = false;
      showErrors(['Could not reach the webmirror service.']);
    });
  });

  var chooseBtn = $('chooseBtn');
  chooseBtn.addEventListener('click', function () {
    chooseBtn.disabled = true;
    chooseBtn.textContent = 'Waiting for dialog\\u2026';
    fetch('/api/choose-folder', { method: 'POST' }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      if (res.ok && res.body.path) {
        // Append the suggested mirror-<sitename> subfolder so the mirror lands
        // in its own directory inside the chosen folder.
        var base = res.body.path;
        if (base.charAt(base.length - 1) !== '/') base += '/';
        var sub = defaultOut($('url').value.trim());
        $('outDir').value = base + (sub || 'mirror');
      } else if (!res.ok) {
        showErrors(res.body && res.body.errors ? res.body.errors : ['Could not open the folder dialog.']);
      }
      // Cancelled: leave the field as it was.
    }).catch(function () {
      showErrors(['Could not reach the webmirror service.']);
    }).then(function () {
      chooseBtn.disabled = false;
      chooseBtn.textContent = 'Choose\\u2026';
    });
  });

  stopBtn.addEventListener('click', function () {
    stopBtn.disabled = true;
    fetch('/api/stop', { method: 'POST' }).catch(function () {});
  });

  openBtn.addEventListener('click', function () {
    fetch('/api/open', { method: 'POST' }).catch(function () {});
  });

  // Reflect any run already in progress when the page loads.
  fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) {
    if (s && s.status && s.status !== 'idle') { render(s); subscribe(); }
  }).catch(function () {});
})();
</script>
</body>
</html>`;
