import type { CodexFiles } from './types';

/**
 * Inline a Manifex codex (3 files: index.html, styles.css, app.js) into a single
 * self-contained HTML document for iframe srcDoc rendering.
 *
 * Robust to multiple <link> and <script> tag formats — replaces ANY <link> referencing
 * styles.css and ANY <script> referencing app.js, regardless of attribute order or quoting.
 */
const TEST_RUNNER_SCRIPT = `
(function(){
  // Helpers exposed on window so test functions can use them without
  // redefining inside every test file.
  window.__manifexSleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  window.__manifexQuery = function(sel){ return document.querySelector(sel); };
  window.__manifexQueryAll = function(sel){ return Array.from(document.querySelectorAll(sel)); };
  window.__manifexClick = function(sel){
    var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) throw new Error('click target not found: ' + sel);
    el.click();
  };
  window.__manifexType = function(sel, value){
    var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) throw new Error('input not found: ' + sel);
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                 Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Navigation guard installed for the duration of a test run. Without this,
  // a test that clicks an <a href="/something"> tag (or the compiled app's
  // own click handler does) navigates the iframe away from the test page —
  // the runner script is gone, the parent's promise never resolves, and
  // the Validate button hangs at 'Validating…' forever. The compiled app
  // itself usually wants navigation to work, so we only block it while a
  // test run is in progress.
  function installNavGuard(){
    var clickGuard = function(e){
      var el = e.target && e.target.closest && e.target.closest('a[href]');
      if (el) e.preventDefault();
    };
    var beforeUnload = function(e){ e.preventDefault(); e.returnValue = ''; return ''; };
    document.addEventListener('click', clickGuard, true);
    window.addEventListener('beforeunload', beforeUnload);
    return function uninstall(){
      document.removeEventListener('click', clickGuard, true);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }

  window.__manifexRunTests = async function(){
    var tests = window.__manifexTests || [];
    var results = [];
    var uninstall = installNavGuard();
    try {
      for (var i = 0; i < tests.length; i++) {
        var t = tests[i];
        var category = t.category || 'structural';
        var startedAt = Date.now();
        try {
          // fn may return a Promise — await it. Handles both sync and async tests.
          // Race against a per-test timeout so a hung await can't lock the whole run.
          var TEST_TIMEOUT_MS = 8000;
          await Promise.race([
            Promise.resolve(t.fn()),
            new Promise(function(_, reject){ setTimeout(function(){ reject(new Error('test timed out after ' + TEST_TIMEOUT_MS + 'ms')); }, TEST_TIMEOUT_MS); }),
          ]);
          results.push({ name: t.name, category: category, passed: true, durationMs: Date.now() - startedAt });
        } catch (e) {
          results.push({ name: t.name, category: category, passed: false, error: (e && e.message) || String(e), durationMs: Date.now() - startedAt });
        }
      }
    } finally {
      uninstall();
    }
    return {
      total: results.length,
      passed: results.filter(function(r){return r.passed;}).length,
      structural: results.filter(function(r){return r.category === 'structural';}).length,
      behavior: results.filter(function(r){return r.category === 'behavior';}).length,
      results: results,
    };
  };
})();`;

export function inlineCodex(files: CodexFiles): string {
  let html = files['index.html'];
  const css = files['styles.css'];
  const js = files['app.js'];
  const tests = files['tests.js'];

  // Replace any <link ... href="styles.css" ...> (or .href='styles.css') with inline <style>
  html = html.replace(
    /<link\b[^>]*href=["']styles\.css["'][^>]*\/?>/gi,
    `<style>${css}</style>`
  );

  // Replace any <script ... src="app.js" ...></script> with inline <script>
  html = html.replace(
    /<script\b[^>]*src=["']app\.js["'][^>]*><\/script>/gi,
    `<script>${js}</script>`
  );

  // Defensive: if neither tag was found (e.g. LLM forgot to include them),
  // inject the styles in <head> and the script before </body>
  if (!html.includes('<style>')) {
    html = html.replace(/<\/head>/i, `<style>${css}</style></head>`);
    if (!html.includes('<style>')) {
      // No </head> either — prepend
      html = `<style>${css}</style>` + html;
    }
  }
  if (!html.includes(`<script>${js}`)) {
    html = html.replace(/<\/body>/i, `<script>${js}</script></body>`);
    if (!html.includes(`<script>${js}`)) {
      html = html + `<script>${js}</script>`;
    }
  }

  // Inject tests.js + runner harness if tests were generated.
  if (tests) {
    const testsBlock = `<script data-manifex-tests>${tests}\n${TEST_RUNNER_SCRIPT}</script>`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${testsBlock}</body>`);
    } else {
      html = html + testsBlock;
    }
  }

  return html;
}

/**
 * Build a standalone HTML document from a codex (for the breakout / open-in-tab view).
 * Same as inlineCodex but wraps in a clean shell if needed.
 */
export function standaloneCodex(files: CodexFiles): string {
  return inlineCodex(files);
}
