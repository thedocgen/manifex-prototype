// LLM compiler service for Manifex.
// Multi-page document editing + conversational prompt handling.

import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from './crypto';
import type { CompiledCodex, ManifestState, DocPage, TreeNode, Question, ConversationMessage } from './types';
import { serializePages } from './types';

const COMPILER_VERSION = 'manifex-claude-sonnet-4-v3';
const MODEL = 'claude-sonnet-4-5-20250929';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

// ── Multi-page edit with conversational support ──

const EDIT_SYSTEM = `You are Manifex, a friendly AI that builds web apps from documentation.
The documentation is organized as multiple pages covering both product specs and technical architecture.
The documentation is canonical: every aspect of the app is defined through these docs.

You will receive ALL CURRENT PAGES and a USER REQUEST. You have two tools:

1. **update_docs** — Use this when you're confident about what to build. Return the complete updated page collection.
2. **ask_user** — Use this ONLY when the request is genuinely ambiguous and the answer would meaningfully change what gets built. Most prompts should just work without questions.

BIAS TOWARD ACTION. Only ask when:
- The user requests an external service and you need credentials (Supabase, Stripe, etc.)
- The request is ambiguous in a way that would produce very different results ("add a database" — which one?)
- The user needs to make a design choice that you can't infer

NEVER ask about:
- Implementation details you can decide (naming, file structure, component breakdown)
- Things with obvious defaults (use vanilla JS unless told otherwise)
- Confirmation of what you're about to do (just do it)

When asking about external services, be a patient guide. Non-technical users shouldn't need to know what an API key is. Walk them through setup step by step in plain language.

When using update_docs:
- Return ALL pages, not just changed ones. Unchanged pages must be included as-is.
- If this is the FIRST REAL PROMPT (only a basic "Overview" page exists), scaffold a complete doc structure using plain-language page names that non-developers can understand:
  - "Overview" — what the app does
  - "How It Works" (not "Architecture") — technical approach, framework, patterns
  - "Pages and Layout" (not "UI Specifications") — what each page/section contains
  - "Look and Feel" (not "Styles") — colors, fonts, spacing, visual design
  - Plus domain-specific pages as needed (e.g. "Data and Storage", "User Accounts")
- Technical pages document real decisions. Product pages describe what the app does.
- Page paths use lowercase with hyphens. Each page's content is markdown starting with a heading.
- changed_pages lists paths of modified/created/removed pages.
- diff_summary is a brief user-friendly sentence about what changed.

STYLES PAGE must be prescriptive and specific (the compiler follows it literally):
- Specify exact hex colors for primary, background, text, accent, border, success, danger
- Specify font family (default: Inter via Google Fonts, fallback to system-ui)
- Specify heading sizes and weights (e.g. "h1: text-4xl font-bold tracking-tight")
- Specify card style (e.g. "bg-white rounded-xl shadow-sm border border-slate-200 p-6")
- Specify spacing conventions (section padding, content max-width)
- Specify button styles for primary, secondary, danger variants
- The quality bar is Stripe/Linear/Notion — professional, polished, intentional.

ARCHITECTURE PAGE must specify:
- Framework: Tailwind CSS via CDN for styling (always)
- Component patterns and naming
- Navigation approach: sidebar, top nav, or tabs as appropriate
- Data storage approach

If an image is provided alongside the request, use it as a visual reference. Analyze the layout, colors, typography, components, and overall design shown in the image. Update the documentation pages (especially Styles and UI Specs) to match the visual design shown. If no text prompt accompanies the image, describe what you see and create documentation to replicate it.`;

const TREE_NODE_SCHEMA = {
  type: 'object' as const,
  properties: {
    path: { type: 'string' as const, description: 'Page path identifier' },
    title: { type: 'string' as const, description: 'Display title for sidebar' },
    children: {
      type: 'array' as const,
      description: 'Child pages (optional)',
      items: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const },
          title: { type: 'string' as const },
        },
        required: ['path' as const, 'title' as const],
      },
    },
  },
  required: ['path' as const, 'title' as const],
};

const UPDATE_DOCS_TOOL = {
  name: 'update_docs',
  description: 'Update the documentation when confident about what to build.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pages: {
        type: 'object' as const,
        description: 'Complete map of page path to { title, content }. Must include ALL pages.',
        additionalProperties: {
          type: 'object' as const,
          properties: {
            title: { type: 'string' as const, description: 'Page title' },
            content: { type: 'string' as const, description: 'Full markdown content' },
          },
          required: ['title' as const, 'content' as const],
        },
      },
      tree: {
        type: 'array' as const,
        description: 'Sidebar navigation tree',
        items: TREE_NODE_SCHEMA,
      },
      diff_summary: { type: 'string' as const, description: 'Brief user-friendly summary of changes' },
      changed_pages: {
        type: 'array' as const,
        description: 'Paths of modified/created/deleted pages',
        items: { type: 'string' as const },
      },
    },
    required: ['pages' as const, 'tree' as const, 'diff_summary' as const, 'changed_pages' as const],
  },
};

const ASK_USER_TOOL = {
  name: 'ask_user',
  description: 'Ask clarifying questions when genuinely uncertain. Use sparingly — most prompts should just work.',
  input_schema: {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string' as const,
        description: 'Conversational response to the user. Be friendly, concise, and helpful.',
      },
      questions: {
        type: 'array' as const,
        description: 'Structured questions for the user to answer',
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'string' as const, description: 'Unique question identifier' },
            text: { type: 'string' as const, description: 'The question text' },
            type: {
              type: 'string' as const,
              enum: ['choice' as const, 'text' as const, 'secret' as const],
              description: 'choice = radio buttons, text = free text, secret = password input for API keys',
            },
            options: {
              type: 'array' as const,
              items: { type: 'string' as const },
              description: 'Options for choice-type questions',
            },
          },
          required: ['id' as const, 'text' as const, 'type' as const],
        },
      },
    },
    required: ['message' as const],
  },
};

// ── Return types ──

export interface EditResult {
  pages: { [path: string]: DocPage };
  tree: TreeNode[];
  diff_summary: string;
  changed_pages: string[];
}

export interface AskResult {
  message: string;
  questions?: Question[];
}

export type EditResponse =
  | { type: 'update'; result: EditResult }
  | { type: 'question'; result: AskResult };

export async function editManifest(
  currentState: ManifestState,
  prompt: string,
  options: {
    variation?: boolean;
    conversationContext?: ConversationMessage[];
    image?: { base64: string; media_type: string };
  } = {}
): Promise<EditResponse> {
  const serialized = serializePages(currentState);

  let userText = `CURRENT DOCUMENTATION PAGES:\n\n${serialized}\n\nCURRENT TREE STRUCTURE:\n${JSON.stringify(currentState.tree, null, 2)}\n\n---\n\n`;

  if (options.conversationContext && options.conversationContext.length > 0) {
    userText += 'RECENT CONVERSATION:\n';
    for (const msg of options.conversationContext) {
      userText += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
    }
    userText += '\n---\n\n';
  }

  userText += `USER REQUEST: ${prompt || '(see attached image)'}`;

  // Build message content — multimodal if image provided
  const messageContent: any[] = [];
  if (options.image) {
    messageContent.push({
      type: 'image',
      source: { type: 'base64', media_type: options.image.media_type, data: options.image.base64 },
    });
  }
  messageContent.push({ type: 'text', text: userText });

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: options.variation ? 0.9 : 0,
    system: EDIT_SYSTEM,
    tools: [UPDATE_DOCS_TOOL, ASK_USER_TOOL],
    messages: [{ role: 'user', content: messageContent }],
  });

  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    // Fallback: if the LLM returned text instead of a tool call, treat it as a question
    const textBlock = resp.content.find(b => b.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      return { type: 'question', result: { message: textBlock.text } };
    }
    throw new Error('LLM returned neither tool call nor text');
  }

  if (toolUse.name === 'ask_user') {
    const input = toolUse.input as { message?: string; questions?: any[] };
    const questions: Question[] = (input.questions || [])
      .filter((q: any) => q && q.id && q.text && q.type)
      .map((q: any) => ({
        id: q.id,
        text: q.text,
        type: q.type as 'choice' | 'text' | 'secret',
        options: q.options,
      }));

    return {
      type: 'question',
      result: {
        message: input.message || 'I have a question.',
        questions: questions.length > 0 ? questions : undefined,
      },
    };
  }

  if (toolUse.name === 'update_docs') {
    const input = toolUse.input as {
      pages?: { [path: string]: { title?: string; content?: string } };
      tree?: any[];
      diff_summary?: string;
      changed_pages?: string[];
    };

    if (!input.pages || typeof input.pages !== 'object') throw new Error('LLM returned no pages');
    if (!input.tree || !Array.isArray(input.tree)) throw new Error('LLM returned no tree');

    const pages: { [path: string]: DocPage } = {};
    for (const [path, page] of Object.entries(input.pages)) {
      if (page && typeof page.title === 'string' && typeof page.content === 'string') {
        pages[path] = { title: page.title, content: page.content };
      }
    }
    if (Object.keys(pages).length === 0) throw new Error('LLM returned empty pages');

    function validateTree(nodes: any[]): TreeNode[] {
      return nodes
        .filter((n: any) => n && typeof n.path === 'string' && typeof n.title === 'string')
        .map((n: any) => {
          const node: TreeNode = { path: n.path, title: n.title };
          if (n.children && Array.isArray(n.children) && n.children.length > 0) {
            node.children = validateTree(n.children);
          }
          return node;
        });
    }

    return {
      type: 'update',
      result: {
        pages,
        tree: validateTree(input.tree),
        diff_summary: input.diff_summary || `Edit: ${prompt.slice(0, 60)}`,
        changed_pages: Array.isArray(input.changed_pages) ? input.changed_pages : [],
      },
    };
  }

  throw new Error(`Unknown tool: ${toolUse.name}`);
}

// ── Compiler (unchanged from R3) ──

function buildCompilerSystem(state: ManifestState, secrets?: { [key: string]: string }): string {
  const archPage = state.pages['architecture'] || state.pages['tech'] || state.pages['technical'];
  let frameworkHint = 'vanilla JavaScript (no frameworks, no build step, no imports)';

  if (archPage) {
    const content = archPage.content.toLowerCase();
    if (content.includes('react')) frameworkHint = 'React (loaded via CDN script tags, no build step, use React.createElement or htm tagged templates)';
    else if (content.includes('vue')) frameworkHint = 'Vue 3 (loaded via CDN script tag, use Options API or Composition API with setup())';
    else if (content.includes('svelte')) frameworkHint = 'vanilla JavaScript that mimics Svelte-like reactivity patterns (no build step available)';
    else if (content.includes('alpine')) frameworkHint = 'Alpine.js (loaded via CDN script tag)';
    else if (content.includes('jquery')) frameworkHint = 'jQuery (loaded via CDN script tag)';
  }

  let secretsSection = '';
  if (secrets && Object.keys(secrets).length > 0) {
    secretsSection = `\n\nSECRETS AVAILABLE (inject these values directly into the code):
${Object.entries(secrets).map(([k, v]) => `- ${k}: "${v}"`).join('\n')}`;
  }

  return `You are a professional-grade compiler from multi-page documentation to runnable web code.
You will receive a complete documentation collection describing a web app. Compile it into a polished, production-quality single-page web app with three files.

Output format (STRICT — use the emit_codex tool):
Return exactly three string fields: index_html, styles_css, app_js.

DESIGN SYSTEM — Tailwind CSS (MANDATORY):
- index.html MUST include <script src="https://cdn.tailwindcss.com"></script> in the <head>
- index.html MUST include <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
- Use Tailwind utility classes for ALL layout, spacing, typography, and color
- styles.css is ONLY for: Tailwind config overrides, custom animations, and styles Tailwind cannot express
- Follow the Styles documentation page closely for colors, typography, and spacing

QUALITY BAR (Stripe / Linear / Notion level):
- Typography: Inter font. Clear hierarchy — large bold headings (text-3xl/4xl font-bold tracking-tight), medium subheadings (text-xl font-semibold), regular body (text-base leading-relaxed text-slate-700). Generous line height.
- Spacing: Never cramped. Sections separated by py-12 to py-20. Content max-w-7xl mx-auto px-4 sm:px-6 lg:px-8. Cards with p-6. Consistent use of Tailwind spacing scale.
- Colors: Cohesive palette from the Styles page. Default to slate for neutrals. One accent color. Backgrounds alternate between white and slate-50 for section separation.
- Cards: bg-white rounded-xl shadow-sm border border-slate-200. Hover: shadow-md transition-shadow duration-200. Never flat unstyled divs.
- Buttons: rounded-lg px-4 py-2.5 font-medium. Primary: bg-{accent} text-white hover:bg-{accent-dark}. Secondary: bg-white border border-slate-300. Transitions on all interactive elements.
- Forms: Proper labels (text-sm font-medium text-slate-700), inputs (rounded-lg border-slate-300 focus:ring-2 focus:ring-{accent}), validation states.
- Empty states: Never blank. Show helpful text, subtle icons, or sample data.
- Responsive: Mobile-first. Use sm:, md:, lg: breakpoints. Stack on mobile, multi-column on desktop. Test mentally at 375px and 1440px.

MULTI-SECTION NAVIGATION:
- If the app has 3+ logical sections, implement client-side navigation:
  - Use a fixed top navbar with logo/title and nav links, OR a sidebar for dashboard-style apps
  - Sections switch via JavaScript show/hide with hash-based routing
  - Active nav link should be visually distinct (border-bottom or bg highlight)
  - Smooth transitions between sections (opacity fade)
  - Mobile: collapse nav to a hamburger menu
- Simple single-purpose apps (calculator, single form) do NOT need navigation — use judgment.

CONTENT QUALITY:
- Generate real, contextual placeholder content appropriate for the app type
- Never use "Lorem ipsum" or generic placeholders
- Use realistic sample data (names, dates, descriptions that fit the domain)
- NEVER use emojis in generated output. Use SVG icons, simple Unicode symbols (arrows, bullets, dashes), or text labels instead. The output must be professional.

CODE RULES:
- Read ALL documentation pages to understand the full app spec
- Technical pages (Architecture, Data Model) define HOW to build. Follow their decisions.
- Product pages (Overview, UI Specs, Styles) define WHAT to build.
- Use ${frameworkHint} for application logic.
- index.html: complete HTML5 document with Tailwind CDN, Inter font, and references to styles.css and app.js
- styles.css: minimal — only Tailwind config and custom animations
- app.js: clean, well-organized JavaScript
- Be deterministic: identical input should produce equivalent output
- Annotate major HTML elements with data-doc-page and data-doc-section attributes mapping to the documentation page describing them. Use lowercase hyphenated slugs.${secretsSection}`;
}

export async function compileManifestToCodex(
  state: ManifestState,
  secrets?: { [key: string]: string }
): Promise<CompiledCodex> {
  const serialized = serializePages(state);
  const systemPrompt = buildCompilerSystem(state, secrets);

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: 0,
    system: systemPrompt,
    tools: [
      {
        name: 'emit_codex',
        description: 'Emit the compiled codex as three files.',
        input_schema: {
          type: 'object' as const,
          properties: {
            index_html: { type: 'string' as const, description: 'Complete HTML5 document.' },
            styles_css: { type: 'string' as const, description: 'CSS for the app.' },
            app_js: { type: 'string' as const, description: 'Application JavaScript.' },
          },
          required: ['index_html' as const, 'styles_css' as const, 'app_js' as const],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'emit_codex' },
    messages: [
      { role: 'user', content: `DOCUMENTATION PAGES:\n\n${serialized}\n\nCompile this into a working web app. Call the emit_codex tool with the three files.` },
    ],
  });

  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error('LLM did not call emit_codex');

  const input = toolUse.input as { index_html?: string; styles_css?: string; app_js?: string };
  if (!input.index_html || !input.styles_css || !input.app_js) {
    throw new Error(`Compiler missing keys: ${Object.keys(input).join(', ')}`);
  }

  return {
    files: { 'index.html': input.index_html, 'styles.css': input.styles_css, 'app.js': input.app_js },
    codex_sha: sha256(JSON.stringify({ 'index.html': input.index_html, 'styles.css': input.styles_css, 'app.js': input.app_js })),
    compiler_version: COMPILER_VERSION,
  };
}
