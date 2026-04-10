// Tiny markdown renderer for Manifex.
// Supports: # h1, ## h2, ### h3, paragraphs, - lists, `inline code`.
// Optional `diff` mode highlights added/removed lines via line-level comparison.

interface Props {
  content: string;
  diffAgainst?: string | null; // if provided, lines added vs this base are highlighted
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

  // Append removed lines from base that aren't in current (shown at the bottom for context)
  // Skip — keeps diff cleaner. Could be enhanced later.
  void currentSet;

  return result;
}

function renderLine(line: string, key: number): React.ReactNode {
  const trimmed = line.trim();
  if (!trimmed) return <br key={key} />;

  // Inline code
  const renderInline = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    const re = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(text))) {
      if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
      parts.push(<code key={`c${idx++}`}>{m[1]}</code>);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) parts.push(text.slice(lastIdx));
    return parts;
  };

  if (trimmed.startsWith('### ')) return <h3 key={key}>{renderInline(trimmed.slice(4))}</h3>;
  if (trimmed.startsWith('## ')) return <h2 key={key}>{renderInline(trimmed.slice(3))}</h2>;
  if (trimmed.startsWith('# ')) return <h1 key={key}>{renderInline(trimmed.slice(2))}</h1>;
  if (trimmed.startsWith('- ')) return <li key={key}>{renderInline(trimmed.slice(2))}</li>;
  return <p key={key}>{renderInline(trimmed)}</p>;
}

export function Markdown({ content, diffAgainst }: Props) {
  const lines = diffLines(content, diffAgainst);

  // Group consecutive list items into <ul> blocks
  const blocks: React.ReactNode[] = [];
  let listBuffer: { node: React.ReactNode; status: Line['status'] }[] = [];
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

  lines.forEach((line, i) => {
    const trimmed = line.text.trim();
    if (trimmed.startsWith('- ')) {
      listBuffer.push({ node: renderLine(line.text, i), status: line.status });
    } else {
      flushList();
      const node = renderLine(line.text, i);
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
  flushList();

  return <div className="mx-md">{blocks}</div>;
}
