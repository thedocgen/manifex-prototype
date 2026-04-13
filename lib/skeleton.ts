// Skeleton-preview generator. Produces a wireframe HTML document from a
// manifest state — purely TypeScript, no LLM call. The point is to give
// the user something to look at the instant they click Build, instead of
// staring at a "Building your app…" spinner for 60-240 seconds.
//
// The wireframe is intentionally crude: grey boxes with section titles
// pulled from the docs, a few component placeholders inferred from
// keywords in the content. Replaced with the real compiled HTML when
// the LLM compile finishes.

import type { ManifestState } from './types';

interface ParsedSection {
  title: string;
  blocks: ParsedBlock[];
}

type ParsedBlock =
  | { kind: 'nav'; items: string[] }
  | { kind: 'hero'; headline: string; subhead?: string }
  | { kind: 'form'; fields: string[] }
  | { kind: 'cards'; count: number; label: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'button'; label: string }
  | { kind: 'text'; lines: number };

const PAGES_LAYOUT_KEYS = ['pages-and-layout', 'pages_and_layout', 'pages_layout', 'pages-layout', 'ui-specifications', 'ui-specs'];
const OVERVIEW_KEYS = ['overview'];

/** Find the "Pages and Layout" content if present, falling back to Overview. */
function pickStructuralPage(state: ManifestState): { title: string; content: string } | null {
  for (const k of PAGES_LAYOUT_KEYS) {
    if (state.pages[k]?.content) return state.pages[k];
  }
  for (const k of OVERVIEW_KEYS) {
    if (state.pages[k]?.content) return state.pages[k];
  }
  // Last resort: any page that exists
  const first = Object.values(state.pages)[0];
  return first || null;
}

/** Pull H1/H2 from the Overview page for the page title and tagline. */
function pickAppTitle(state: ManifestState): { title: string; tagline: string } {
  const overview = state.pages['overview']?.content || '';
  const h1 = overview.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || 'Your App';
  // First non-empty paragraph after the H1.
  const afterH1 = overview.split(/^#\s+.+$/m)[1] || '';
  const firstPara = afterH1
    .split('\n\n')
    .map(s => s.trim())
    .find(s => s && !s.startsWith('#') && !s.startsWith('-'));
  const tagline = firstPara ? firstPara.replace(/[*_`]/g, '').slice(0, 140) : '';
  return { title: h1 === 'New Project' ? 'Your App' : h1, tagline };
}

/** Parse Pages and Layout content into rough page sections + blocks. */
function parseSections(content: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  const lines = content.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    // H2 = new section
    if (/^##\s+/.test(line)) {
      if (current) sections.push(current);
      current = { title: line.replace(/^##\s+/, '').replace(/[*_`]/g, '').trim(), blocks: [] };
      continue;
    }
    if (!current) continue;
    if (!line) continue;
    // Bullet lines become block hints
    if (/^[-*]\s+/.test(line)) {
      const item = line.replace(/^[-*]\s+/, '').replace(/[*_`]/g, '').trim();
      classifyAndAdd(current, item);
    }
  }
  if (current) sections.push(current);
  // If no H2 sections were found, treat the whole content as one section.
  if (sections.length === 0 && content.trim()) {
    const fallback: ParsedSection = { title: 'Page', blocks: [] };
    for (const raw of lines) {
      const line = raw.trim();
      if (/^[-*]\s+/.test(line)) {
        const item = line.replace(/^[-*]\s+/, '').replace(/[*_`]/g, '').trim();
        classifyAndAdd(fallback, item);
      }
    }
    if (fallback.blocks.length > 0) sections.push(fallback);
  }
  return sections;
}

function classifyAndAdd(section: ParsedSection, item: string): void {
  const lower = item.toLowerCase();
  // Navigation
  if (/\b(nav|navigation|sidebar|menu|tabs|header)\b/.test(lower)) {
    const navItems = item.split(/[,;|]|\band\b/).map(s => s.trim()).filter(s => s && s.length < 40).slice(0, 6);
    section.blocks.push({ kind: 'nav', items: navItems.length > 1 ? navItems : ['Home', 'About', 'Contact'] });
    return;
  }
  // Hero
  if (/\b(hero|landing|banner|headline|tagline|cta|call to action)\b/.test(lower)) {
    section.blocks.push({ kind: 'hero', headline: item.slice(0, 60) });
    return;
  }
  // Form
  if (/\b(form|input|field|textbox|sign up|sign in|login|register|submit|email|password)\b/.test(lower)) {
    const fields: string[] = [];
    if (/email/.test(lower)) fields.push('Email');
    if (/password/.test(lower)) fields.push('Password');
    if (/name/.test(lower)) fields.push('Name');
    if (fields.length === 0) fields.push('Field 1', 'Field 2');
    section.blocks.push({ kind: 'form', fields });
    return;
  }
  // Cards/grid
  if (/\b(card|grid|tile|gallery|catalog|product|item|recipe|entry|post)\b/.test(lower)) {
    const m = lower.match(/(\d+)\s+(card|tile|item|entry|product)/);
    const count = m ? Math.min(parseInt(m[1], 10), 8) : 6;
    section.blocks.push({ kind: 'cards', count, label: item.slice(0, 40) });
    return;
  }
  // List
  if (/\b(list|items|entries|results)\b/.test(lower)) {
    const items: string[] = [];
    for (let i = 0; i < 4; i++) items.push(`${item.split(' ').slice(0, 3).join(' ')} ${i + 1}`);
    section.blocks.push({ kind: 'list', items });
    return;
  }
  // Button
  if (/\b(button|action|click)\b/.test(lower)) {
    section.blocks.push({ kind: 'button', label: item.slice(0, 30) });
    return;
  }
  // Default: text block
  section.blocks.push({ kind: 'text', lines: 2 });
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ESC[c]);
}

function renderBlock(b: ParsedBlock): string {
  switch (b.kind) {
    case 'nav':
      return `<nav class="sk-nav">${b.items.map(i => `<span class="sk-nav-item">${esc(i)}</span>`).join('')}</nav>`;
    case 'hero':
      return `<div class="sk-hero">
        <div class="sk-hero-head">${esc(b.headline)}</div>
        <div class="sk-hero-sub"></div>
        <div class="sk-hero-sub" style="width:60%"></div>
        <div class="sk-hero-cta"></div>
      </div>`;
    case 'form':
      return `<div class="sk-form">
        ${b.fields.map(f => `<label class="sk-label">${esc(f)}<div class="sk-input"></div></label>`).join('')}
        <div class="sk-cta"></div>
      </div>`;
    case 'cards': {
      const cards = Array.from({ length: b.count }, () => `<div class="sk-card"><div class="sk-card-img"></div><div class="sk-card-line"></div><div class="sk-card-line" style="width:60%"></div></div>`).join('');
      return `<div class="sk-cards-label">${esc(b.label)}</div><div class="sk-cards">${cards}</div>`;
    }
    case 'list':
      return `<ul class="sk-list">${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'button':
      return `<button class="sk-btn">${esc(b.label)}</button>`;
    case 'text':
      return `<div class="sk-text"><div class="sk-line"></div><div class="sk-line" style="width:90%"></div></div>`;
  }
}

function renderSection(s: ParsedSection): string {
  return `<section class="sk-section">
    <h2 class="sk-section-title">${esc(s.title)}</h2>
    ${s.blocks.map(renderBlock).join('')}
  </section>`;
}

const SKELETON_CSS = `
  :root {
    --sk-bg: #f8fafc;
    --sk-card: #ffffff;
    --sk-border: #e2e8f0;
    --sk-skel: #e5e7eb;
    --sk-skel-strong: #cbd5e1;
    --sk-text: #334155;
    --sk-text-dim: #94a3b8;
    --sk-accent: #3b82f6;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; background: var(--sk-bg); color: var(--sk-text); }
  body { padding: 0; min-height: 100vh; }
  .sk-banner { background: linear-gradient(135deg, #eff6ff, #f1f5f9); border-bottom: 1px solid var(--sk-border); padding: 10px 24px; font-size: 12px; color: var(--sk-text-dim); display: flex; align-items: center; gap: 10px; }
  .sk-banner .sk-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sk-accent); box-shadow: 0 0 0 0 rgba(59,130,246,0.6); animation: skPulse 1.6s ease-out infinite; }
  @keyframes skPulse { 0% { box-shadow: 0 0 0 0 rgba(59,130,246,0.6); } 70% { box-shadow: 0 0 0 8px rgba(59,130,246,0); } 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); } }
  @keyframes skShimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
  .sk-skel, .sk-input, .sk-card-img, .sk-card-line, .sk-line, .sk-hero-sub, .sk-hero-cta, .sk-cta {
    background: linear-gradient(90deg, var(--sk-skel) 0%, #f1f5f9 50%, var(--sk-skel) 100%);
    background-size: 800px 100%;
    animation: skShimmer 1.6s linear infinite;
    border-radius: 6px;
  }
  .sk-app-header { padding: 20px 32px; border-bottom: 1px solid var(--sk-border); background: #fff; display: flex; align-items: center; justify-content: space-between; }
  .sk-app-title { font-size: 20px; font-weight: 600; color: var(--sk-text); }
  .sk-app-tagline { font-size: 13px; color: var(--sk-text-dim); margin-top: 2px; }
  .sk-content { max-width: 1100px; margin: 0 auto; padding: 32px 24px; display: flex; flex-direction: column; gap: 32px; }
  .sk-section { background: var(--sk-card); border: 1px solid var(--sk-border); border-radius: 10px; padding: 20px 24px; }
  .sk-section-title { margin: 0 0 16px; font-size: 14px; font-weight: 600; color: var(--sk-text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .sk-nav { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .sk-nav-item { padding: 6px 12px; border-radius: 6px; background: var(--sk-skel); color: var(--sk-text-dim); font-size: 12px; }
  .sk-hero { padding: 16px 0; }
  .sk-hero-head { font-size: 22px; font-weight: 600; color: var(--sk-text); margin-bottom: 12px; }
  .sk-hero-sub { height: 12px; width: 80%; margin-bottom: 8px; }
  .sk-hero-cta { height: 36px; width: 140px; margin-top: 14px; background: linear-gradient(90deg, var(--sk-accent) 0%, #60a5fa 50%, var(--sk-accent) 100%); }
  .sk-form { display: flex; flex-direction: column; gap: 12px; max-width: 360px; }
  .sk-label { font-size: 12px; color: var(--sk-text-dim); display: flex; flex-direction: column; gap: 6px; }
  .sk-input { height: 36px; }
  .sk-cta { height: 38px; width: 140px; background: linear-gradient(90deg, var(--sk-accent) 0%, #60a5fa 50%, var(--sk-accent) 100%); margin-top: 4px; }
  .sk-cards-label { font-size: 12px; color: var(--sk-text-dim); margin-bottom: 10px; }
  .sk-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
  .sk-card { background: #fff; border: 1px solid var(--sk-border); border-radius: 8px; padding: 12px; }
  .sk-card-img { height: 100px; margin-bottom: 10px; }
  .sk-card-line { height: 10px; margin-bottom: 6px; }
  .sk-list { list-style: none; padding: 0; margin: 0; }
  .sk-list li { padding: 12px 14px; background: #f1f5f9; border-radius: 6px; margin-bottom: 8px; color: var(--sk-text-dim); font-size: 13px; }
  .sk-btn { padding: 8px 16px; background: var(--sk-skel); border: 1px solid var(--sk-border); border-radius: 6px; color: var(--sk-text-dim); font-size: 13px; cursor: default; }
  .sk-text { padding: 8px 0; }
  .sk-line { height: 10px; width: 100%; margin-bottom: 8px; }
`;

export function generateSkeletonHtml(state: ManifestState): string {
  const { title, tagline } = pickAppTitle(state);
  const structural = pickStructuralPage(state);
  const sections = structural ? parseSections(structural.content) : [];

  // Always include at least one default section so the wireframe isn't empty.
  if (sections.length === 0) {
    sections.push({
      title: 'Main view',
      blocks: [
        { kind: 'hero', headline: title },
        { kind: 'cards', count: 6, label: 'Items' },
      ],
    });
  }

  const body = `
    <div class="sk-banner"><span class="sk-dot"></span>Building your app… showing a preview while the compiler works</div>
    <header class="sk-app-header">
      <div>
        <div class="sk-app-title">${esc(title)}</div>
        ${tagline ? `<div class="sk-app-tagline">${esc(tagline)}</div>` : ''}
      </div>
    </header>
    <main class="sk-content">
      ${sections.map(renderSection).join('')}
    </main>
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${SKELETON_CSS}</style></head><body>${body}</body></html>`;
}
