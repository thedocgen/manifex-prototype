// Manifex → DocGen MonodrawAPI bridge (server-side).
// Spawns scripts/render_diagram.py and feeds it a JSON spec on stdin.
// Returns the rendered ASCII or a structured error.

import { spawn } from 'child_process';
import path from 'path';

export interface DiagramBox {
  id: string;
  text: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface DiagramLine {
  from: string;
  to: string;
  from_attach?: 'top' | 'bottom' | 'left' | 'right';
  to_attach?: 'top' | 'bottom' | 'left' | 'right';
  label?: string;
}

export interface DiagramSpec {
  boxes: DiagramBox[];
  lines?: DiagramLine[];
}

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'render_diagram.py');
const TIMEOUT_MS = 10000;

export function validateDiagramSpec(spec: any): { ok: true; spec: DiagramSpec } | { ok: false; error: string } {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec must be an object' };
  if (!Array.isArray(spec.boxes)) return { ok: false, error: 'spec.boxes must be an array' };
  if (spec.boxes.length === 0) return { ok: false, error: 'spec.boxes must not be empty' };
  if (spec.boxes.length > 30) return { ok: false, error: 'too many boxes (max 30)' };
  const ids = new Set<string>();
  for (const b of spec.boxes) {
    if (!b || typeof b.id !== 'string') return { ok: false, error: 'each box needs a string id' };
    if (ids.has(b.id)) return { ok: false, error: `duplicate box id: ${b.id}` };
    ids.add(b.id);
    for (const k of ['col', 'row', 'w', 'h'] as const) {
      if (typeof b[k] !== 'number' || b[k] < 0) return { ok: false, error: `box ${b.id}.${k} must be a non-negative number` };
    }
  }
  if (spec.lines) {
    if (!Array.isArray(spec.lines)) return { ok: false, error: 'spec.lines must be an array' };
    for (const l of spec.lines) {
      if (!ids.has(l.from)) return { ok: false, error: `line.from references unknown box: ${l.from}` };
      if (!ids.has(l.to)) return { ok: false, error: `line.to references unknown box: ${l.to}` };
    }
  }
  return { ok: true, spec };
}

export function renderDiagramSpec(specJson: string): Promise<{ ok: true; ascii: string } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const proc = spawn('python3', [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve({ ok: false, error: 'render timeout' }); }, TIMEOUT_MS);
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: `spawn failed: ${e.message}` }); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, ascii: stdout });
      else resolve({ ok: false, error: stderr.trim() || `exit ${code}` });
    });
    proc.stdin.write(specJson);
    proc.stdin.end();
  });
}

// Marker post-processing: replace <!--DIAGRAM:{json}--> with rendered ASCII.
const DIAGRAM_MARKER_RE = /<!--DIAGRAM:(\{[\s\S]*?\})-->/g;

export async function renderDiagramMarkers(content: string): Promise<string> {
  if (!content.includes('<!--DIAGRAM:')) return content;
  const matches = Array.from(content.matchAll(DIAGRAM_MARKER_RE));
  let result = content;
  for (const m of matches) {
    const r = await renderDiagramSpec(m[1]);
    if (r.ok) {
      const fenced = '```text\n' + r.ascii.trimEnd() + '\n```';
      result = result.replace(m[0], fenced);
    } else {
      result = result.replace(m[0], `<!-- diagram render failed: ${r.error} -->`);
    }
  }
  return result;
}
