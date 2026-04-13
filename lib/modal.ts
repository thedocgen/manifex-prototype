// LLM compiler service for Manifex.
// Multi-page document editing + conversational prompt handling.

import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from './crypto';
import { renderDiagramMarkers } from './diagram';
import type { CodexFiles, CompiledCodex, ManifestState, DocPage, TreeNode, Question, ConversationMessage } from './types';
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
- Page paths use lowercase with hyphens. Each page's content is markdown starting with a heading.
- changed_pages lists paths of modified/created/removed pages.
- diff_summary is a brief user-friendly sentence about what changed.

FIRST PROMPT — PLANNING PHASE (mandatory for scaffolding):
If this is the FIRST REAL PROMPT (only a basic "Overview" page exists with generic starter content), DO NOT generate documentation immediately. Instead, use ask_user to run a planning phase:

1. Summarize what you understood from the user's request — be specific about features, audience, and scope
2. Propose the documentation structure you plan to create — list each page title with a one-line description of what it will cover
3. Ask: "Does this capture what you have in mind? Want to add, remove, or change anything before I start building the documentation?"

Only AFTER the user confirms (responds with approval, or adjusts and then approves), generate the full documentation using update_docs.

If the user's confirmation message references an earlier planning exchange in the RECENT CONVERSATION context, proceed with generating thorough documentation.

MULTI-TURN PLANNING — go deeper before building:
After the initial planning summary, if the user's reply opens up something important you don't know yet (a feature you can't infer the shape of, a workflow with branches, an integration whose details matter), it's OK to ask one more focused question via ask_user before generating. Examples of when to ask again:
- The user says "yes but also support recurring bookings" → ask: "Should recurring bookings repeat by date pattern (every Monday) or by interval (every 2 weeks)? And can a user cancel a single occurrence vs the whole series?"
- The user says "looks great, add user accounts" → ask: "Email/password, magic link, or a third-party OAuth like Google? And what does each user own — just their own data, or can they share with others?"

Each follow-up should:
- Be ONE question (or one cluster of tightly related sub-questions) — not a survey
- Reference what the user just said, so it's clear you're listening
- Stop after at most 2-3 rounds total. Don't interrogate. The goal is to fill the highest-leverage gap, not to exhaust every detail.

If the answer to your follow-up is unambiguous or the user signals impatience ("just build it", "you decide"), generate the docs immediately with sensible defaults.

DOCUMENTATION GENERATION — thorough technical manual, not summaries:
When generating docs (after planning confirmation, or for follow-up prompts on an existing project), create detailed documentation. Use plain-language page names:

**"Overview"** page must include:
- What the app does and who it's for
- Key features as a detailed list
- User journey flowchart as an ASCII diagram showing the step-by-step flow a user takes through the app, e.g.:
  [Landing Page] --> [Sign Up / Log In]
        |                  |
        v                  v
  [Browse Items]    [Dashboard]
        |                  |
        v                  v
  [View Details]   [Create New]
        |                  |
        v                  v
  [Add to Cart]    [Edit / Delete]
        |
        v
  [Checkout]

**"How It Works"** page (not "Architecture") must include:
- Technology choices: Tailwind CSS via CDN (always), vanilla JS or specified framework
- Architecture flowchart as an ASCII diagram showing how the major pieces connect, e.g.:
  ┌──────────┐     ┌──────────────┐     ┌─────────────┐
  │  UI Layer │────>│ App Logic    │────>│ Data Store  │
  │ (HTML/CSS)│<────│ (app.js)     │<────│ (localStorage│
  └──────────┘     └──────────────┘     └─────────────┘
        │                 │
        v                 v
  ┌──────────┐     ┌──────────────┐
  │  Router   │     │  Event       │
  │ (hash nav)│     │  Handlers    │
  └──────────┘     └──────────────┘
- Component list with responsibilities
- Navigation approach (sidebar, top nav, tabs) with rationale
- State management approach

**"Pages and Layout"** page (not "UI Specifications") must include:
- Detailed description of every page/section in the app
- Layout structure for each page (what goes where, columns, sidebar vs main, header/footer)
- Interactive elements and their behavior (buttons, forms, modals, toggles)
- Component relationship diagram showing which components appear on which pages

**"Look and Feel"** page (not "Styles") must be prescriptive and compiler-ready:
- Exact hex colors for: primary, background, surface, text, text-muted, accent, border, success, warning, danger
- Font: Inter via Google Fonts, with specific sizes (h1: text-3xl font-bold tracking-tight, body: text-base leading-relaxed)
- Card style: specific Tailwind classes (e.g. bg-white rounded-lg shadow-sm border border-slate-200 p-6)
- Button styles: primary, secondary, danger with specific Tailwind classes
- Spacing: section padding, content max-width, grid gaps
- The quality bar is Stripe/Linear/Notion — professional, polished, intentional.

**"Data and Storage"** page (if the app stores data) must include:
- What data is stored and where (localStorage, IndexedDB, external API)
- Data model diagram as ASCII showing entities and relationships, e.g.:
  ┌──────────────┐       ┌──────────────┐
  │    Recipe     │       │   Category   │
  ├──────────────┤       ├──────────────┤
  │ id           │       │ id           │
  │ title        │───┐   │ name         │
  │ ingredients  │   │   │ color        │
  │ steps        │   │   └──────────────┘
  │ category_id  │───┘
  │ rating       │
  │ created_at   │
  └──────────────┘
- CRUD operations: what can be created, read, updated, deleted
- Data validation rules

**"Tests"** page must include:
- Plain-language descriptions of expected behaviors organized by feature area
- Each test group has: a descriptive heading, bullet points listing what should be true, and a "Run test" link
- Example test groups: Form Validation, Navigation, Visual Design, Data Operations
- Tests should verify that the compiled app matches what the documentation describes
- This page is auto-generated and fully mutable via prompts

Additional domain-specific pages as needed (e.g. "User Accounts", "Notifications", "Search and Filters").

RENDERED DIAGRAMS — prefer over hand-drawn ASCII when possible:
For the "How It Works" architecture diagram (and any other flowchart on any page where the relationships are clean), emit a special marker that Manifex will render via MonodrawAPI:

<!--DIAGRAM:{"boxes":[...],"lines":[...]}-->

Spec format:
- boxes: array of { id, text, col, row, w, h }. col/row are character positions starting at 0. w/h are box dimensions in characters. Rectangles render with a 1-character border so a w=12 box holds 10 chars of text.
- lines: array of { from, from_attach, to, to_attach }. from/to are box ids. attach values are "top" | "bottom" | "left" | "right".
- Lay out boxes horizontally (col offsets 18 apart for w=14 boxes) for a left-to-right flow, vertically (row offsets 6 apart for h=3 boxes) for top-down. Leave 4-char gutters between boxes.
- The marker MUST be on its own line. Manifex post-processes the marker after generation, replacing it with the rendered ASCII art wrapped in a fenced code block.

Example for a 3-tier flow (UI → API → Database):
<!--DIAGRAM:{"boxes":[{"id":"ui","text":"UI Layer","col":0,"row":0,"w":14,"h":3},{"id":"api","text":"API","col":20,"row":0,"w":10,"h":3},{"id":"db","text":"Database","col":34,"row":0,"w":14,"h":3}],"lines":[{"from":"ui","from_attach":"right","to":"api","to_attach":"left"},{"from":"api","from_attach":"right","to":"db","to_attach":"left"}]}-->

Use rendered diagrams ONLY when the relationships are simple boxes-and-arrows. For complex layouts (data model entity diagrams with field lists, decision trees with many branches), fall back to the hand-drawn ASCII rules below.

ASCII DIAGRAM RULES (apply to every hand-drawn diagram on every page):
- Every diagram MUST be wrapped in a fenced \`\`\`text or \`\`\` code block so the markdown renderer treats it as preformatted text. Otherwise the alignment collapses.
- Use box-drawing characters (┌ ┐ └ ┘ │ ─ ├ ┤ ┬ ┴ ┼) consistently within a single diagram. Don't mix box characters with ASCII pipes (|) and dashes (-) in the same drawing.
- Arrows: use ──> ──► ◄── for horizontal flow, │ ▼ ▲ for vertical. Keep arrowheads on a single line.
- Pad columns so vertical lines actually line up — count characters, don't eyeball it.
- Keep diagrams under 80 columns wide so they fit in the docs panel without horizontal scroll.
- One diagram per concept. Do NOT cram an architecture diagram, data model, and user journey into one figure.
- If a relationship is too complex for ASCII, write it out in numbered prose instead of producing a broken diagram.

CALL OUT SCOPE EXPANSION — never silently add things the user didn't ask for:
If you add a feature, page, entity, or capability the user didn't explicitly request — even if it's a natural fit for the pattern — flag it in your diff_summary and (if scaffolding) in the Overview page. Use plain language like:

- "I added a comments feature because you mentioned reviews — let me know if you want to remove it."
- "I added an admin dashboard because the schedule needs to be managed somehow — happy to drop it if you'd rather start without one."
- "I added user profiles. You only mentioned login, but profiles felt necessary for the rest of the app to work — say the word and I'll cut them."

The point is honesty about expansion: the user should never read the docs and find unfamiliar territory. Two failure modes to avoid:
1. Silent additions that surprise the user later when they review the docs.
2. Refusing to add anything not explicitly requested — that produces useless skeletons. Add what you need, just announce it.

This callout goes in diff_summary on every update where you expanded scope, and in the Overview page (a brief "What I added on top of your request" note) on first scaffolds.

EXPLAIN THE WHY — every technical decision needs context:
The docs should teach the user about their own product, not just list specs. Whenever you make a technical or design choice, write one or two sentences immediately after explaining WHY this choice fits THIS user's situation. Reference the scale, audience, or constraint that made the choice obvious.

Examples:
- "We store recipes in browser localStorage. For a personal recipe collection with under a few hundred entries, this keeps the app simple — no server, no signup, your data stays on your machine."
- "We use email and password for sign-in instead of Google OAuth. Your readers are mostly non-technical home cooks, and a simple form is one less thing they need to figure out."
- "Cards have a 1px border and a soft shadow. This is the Stripe and Linear pattern — it gives content a clear container without feeling boxed in."

The "why" sentences should reference real characteristics of the app the user is building. Generic justifications ("for scalability", "for security") are banned — they're as bad as the corporate slop below.

WRITING STANDARDS — concrete, specific, no corporate slop:
Write like a thoughtful engineer explaining the app to another engineer. No marketing language. No hedging. Describe what the app *does*, not what it *enables*.

BANNED WORDS — never use these or their variants:
leverage, utilize, robust, seamless, innovative, cutting-edge, streamline, optimize, empower, synergy, paradigm, harness, unleash, transform, revolutionize, elevate, unlock, foster, facilitate, enable (as a filler verb), holistic, comprehensive solution, next-generation, state-of-the-art, best-in-class, world-class, end-to-end (as filler), turnkey, game-changing, disruptive, scalable (as filler), flexible (as filler).

Replace with concrete verbs: "use" not "leverage"; "use" not "utilize"; "works reliably" not "robust"; "smooth" or just describe the flow instead of "seamless"; "new" not "innovative/cutting-edge"; "simplify" or describe the specific steps removed instead of "streamline"; "make faster" or describe the specific change instead of "optimize"; "let" or "help" not "empower"; delete "synergy" entirely; name the approach, don't call it a "paradigm"; "use" not "harness".

BE SPECIFIC:
- Bad: "A seamless booking experience that empowers users to leverage our innovative platform."
- Good: "Students pick a class from the weekly grid, see how many spots are left, and pay with a card. Confirmations go out by email within a few seconds."

Every sentence should name a concrete thing (a button, a field, a file, a step, a user action). If a sentence could describe any generic SaaS app, delete it and write something specific to this app.

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
    forceUpdate?: boolean;
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

  // Build message content — multimodal if image or PDF provided
  const messageContent: any[] = [];
  if (options.image) {
    const isPdf = options.image.media_type === 'application/pdf';
    messageContent.push({
      type: isPdf ? 'document' : 'image',
      source: { type: 'base64', media_type: options.image.media_type, data: options.image.base64 },
    });
  }
  messageContent.push({ type: 'text', text: userText });

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: options.variation ? 0.9 : 0,
    system: EDIT_SYSTEM,
    tools: options.forceUpdate ? [UPDATE_DOCS_TOOL] : [UPDATE_DOCS_TOOL, ASK_USER_TOOL],
    tool_choice: options.forceUpdate
      ? { type: 'tool', name: 'update_docs' }
      : { type: 'any' },
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
        pages[path] = { title: page.title, content: await renderDiagramMarkers(page.content) };
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

TIME-BASED FEATURES (timers, countdowns, stopwatches, polling, animations):
- Per-second ticks MUST use setInterval(fn, 1000). Do NOT use sub-second intervals (100ms, 250ms, etc.) and decrement by 1 second per tick — that produces a timer that runs many times faster than real time. This is a recurring failure mode; do not repeat it.
- Drift-free timing: store a Date.now() baseline when the timer starts and compute remaining = totalMs - (Date.now() - startMs) on each tick. Pause/resume should adjust the baseline, not accumulate sub-tick drift.
- Stopping a timer: always clearInterval(id). Set the id back to null so subsequent starts don't leak intervals.
- Visibility: when document.hidden becomes true, setInterval throttles to ~1Hz minimum in most browsers — the Date.now() baseline approach above is robust to this. Do not assume tick count equals elapsed seconds.
- Sub-second updates are only correct if the spec explicitly asks for them (e.g. "milliseconds-precision stopwatch") AND the displayed value is computed from Date.now(), not decremented per tick.

CODE RULES:
- Read ALL documentation pages to understand the full app spec
- Technical pages (Architecture, Data Model) define HOW to build. Follow their decisions.
- Product pages (Overview, UI Specs, Styles) define WHAT to build.
- Use ${frameworkHint} for application logic.
- index.html: complete HTML5 document with Tailwind CDN, Inter font, and references to styles.css and app.js
- styles.css: minimal — only Tailwind config and custom animations
- app.js: clean, well-organized JavaScript
- Be deterministic: identical input should produce equivalent output
- Annotate major HTML elements with data-doc-page and data-doc-section attributes mapping to the documentation page describing them. Use lowercase hyphenated slugs.
- If a Tests documentation page exists, also generate tests_js: executable tests that validate the compiled app matches the docs. Format MUST be: declare window.__manifexTests as an array of { name: string, fn: () => void } objects. Each fn throws on failure. Provide a top-level helper "function assert(c, m) { if (!c) throw new Error(m); }" then push tests like: window.__manifexTests = [{ name: 'home button visible', fn: () => assert(document.querySelector('[data-doc-page=overview]'), 'overview missing') }, ...]. Tests should cover key DOM structure, content text, and visual presence claims from the Tests page. Do NOT use top-level await or DOM-not-ready code — assume document is fully loaded when tests run.${secretsSection}`;
}

export async function compileManifestToCodex(
  state: ManifestState,
  secrets?: { [key: string]: string }
): Promise<CompiledCodex> {
  const serialized = serializePages(state);
  const systemPrompt = buildCompilerSystem(state, secrets);

  const resp = await client().messages.create({
    model: MODEL,
    // 21000 stays under the SDK's non-streaming budget cap (above that,
    // the TS SDK refuses the request and demands streaming). Keeps
    // headroom for index.html + styles.css + app.js + optional tests.js.
    max_tokens: 21000,
    temperature: 0,
    system: systemPrompt,
    tools: [
      {
        name: 'emit_codex',
        description: 'Emit the compiled codex as three or four files.',
        input_schema: {
          type: 'object' as const,
          properties: {
            index_html: { type: 'string' as const, description: 'Complete HTML5 document.' },
            styles_css: { type: 'string' as const, description: 'CSS for the app.' },
            app_js: { type: 'string' as const, description: 'Application JavaScript.' },
            tests_js: { type: 'string' as const, description: 'JavaScript test functions that validate the compiled app matches the documentation. Each test checks DOM structure, content, or styling.' },
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

  const input = toolUse.input as { index_html?: string; styles_css?: string; app_js?: string; tests_js?: string };
  const missing: string[] = [];
  if (!input.index_html) missing.push('index_html');
  if (!input.styles_css) missing.push('styles_css');
  if (!input.app_js) missing.push('app_js');
  if (missing.length > 0) {
    throw new Error(`Compiler missing keys: ${missing.join(', ')} (present: ${Object.keys(input).join(', ') || 'none'}; stop_reason: ${resp.stop_reason})`);
  }

  const files: CodexFiles = { 'index.html': input.index_html!, 'styles.css': input.styles_css!, 'app.js': input.app_js! };
  if (input.tests_js) {
    files['tests.js'] = input.tests_js;
  }

  return {
    files,
    codex_sha: sha256(JSON.stringify(files)),
    compiler_version: COMPILER_VERSION,
  };
}
