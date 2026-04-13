import { getSession } from '@/lib/store';
import { markdownToHtml } from '@/lib/markdownToHtml';
import type { TreeNode, ManifestState } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Walk the manifest tree in order, emitting one <section> per page. Pages
// whose path starts with '_' are meta entries (Build History etc.) and are
// excluded from the print output — those only make sense in the live editor.
function collectPages(tree: TreeNode[], pages: ManifestState['pages']): Array<{ path: string; title: string; content: string }> {
  const out: Array<{ path: string; title: string; content: string }> = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (!node.path.startsWith('_')) {
        const page = pages[node.path];
        if (page) {
          out.push({ path: node.path, title: page.title || node.title, content: page.content || '' });
        }
      }
      if (node.children && node.children.length > 0) walk(node.children);
    }
  };
  walk(tree);
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!
  ));
}

function renderDocument(title: string, pages: Array<{ path: string; title: string; content: string }>, autoPrint: boolean): string {
  // TOC precedes all content sections and is itself a section so print
  // page-break rules apply uniformly. Skipped when there's only one page —
  // a single-entry TOC is noise, not navigation.
  const toc = pages.length > 1 ? `
    <section class="mx-page mx-page-first mx-toc" data-path="__toc">
      <h1 class="mx-page-title">Contents</h1>
      <ol class="mx-toc-list">
${pages.map(p => `        <li><a href="#pg-${escapeHtml(p.path)}">${escapeHtml(p.title)}</a></li>`).join('\n')}
      </ol>
    </section>
  ` : '';

  const sections = pages.map((p, i) => `
    <section class="mx-page${toc === '' && i === 0 ? ' mx-page-first' : ''}" id="pg-${escapeHtml(p.path)}" data-path="${escapeHtml(p.path)}">
      <h1 class="mx-page-title">${escapeHtml(p.title)}</h1>
      <div class="mx-md">
${markdownToHtml(p.content)}
      </div>
    </section>
  `).join('\n');

  // Print CSS is tuned for Letter/A4 with page breaks between sections.
  // Screen styles are intentionally minimal — this is a staging page, not a
  // place to spend design effort. Users see it briefly before the print
  // dialog opens (or while reviewing before Ctrl+P).
  const css = `
    :root {
      --mx-ink: #0f172a;
      --mx-muted: #475569;
      --mx-rule: #e2e8f0;
      --mx-bg: #ffffff;
      --mx-accent: #2563eb;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #f1f5f9;
      color: var(--mx-ink);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      font-size: 11pt;
      line-height: 1.55;
    }
    .mx-print-toolbar {
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 12px 24px;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
    .mx-print-toolbar button {
      background: var(--mx-accent);
      color: white;
      border: 0;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .mx-print-toolbar button:hover { filter: brightness(1.1); }
    .mx-print-toolbar .mx-hint { font-size: 12px; opacity: 0.7; }
    .mx-doc {
      max-width: 7.5in;
      margin: 24px auto;
      padding: 0.75in;
      background: var(--mx-bg);
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .mx-page { margin-bottom: 2em; }
    .mx-page + .mx-page { border-top: 1px solid var(--mx-rule); padding-top: 2em; }
    .mx-page-title {
      font-size: 22pt;
      font-weight: 700;
      margin: 0 0 0.5em 0;
      color: var(--mx-ink);
      border-bottom: 2px solid var(--mx-ink);
      padding-bottom: 0.25em;
    }
    .mx-md h1 { font-size: 18pt; margin-top: 1.2em; margin-bottom: 0.4em; }
    .mx-md h2 { font-size: 14pt; margin-top: 1em; margin-bottom: 0.3em; color: var(--mx-ink); }
    .mx-md h3 { font-size: 12pt; margin-top: 0.8em; margin-bottom: 0.2em; color: var(--mx-muted); }
    .mx-md p { margin: 0 0 0.6em 0; }
    .mx-md ul { margin: 0.3em 0 0.8em 1.2em; padding: 0; }
    .mx-md li { margin-bottom: 0.2em; }
    .mx-md code {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.9em;
      background: #f1f5f9;
      padding: 1px 4px;
      border-radius: 3px;
    }
    .mx-md a { color: var(--mx-accent); text-decoration: underline; }
    .mx-md-pre {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 9pt;
      background: #f8fafc;
      border: 1px solid var(--mx-rule);
      border-radius: 4px;
      padding: 10px 12px;
      overflow-x: auto;
      white-space: pre;
      line-height: 1.3;
      margin: 0.6em 0;
    }
    .mx-md-pre code { background: transparent; padding: 0; font-size: inherit; }
    .mx-toc-list { list-style: decimal; margin: 0.5em 0 0 1.5em; padding: 0; font-size: 12pt; }
    .mx-toc-list li { margin: 0.3em 0; }
    .mx-toc-list a { color: var(--mx-ink); text-decoration: none; }
    .mx-toc-list a:hover { color: var(--mx-accent); text-decoration: underline; }

    @media print {
      @page { size: letter; margin: 0.75in; }
      html, body { background: white; }
      .mx-print-toolbar { display: none !important; }
      .mx-doc { max-width: none; margin: 0; padding: 0; box-shadow: none; }
      .mx-page { page-break-inside: auto; }
      .mx-page + .mx-page { page-break-before: always; border-top: 0; padding-top: 0; }
      .mx-page-title { page-break-after: avoid; }
      .mx-md h1, .mx-md h2, .mx-md h3 { page-break-after: avoid; }
      .mx-md p, .mx-md li { orphans: 3; widows: 3; }
      .mx-md-pre { page-break-inside: avoid; }
      a { color: var(--mx-ink); text-decoration: none; }
    }
  `;

  const script = autoPrint ? `
    <script>
      // Fire the print dialog once layout has settled. rAF twice so fonts
      // and images have a chance to resolve before the browser snapshots.
      window.addEventListener('load', () => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          setTimeout(() => window.print(), 150);
        }));
      });
    </script>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
  <div class="mx-print-toolbar">
    <div><strong>${escapeHtml(title)}</strong> <span class="mx-hint">— print-ready export</span></div>
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <main class="mx-doc">
${toc}
${sections}
  </main>
  ${script}
</body>
</html>`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  // ?auto=1 triggers window.print() on load. Omit for a preview-only view.
  const autoPrint = url.searchParams.get('auto') === '1';

  let session;
  try {
    session = await getSession(id);
  } catch (e: any) {
    return new Response(`Failed to load session: ${e?.message || 'unknown'}`, { status: 500 });
  }
  if (!session) {
    return new Response('Session not found', { status: 404 });
  }

  const manifest = session.manifest_state;
  if (!manifest || !manifest.tree || !manifest.pages) {
    return new Response('Session has no manifest to export', { status: 400 });
  }

  const pages = collectPages(manifest.tree, manifest.pages);
  if (pages.length === 0) {
    return new Response('Manifest contains no exportable pages', { status: 400 });
  }

  const title = (pages[0]?.title || 'Manifex Document').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const html = renderDocument(title, pages, autoPrint);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
