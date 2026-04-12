// LLM compiler service for Manifex.
// Multi-page document editing + conversational prompt handling.

import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from './crypto';
import type { CompiledCodex, ManifestState, DocPage, TreeNode, Question, ConversationMessage } from './types';
import { serializePages } from './types';

const COMPILER_VERSION = 'manifex-claude-sonnet-4-v2';
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
- If this is the FIRST REAL PROMPT (only a basic "Overview" page exists), scaffold a complete doc structure (Overview, Architecture, UI Specs, Styles, plus domain-specific pages).
- Technical pages document real decisions. Product pages describe what the app does.
- Page paths use lowercase with hyphens. Each page's content is markdown starting with a heading.
- changed_pages lists paths of modified/created/removed pages.
- diff_summary is a brief user-friendly sentence about what changed.`;

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
    conversationContext?: ConversationMessage[]; // recent exchanges for multi-turn
  } = {}
): Promise<EditResponse> {
  const serialized = serializePages(currentState);

  // Build the user message with optional conversation context
  let userContent = `CURRENT DOCUMENTATION PAGES:\n\n${serialized}\n\nCURRENT TREE STRUCTURE:\n${JSON.stringify(currentState.tree, null, 2)}\n\n---\n\n`;

  // Include recent conversation context for multi-turn flows
  if (options.conversationContext && options.conversationContext.length > 0) {
    userContent += 'RECENT CONVERSATION:\n';
    for (const msg of options.conversationContext) {
      userContent += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
    }
    userContent += '\n---\n\n';
  }

  userContent += `USER REQUEST: ${prompt}`;

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: options.variation ? 0.9 : 0,
    system: EDIT_SYSTEM,
    tools: [UPDATE_DOCS_TOOL, ASK_USER_TOOL],
    // Let the LLM choose which tool to call
    messages: [{ role: 'user', content: userContent }],
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

  return `You are a deterministic compiler from multi-page documentation to runnable web code.
You will receive a complete documentation collection describing a web app. Compile it into a single-page web app with three files.

Output format (STRICT — use the emit_codex tool):
Return exactly three string fields: index_html, styles_css, app_js.

Rules:
- Read ALL documentation pages to understand the full app spec.
- Technical pages (Architecture, Data Model, API Reference) define HOW to build. Follow their decisions.
- Product pages (Overview, UI Specs, Styles) define WHAT to build. Match their descriptions.
- Use ${frameworkHint} for the implementation.
- index.html: complete HTML5 document. Reference styles.css and app.js via <link> and <script>.
- styles.css: CSS for the app, following the Styles documentation.
- app.js: application logic following the Architecture and UI Specs documentation.
- Be deterministic: identical input should produce equivalent output.
- If documentation pages conflict, prefer the more specific page (e.g. UI Specs overrides Overview).${secretsSection}`;
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
