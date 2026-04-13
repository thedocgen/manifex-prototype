// Pure-string markdown → HTML. Mirrors components/Markdown.tsx behavior
// (same subset: headings, paragraphs, - lists, fenced code, **bold**,
// *italic*, `code`, [label](url)) but returns an HTML string so it can be
// used from server routes that emit a standalone document for PDF export.
//
// Do NOT import React here — this runs in route handlers where we want a
// cheap string out, not a component tree.

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Single-pass inline tokenizer matching Markdown.tsx's regex union.
// Order matters: ** before * so bold doesn't get read as two italics.
const INLINE_PATTERN = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|`([^`\n]+?)`|\[([^\]\n]+?)\]\(([^)\n]+?)\)/g;

function renderInline(text: string): string {
  const out: string[] = [];
  let cursor = 0;
  INLINE_PATTERN.lastIndex = 0;
  while (cursor < text.length) {
    INLINE_PATTERN.lastIndex = cursor;
    const m = INLINE_PATTERN.exec(text);
    if (!m) {
      out.push(escapeHtml(text.slice(cursor)));
      break;
    }
    if (m.index > cursor) out.push(escapeHtml(text.slice(cursor, m.index)));
    if (m[1] !== undefined) {
      out.push(`<strong>${escapeHtml(m[1])}</strong>`);
    } else if (m[2] !== undefined) {
      out.push(`<em>${escapeHtml(m[2])}</em>`);
    } else if (m[3] !== undefined) {
      out.push(`<code>${escapeHtml(m[3])}</code>`);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      out.push(`<a href="${escapeAttr(m[5])}">${escapeHtml(m[4])}</a>`);
    }
    cursor = m.index + m[0].length;
  }
  return out.join('');
}

const FENCE_RE = /^```(\S*)\s*$/;

export function markdownToHtml(content: string): string {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let listBuffer: string[] = [];
  let codeBuffer: string[] | null = null;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    blocks.push(`<ul>${listBuffer.map(li => `<li>${li}</li>`).join('')}</ul>`);
    listBuffer = [];
  };

  const flushCode = () => {
    if (codeBuffer === null) return;
    blocks.push(`<pre class="mx-md-pre"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
    codeBuffer = null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(FENCE_RE);

    if (codeBuffer !== null) {
      if (fenceMatch) flushCode();
      else codeBuffer.push(raw);
      continue;
    }

    if (fenceMatch) {
      flushList();
      codeBuffer = [];
      continue;
    }

    if (!trimmed) {
      flushList();
      continue;
    }

    if (trimmed.startsWith('### ')) {
      flushList();
      const text = trimmed.slice(4);
      blocks.push(`<h3 id="${escapeAttr(slugify(text))}">${renderInline(text)}</h3>`);
    } else if (trimmed.startsWith('## ')) {
      flushList();
      const text = trimmed.slice(3);
      blocks.push(`<h2 id="${escapeAttr(slugify(text))}">${renderInline(text)}</h2>`);
    } else if (trimmed.startsWith('# ')) {
      flushList();
      blocks.push(`<h1>${renderInline(trimmed.slice(2))}</h1>`);
    } else if (trimmed.startsWith('- ')) {
      listBuffer.push(renderInline(trimmed.slice(2)));
    } else {
      flushList();
      blocks.push(`<p>${renderInline(trimmed)}</p>`);
    }
  }

  // Unclosed fence at EOF still flushes.
  flushCode();
  flushList();

  return blocks.join('\n');
}
