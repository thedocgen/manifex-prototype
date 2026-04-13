// Tiny markdown renderer for Manifex.
// Supports: # h1, ## h2, ### h3, paragraphs, - lists, `inline code`.
// Optional `diff` mode highlights added/removed lines via line-level comparison.
// Optional `searchTerm` highlights matching text with <mark> tags.

interface Props {
  content: string;
  diffAgainst?: string | null;
  searchTerm?: string;
  activeMatchIndex?: number;
  onSectionHover?: (section: string | null) => void;
}

interface Line {
  text: string;
  status: 'unchanged' | 'added' | 'removed';
}

function diffLines(current: string, base: string | null | undefined): Line[] {
  if (!base) {
    return current.split('\n').map(text => ({ text, status: 'unchanged' as const }));
  }
  const baseLines = new Set(base.split('\n'));
  const currentLines = current.split('\n');
  const currentSet = new Set(currentLines);

  const result: Line[] = currentLines.map(line => ({
    text: line,
    status: baseLines.has(line) ? 'unchanged' as const : 'added' as const,
  }));

  void currentSet;
  return result;
}

// Global state — reset before each render
let _matchCounter = 0;
let _sectionHoverCallback: ((section: string | null) => void) | null = null;

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function highlightSearch(text: string, term: string, activeIdx: number): React.ReactNode[] {
  if (!term) return [text];
  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let searchStart = 0;

  while (true) {
    const idx = lower.indexOf(termLower, searchStart);
    if (idx === -1) break;
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    const matchIdx = _matchCounter++;
    const isActive = matchIdx === activeIdx;
    parts.push(
      <mark
        key={`m${matchIdx}`}
        className={isActive ? 'mx-search-active' : 'mx-search-match'}
        data-match-index={matchIdx}
      >
        {text.slice(idx, idx + term.length)}
      </mark>
    );
    lastIdx = idx + term.length;
    searchStart = lastIdx;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

function renderLine(line: string, key: number, searchTerm?: string, activeMatchIdx?: number): React.ReactNode {
  const trimmed = line.trim();
  if (!trimmed) return <br key={key} />;

  const renderInline = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    const re = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(text))) {
      if (m.index > lastIdx) {
        parts.push(...highlightSearch(text.slice(lastIdx, m.index), searchTerm || '', activeMatchIdx ?? -1));
      }
      parts.push(<code key={`c${idx++}`}>{...highlightSearch(m[1], searchTerm || '', activeMatchIdx ?? -1)}</code>);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
      parts.push(...highlightSearch(text.slice(lastIdx), searchTerm || '', activeMatchIdx ?? -1));
    }
    return parts;
  };

  if (trimmed.startsWith('### ')) {
    const text = trimmed.slice(4);
    const slug = slugify(text);
    return <h3 key={key} style={{ cursor: _sectionHoverCallback ? 'pointer' : undefined }}
      onMouseEnter={() => _sectionHoverCallback?.(slug)}
      onMouseLeave={() => _sectionHoverCallback?.(null)}
    >{renderInline(text)}</h3>;
  }
  if (trimmed.startsWith('## ')) {
    const text = trimmed.slice(3);
    const slug = slugify(text);
    return <h2 key={key} style={{ cursor: _sectionHoverCallback ? 'pointer' : undefined }}
      onMouseEnter={() => _sectionHoverCallback?.(slug)}
      onMouseLeave={() => _sectionHoverCallback?.(null)}
    >{renderInline(text)}</h2>;
  }
  if (trimmed.startsWith('# ')) return <h1 key={key}>{renderInline(trimmed.slice(2))}</h1>;
  if (trimmed.startsWith('- ')) return <li key={key}>{renderInline(trimmed.slice(2))}</li>;
  return <p key={key}>{renderInline(trimmed)}</p>;
}

/** Count total search matches in content (for parent component) */
export function countMatches(content: string, term: string): number {
  if (!term) return 0;
  const lower = content.toLowerCase();
  const termLower = term.toLowerCase();
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(termLower, pos);
    if (idx === -1) break;
    count++;
    pos = idx + term.length;
  }
  return count;
}

export function Markdown({ content, diffAgainst, searchTerm, activeMatchIndex, onSectionHover }: Props) {
  _matchCounter = 0;
  _sectionHoverCallback = onSectionHover || null;

  const lines = diffLines(content, diffAgainst);

  const blocks: React.ReactNode[] = [];
  let listBuffer: { node: React.ReactNode; status: Line['status'] }[] = [];
  let codeBuffer: string[] | null = null;  // null = not in code block
  let codeLanguage = '';
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={`ul${key++}`}>
        {listBuffer.map((item, i) => (
          <span key={i} className={item.status === 'added' ? 'add' : item.status === 'removed' ? 'del' : ''}>
            {item.node}
          </span>
        ))}
      </ul>
    );
    listBuffer = [];
  };

  const flushCode = () => {
    if (codeBuffer === null) return;
    blocks.push(
      <pre key={`pre${key++}`} className="mx-md-pre" data-lang={codeLanguage || undefined}>
        <code>{codeBuffer.join('\n')}</code>
      </pre>
    );
    codeBuffer = null;
    codeLanguage = '';
  };

  // Code-fence aware line iteration. A line whose trimmed text starts with
  // ``` opens (or closes) a fenced block. Everything between is preserved
  // verbatim as a single <pre><code> element so ASCII diagrams, indented
  // code, and table-like layouts render with their spacing intact instead
  // of being shredded into one <p> per line.
  const FENCE_RE = /^```(\S*)\s*$/;

  lines.forEach((line, i) => {
    const raw = line.text;
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(FENCE_RE);

    if (codeBuffer !== null) {
      // Inside a fenced block.
      if (fenceMatch) {
        flushCode();
      } else {
        codeBuffer.push(raw);
      }
      return;
    }

    if (fenceMatch) {
      // Opening a new fenced block.
      flushList();
      codeBuffer = [];
      codeLanguage = fenceMatch[1] || '';
      return;
    }

    if (trimmed.startsWith('- ')) {
      listBuffer.push({
        node: renderLine(raw, i, searchTerm, activeMatchIndex),
        status: line.status,
      });
    } else {
      flushList();
      const node = renderLine(raw, i, searchTerm, activeMatchIndex);
      if (node) {
        if (line.status === 'unchanged' || !trimmed) {
          blocks.push(node);
        } else {
          blocks.push(
            <span key={`d${key++}`} className={line.status === 'added' ? 'add' : 'del'}>
              {node}
            </span>
          );
        }
      }
    }
  });
  // An unclosed code fence at EOF still flushes — better to render the
  // collected lines as code than to silently drop them.
  flushCode();
  flushList();

  return <div className="mx-md">{blocks}</div>;
}
