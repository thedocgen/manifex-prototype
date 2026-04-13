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
  window.__manifexRunTests = function(){
    var tests = window.__manifexTests || [];
    var results = [];
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      try { t.fn(); results.push({ name: t.name, passed: true }); }
      catch (e) { results.push({ name: t.name, passed: false, error: (e && e.message) || String(e) }); }
    }
    return { total: results.length, passed: results.filter(function(r){return r.passed;}).length, results: results };
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
