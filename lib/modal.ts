// LLM compiler service for Manifex.
// Multi-page document editing + conversational prompt handling.

import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from './crypto';
import { renderDiagramMarkers } from './diagram';
import { buildConnectorsBlock } from './connectors';
import type { CodexFiles, CompiledCodex, CompiledProject, ProjectFiles, ManifestState, DocPage, TreeNode, Question, ConversationMessage } from './types';
import { serializePages } from './types';

// Single source of truth for the compiler version. Bumping this string
// invalidates every cached compilation across all routes that read the
// cache. Re-exported so route handlers can import this constant instead
// of hard-coding it (we drifted to three different versions before
// extracting this).
export const COMPILER_VERSION = 'manifex-claude-sonnet-4-v6-budget-headroom';

// Phase 2B multi-file project compiler. Separate cache namespace from the v6
// single-HTML-blob compiler — bumping this string invalidates only the new
// compileManifestToProject cache entries. v6 keeps its own key until chunk 4
// of phase 2B removes it.
export const PROJECT_COMPILER_VERSION = 'v7-multi-file';

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
- On narrow edits (user asks to change 1–2 specific pages, or add/remove a single bullet), you MAY return ONLY the pages you are actually changing in the \`pages\` map. Unchanged pages should be OMITTED entirely, not re-emitted as stubs or full content. The server-side merge guard preserves unchanged pages from the current state automatically, byte-for-byte. This keeps the deep pass fast and avoids regurgitation timeouts.
- On scaffolding (first-ever generation or a full-rewrite prompt), return ALL pages as full content — this is the only time you should emit the complete 7-page set in one response.
- Either way: list EVERY modified/created/removed path in \`changed_pages\`. A path in \`pages\` but not in \`changed_pages\` is a bug; a path in \`changed_pages\` but not in \`pages\` is a deletion.
- Page paths use lowercase with hyphens. Each page's content is markdown starting with a heading.
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

**"Environment"** page MUST exist on every scaffold, positioned right after Overview in the tree. It has TWO independent sub-sections the compiler reads literally — always emit both, even in the shallow pass. These are never empty stubs: the shallow pass must emit full content for both sections, and the deep pass can refine wording but must not remove either section.

─── Section 1: "Compute space" (where the project runs) ───

This section declares the substrate the app is deployed on during authoring. It does NOT vary per project — Manifex ships an opinionated default so day-1 "type idea → click Build → working app" just works. Emit this EXACT starter content (adjust grammar but not the substance):

> The app runs on a **Manifex dev box** — a per-session Fly.io Machine running Ubuntu 24.04 on shared-cpu-2x / 1 GB RAM, with a 5 GB persistent volume mounted at /app/workspace. The volume survives machine stop/start, so node_modules, build caches, and SQLite databases persist across the lifecycle. The box runs a tiny Node agent exposing four primitives (bash, write_file, read_file, list_files) that a Claude build agent on the manifex-wip side uses to install dependencies, write files, run the dev server, and proxy HTTP from the public devbox URL to whatever port the dev server binds. A heartbeat from the editor tab keeps the machine running; closing the tab stops it; reopening restarts it via a .manifex/bootstrap.sh hook that replays the last run.sh automatically. ANTHROPIC_API_KEY stays on the editor side — the devbox holds no secrets and runs no LLM.

This default is used for every new session. Later phases may diverge compute space per environment (dev/staging/prod), but during authoring compute space is always "Manifex dev box". Do not invent alternatives unless the user explicitly asks for a different deployment substrate (AWS, GCP, local Docker, etc) — and even then, default to Manifex dev box unless they push back.

─── Section 2: "Stack" (what runs on the compute space) ───

This section declares the runtime + framework + database + toolchain the built app uses. It VARIES per request — you pick the right tool for THIS specific ask. There is NO default stack, NO allowlist, and NO Next.js bias. A cofounder picks the right tool for the job. That is the principle.

**Picking the stack:**

Read the user's prompt. What kind of thing are they asking for? Choose the stack a competent developer would actually reach for in that situation, then write your choice and a one-paragraph rationale into the Stack section. Some worked examples (these are illustrations, not a catalogue — the universe of valid stacks is everything a developer can run on a blank Ubuntu 24.04 box):

- "expense tracker for couples" → Next.js 15 App Router + Tailwind + SQLite via Drizzle. Rationale: dashboard web app with forms + persistent data, Next.js gives you routing/server actions/forms/SSR out of the box, SQLite is trivially provisioned and per-session-persistent.
- "fast static blog" → Astro. Rationale: content-first, zero JS by default, built-in MDX, optimal Lighthouse scores.
- "CLI tool that watches my downloads folder and renames files" → Rust or Go binary. Rationale: native file-system watching, single-binary distribution, no runtime dependencies for the user.
- "realtime multiplayer chess" → Next.js + Socket.IO, or Phoenix LiveView. Rationale: realtime bidirectional state requires a server-push channel; pick based on whether the rest of the app is node-shaped or elixir-shaped.
- "Django-style admin panel for my existing Postgres DB" → Django or Rails. Rationale: scaffolding ORM-introspected CRUD is what these frameworks exist for.
- "a Discord bot that reminds me to stretch" → Node with discord.js, or Python with discord.py. Rationale: the Discord ecosystem is nodejs-first, Python is a fine runner-up.

If the user's prompt explicitly names a runtime, framework, or language ("in Rust with Actix", "an Ember app", "Django", "Go with gin", "SvelteKit", "Rails 8"), honor it verbatim — do not second-guess, do not ask them to pick something else, do not push them toward your preferred stack. Cofounders never say no.

If the user's prompt leaves the stack open ("a budget tracker", "a todo list", "a landing page"), pick what you think is right for that ask and explain why in the rationale. The user can edit the Environment page to change your pick before clicking Build. That is the correction loop.

Include in the Stack section:

- **Your pick + one-paragraph rationale**: first, so the user sees your reasoning immediately.
- **Language and runtime**: e.g. "TypeScript on Node 20", "Rust 1.84 stable", "Ruby 3.3".
- **Framework**: e.g. "Next.js 15 App Router with Server Actions", "Astro 5", "Actix-web 4", "Rails 8".
- **Styling**: what the framework naturally expects (Tailwind via PostCSS for most JS frameworks, SCSS for Rails, Leptos for Rust-fullstack, etc).
- **Database**: if the app needs persistent data. SQLite at /app/workspace/data.db via whichever ORM is idiomatic for the stack, or "No persistent database — in-memory only." if the app is stateless.
- **Package manager**: match the runtime (npm / cargo / bundler / go modules / mix / pip).
- **Dev server port and bind address**: default 3000 for JS frameworks, canonical port for others. MUST bind to 0.0.0.0 (not localhost) so the devbox agent's proxy can reach it.
- **Dev command**: the literal shell invocation. Examples: "next dev -H 0.0.0.0 -p 3000", "bundle exec rails server -b 0.0.0.0 -p 3000", "ember serve --host 0.0.0.0 --port 3000", "cargo run", "mix phx.server".
- **Setup steps (plain-language ordered list)**: what setup.sh has to do to get from a blank box to "dev server ready to start". Apt installs, package manager install, schema push, seed, etc.

─── SHALLOW PASS ───

Emit the Environment page fully populated with BOTH sections above — the Compute space starter text verbatim and a Stack section showing your pick, rationale, and the full bullet list. This is the one page that is NEVER stub-only in the shallow pass. Every other page can be a 2-4 sentence summary; Environment must be complete so the generate agent has a working contract from the first build.

─── DEEP PASS ───

The deep pass may refine wording, add detail to the Setup steps bullet, and expand on external services in the Stack section, but must not remove either section and must not downgrade the Stack section to a vaguer description. If the user edited the Environment page between the shallow and deep passes (to change the stack), honor their edit — do not revert it.

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

const SHALLOW_DOCS_TOOL = {
  name: 'emit_shallow_docs',
  description: 'Emit a STRUCTURE-ONLY draft of the documentation: the page tree plus a 1-paragraph summary per page. No full sections, no diagrams, no detailed lists. The deep refinement pass will fill in content separately.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pages: {
        type: 'object' as const,
        description: 'Complete map of page path to { title, content }. Each content is a markdown stub: just the H1 title plus a single short paragraph (2-4 sentences) describing what the full version will cover.',
        additionalProperties: {
          type: 'object' as const,
          properties: {
            title: { type: 'string' as const, description: 'Page title' },
            content: { type: 'string' as const, description: 'Stub markdown: H1 + one short paragraph. Keep it under 300 characters.' },
          },
          required: ['title' as const, 'content' as const],
        },
      },
      tree: {
        type: 'array' as const,
        description: 'Sidebar navigation tree',
        items: TREE_NODE_SCHEMA,
      },
      diff_summary: { type: 'string' as const, description: 'Brief user-friendly summary of what the full doc set will contain' },
      changed_pages: {
        type: 'array' as const,
        description: 'Paths of pages in this draft',
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

/**
 * Fast first-pass scaffold. Emits the page tree + 1-paragraph summary per
 * page only — no full content, no diagrams, no detailed lists. Used by the
 * /prompt route's two-pass scaffold flow to give the user something to look
 * at in 15-30s while the deep refinement runs in the background.
 *
 * Always returns `{type: 'update', result: ...}` — the shallow path doesn't
 * support clarifying questions. Callers should run the planning question
 * branch via the regular editManifest first if they need to.
 */
export async function editManifestShallow(
  currentState: ManifestState,
  prompt: string,
  options: {
    conversationContext?: ConversationMessage[];
    enabledConnectors?: string[];
  } = {}
): Promise<EditResponse> {
  const serialized = serializePages(currentState);

  let userText = `CURRENT DOCUMENTATION PAGES:\n\n${serialized}\n\n---\n\n`;
  if (options.conversationContext && options.conversationContext.length > 0) {
    userText += 'RECENT CONVERSATION:\n';
    for (const msg of options.conversationContext) {
      userText += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
    }
    userText += '\n---\n\n';
  }
  const connectorsBlock = buildConnectorsBlock(options.enabledConnectors);
  if (connectorsBlock) {
    userText += `${connectorsBlock}\n\n---\n\n`;
  }
  userText += `USER REQUEST: ${prompt}\n\n---\n\nEmit a STRUCTURE-ONLY draft via emit_shallow_docs. Each page's content must be just the H1 title plus a short paragraph (2-4 sentences). Do NOT generate full sections, diagrams, or detailed lists — the deep pass will fill those in. Keep each page content under 300 characters.`;

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    temperature: 0,
    system: EDIT_SYSTEM,
    tools: [SHALLOW_DOCS_TOOL],
    tool_choice: { type: 'tool', name: 'emit_shallow_docs' },
    messages: [{ role: 'user', content: userText }],
  });

  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`editManifestShallow: LLM did not call emit_shallow_docs (stop_reason: ${resp.stop_reason})`);
  }

  const input = toolUse.input as {
    pages?: { [path: string]: { title?: string; content?: string } };
    tree?: any[];
    diff_summary?: string;
    changed_pages?: string[];
  };
  if (!input.pages || !input.tree) {
    throw new Error(`editManifestShallow: emit_shallow_docs missing pages or tree`);
  }

  const pages: { [path: string]: DocPage } = {};
  for (const [path, page] of Object.entries(input.pages)) {
    if (page && typeof page.title === 'string' && typeof page.content === 'string') {
      pages[path] = { title: page.title, content: page.content };
    }
  }

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
      diff_summary: input.diff_summary || `Drafting: ${prompt.slice(0, 60)}`,
      changed_pages: Array.isArray(input.changed_pages) ? input.changed_pages : Object.keys(pages),
    },
  };
}

export async function editManifest(
  currentState: ManifestState,
  prompt: string,
  options: {
    variation?: boolean;
    conversationContext?: ConversationMessage[];
    image?: { base64: string; media_type: string };
    forceUpdate?: boolean;
    /**
     * When set, the deep pass treats this as a refinement of an existing
     * shallow draft instead of a fresh generation. The shallow tree is
     * preserved; each page is deepened with full content. Prevents the
     * shallow→deep pair from disagreeing on page paths or section names.
     */
    shallowDraft?: { pages: { [path: string]: DocPage }; tree: TreeNode[] };
    enabledConnectors?: string[];
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

  const connectorsBlock = buildConnectorsBlock(options.enabledConnectors);
  if (connectorsBlock) {
    userText += `${connectorsBlock}\n\n---\n\n`;
  }
  userText += `USER REQUEST: ${prompt || '(see attached image)'}`;

  // If a shallow draft exists, instruct the deep pass to refine it in place
  // rather than re-generating the structure. Keeps the same tree and page
  // paths so the user's mental model from the draft survives the upgrade.
  if (options.shallowDraft) {
    const draftSerialized = Object.entries(options.shallowDraft.pages)
      .map(([path, page]) => `=== ${path} (${page.title}) ===\n${page.content}`)
      .join('\n\n');
    userText += `\n\n---\n\nSHALLOW DRAFT (already shown to the user — DEEPEN this in place, do not regenerate the structure):\n\n${draftSerialized}\n\nDEEP PASS RULES:\n- Use the EXACT same tree and page paths from the draft above.\n- Each page keeps its title and identity; replace the short summary with the full thorough content per the documentation rules in the system prompt.\n- changed_pages must list every page from the shallow draft (you are deepening all of them).\n- Do NOT add new pages or remove existing pages from the draft. Do NOT rename page paths.`;
  }

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

    // Deserialize the LLM's emitted pages into the canonical DocPage shape.
    // With the narrow-edit prompt rule this CAN be empty — the model is
    // allowed to omit unchanged pages, and the merge guard below will
    // rebuild the full pages map from currentState. No empty-check here.
    const llmPages: { [path: string]: DocPage } = {};
    for (const [path, page] of Object.entries(input.pages)) {
      if (page && typeof page.title === 'string' && typeof page.content === 'string') {
        llmPages[path] = { title: page.title, content: await renderDiagramMarkers(page.content) };
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Phase 3 fix: preserve unchanged pages from currentState
    // ─────────────────────────────────────────────────────────────────────
    //
    // The deep pass repeatedly violates the system prompt rule "Return ALL
    // pages, not just changed ones. Unchanged pages must be included as-is"
    // when the user requests a narrow edit. Symptom: pages NOT listed in
    // changed_pages come back as 200-300 char shallow stubs, collapsing the
    // entire spec on every minor doc edit. This is the bug that blocked
    // the Manifex-on-Manifex bug-fix-via-prompt-bar test.
    //
    // The fix is to TRUST currentState as the base and only apply diffs
    // from llmPages for paths the LLM explicitly claimed to change. Pages
    // the LLM emitted that ARE in changed_pages are applied. Pages it
    // emitted that ARE NOT in changed_pages are discarded in favour of the
    // existing content. New pages (in llmPages, not in currentState, AND
    // in changed_pages) are added. Deletions (in changed_pages, not in
    // llmPages) remove the entry.
    //
    // Plus a defensive length-regression check: even for pages the LLM
    // claims to have intentionally edited, if the new content is under
    // 300 chars (the shallow stub cap) and the existing content was over
    // 1000 chars, that's almost certainly the shallow draft leaking
    // through and we preserve the original. The model will get a chance
    // to actually rewrite the page on the next prompt.
    const claimedChanged = Array.isArray(input.changed_pages) ? input.changed_pages : [];
    const changedSet = new Set(claimedChanged);
    const merged: { [path: string]: DocPage } = {};
    const preservedPaths: string[] = [];
    const collapsedPaths: string[] = [];

    // Start from the existing manifest — every current page survives
    // unless explicitly changed.
    for (const [path, page] of Object.entries(currentState.pages || {})) {
      merged[path] = page;
    }

    // Apply LLM edits only where the LLM claimed a change.
    for (const path of Object.keys(llmPages)) {
      if (changedSet.has(path)) {
        const incoming = llmPages[path];
        const existing = currentState.pages?.[path];
        if (
          existing &&
          existing.content.length > 1000 &&
          incoming.content.length < 300
        ) {
          // Length-regression guard: shallow-stub leak. Keep the existing
          // page and record the path so the final merge_warnings array
          // surfaces what we caught.
          collapsedPaths.push(path);
          merged[path] = existing;
        } else {
          merged[path] = incoming;
        }
      } else if (!merged[path]) {
        // Brand-new page the LLM emitted but didn't list in changed_pages.
        // Treat as additive and accept it.
        merged[path] = llmPages[path];
      } else {
        // LLM emitted this page but did NOT claim a change. Preserve the
        // existing copy regardless of what was emitted.
        preservedPaths.push(path);
      }
    }

    // Handle deletions: paths the LLM listed as changed but didn't emit
    // are removed from the merged manifest.
    for (const path of changedSet) {
      if (!(path in llmPages)) {
        delete merged[path];
      }
    }

    if (preservedPaths.length > 0 || collapsedPaths.length > 0) {
      console.log(
        `[editManifest] merge protected ${preservedPaths.length} unchanged page(s)` +
          (preservedPaths.length > 0 ? `: ${preservedPaths.join(', ')}` : '') +
          (collapsedPaths.length > 0
            ? ` and rejected ${collapsedPaths.length} length-regression(s): ${collapsedPaths.join(', ')}`
            : '')
      );
    }

    const pages = merged;

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
- NEVER use emojis in generated output. This is absolute and applies to EVERY symbol slot, including ones where an emoji feels like the obvious shorthand: bell/notification (🔔), sound on/off (🔊 🔇), play/pause/stop (▶ ⏸ ⏹), checkmark/cross (✅ ❌), star ratings (⭐), arrows (➡), warning (⚠️). Replace with inline <svg> icons, geometric Unicode symbols (● ■ ▲ ◆ ✓ ✗ → ⏵ ⏸ ⏹), or short text labels ("On"/"Off", "Mute"/"Unmute"). The output must look like Stripe or Linear, not a chat app.

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
- If a Tests documentation page exists, generate a tests_js file with REAL behavior tests, not just structural element-existence checks. Both kinds matter:

  STRUCTURAL TESTS (still useful — verify the UI actually rendered):
  - element exists, button visible, color is right, text content present.
  - Cheap, fast, catch the LLM forgetting to render something.

  BEHAVIOR TESTS (the important ones — verify the app actually WORKS):
  - Time-based features: measure Date.now() before and after a brief
    real wait. Assert the displayed time changed by the right amount.
  - CRUD: drive the UI to add an item, assert it appears in the list,
    edit it, assert the change persists, delete it, assert it's gone.
  - Stats / aggregates: seed data via the real form flow, click compute,
    read the displayed value, assert against the expected value.
  - Navigation: click a nav element, assert the right view is shown
    (visible/hidden, hash changed, etc.).
  - Validation: submit a form with invalid input, assert an error appears.

  FORMAT (mandatory):
  Declare window.__manifexTests as an array of objects:
    { name: string, category: 'structural' | 'behavior', fn: () => void | Promise<void> }
  Each fn throws on failure. fn may be async — the runner awaits it.
  Provide a top-level helper:
    function assert(c, m) { if (!c) throw new Error(m); }
  The runner exposes these helpers on window for you to use directly:
    window.__manifexSleep(ms)              // await a real wait
    window.__manifexQuery(sel)             // querySelector shorthand
    window.__manifexQueryAll(sel)          // querySelectorAll → array
    window.__manifexClick(selOrEl)         // click and dispatch
    window.__manifexType(selOrEl, value)   // set input value + fire input/change

  EXAMPLE for a Pomodoro timer (covers the timer-accuracy failure mode):
    window.__manifexTests = [
      { name: 'start button visible', category: 'structural', fn: () => assert(document.querySelector('[data-action=start]'), 'no start button') },
      { name: 'timer counts down at real time', category: 'behavior', fn: async () => {
          document.querySelector('[data-action=start]').click();
          var displayBefore = document.querySelector('[data-role=time-display]').textContent;
          var msBefore = parseDisplay(displayBefore); // helper you also define
          await window.__manifexSleep(2000);
          var msAfter = parseDisplay(document.querySelector('[data-role=time-display]').textContent);
          var elapsed = msBefore - msAfter;
          assert(elapsed > 1500 && elapsed < 2500, 'timer drifted: expected ~2000ms in 2s, got ' + elapsed + 'ms');
      }},
    ];

  EXAMPLE for a CRUD list:
    { name: 'add then delete entry', category: 'behavior', fn: async () => {
        window.__manifexType('[data-field=title]', 'Test entry');
        window.__manifexClick('[data-action=add]');
        await window.__manifexSleep(50);
        var rows = window.__manifexQueryAll('[data-row]');
        assert(rows.some(r => r.textContent.includes('Test entry')), 'entry did not appear');
        window.__manifexClick('[data-row]:last-child [data-action=delete]');
        await window.__manifexSleep(50);
        assert(!window.__manifexQueryAll('[data-row]').some(r => r.textContent.includes('Test entry')), 'entry did not delete');
    }}

  Annotate every interactive element in your generated app with stable
  data-action / data-role / data-field attributes so the tests can
  target them reliably without relying on visible text. The same
  data-doc-page attributes you already emit for visual edit work.

  Aim for 60-80% of tests in the behavior category for any app with
  real interactions. Pure-static apps (a marketing landing page) can
  be mostly structural. Do NOT use top-level await or DOM-not-ready
  code — assume document is fully loaded when tests run.${secretsSection}`;
}

// Role-specific "what to emit" sections appended to the shared compiler
// system prompt for each parallel call. Every call still gets the full
// design system, quality bar, banned emojis, time-based features, tests
// guidance, etc. from buildCompilerSystem — these strings just tell each
// call which single file to emit and which tool to use.

const HTML_ROLE = `
YOUR TASK:
Emit ONLY the index.html file. Call the emit_file tool with the content.

- Complete HTML5 document (doctype, html, head, body).
- Include <script src="https://cdn.tailwindcss.com"></script> in <head>.
- Include the Inter font <link> from Google Fonts.
- Do NOT inline styles or scripts — the runtime inlines styles.css and app.js for you. Reference them as <link rel="stylesheet" href="styles.css"> and <script src="app.js"></script>.
- Annotate major sections with data-doc-page and data-doc-section so the docs-to-preview bridge can map them.
- Every interactive element (button, form field, row, nav link) MUST carry stable data-action / data-role / data-field attributes. The app.js and tests.js calls will target these same attributes without coordinating with you — agree by following the docs spec literally.
- Use kebab-case for all data-* values and CSS class names.
- Do NOT invent features not in the docs. If the docs don't mention it, don't render it.`;

const CSS_ROLE = `
YOUR TASK:
Emit ONLY the styles.css file. Call the emit_file tool with the content.

- Almost all styling is Tailwind utility classes in the HTML. This file is for:
  - A minimal :root color variable block if the Styles doc page defines a custom palette.
  - @keyframes for custom animations the Styles doc page describes.
  - Rare cases Tailwind cannot express (e.g. backdrop filters, container queries).
- Do NOT duplicate Tailwind utilities. Do NOT emit a framework-sized stylesheet.
- If the app has no custom animations or palette variables, a near-empty file (just a comment) is correct.`;

const JS_ROLE = `
YOUR TASK:
Emit ONLY the app.js file. Call the emit_file tool with the content.

- Vanilla JavaScript, no framework, no build step, no imports.
- An ELEMENT CONTRACT section below lists the data-action / data-role / data-field values the already-emitted index.html uses for STATIC elements (top-level navigation, add-form buttons, etc).
- For STATIC elements (anything that exists in the rendered HTML at page load), you MUST use only the contract values. Do not invent new data-action values for buttons that should exist in the static shell — the HTML didn't render them, so neither should you wire them.
- For DYNAMIC elements (rows in a CRUD list, modal contents, items in a results grid that JS renders via innerHTML or createElement), you ARE expected to invent new data-action / data-role values. Each row in a list usually needs its own per-row actions like 'edit-X', 'delete-X', 'check-X' — these legitimately do not appear in the static HTML because they're rendered per-row by your code. The rule for these:
  - Whenever you render a dynamic element with a data-action="foo", you MUST also have an event handler that checks for data-action === "foo" and runs the right behavior. Render-and-handle in the same file.
  - Use document-level event delegation: document.addEventListener('click', e => { const action = e.target.closest('[data-action]')?.dataset.action; if (action === 'edit-X') ... }).
- Implement the behavior described in the docs: CRUD, navigation, stats, timers, forms, validation.
- Use localStorage for persistence when the Data and Storage page describes a browser-local model.
- Wrap the whole thing in a DOMContentLoaded handler.
- Be deterministic: identical input should produce equivalent output.`;

const TESTS_ROLE = `
YOUR TASK:
Emit ONLY the tests.js file. Call the emit_file tool with the content.

- Declare window.__manifexTests as an array of { name, category, fn } per the TESTS section above.
- Aim for 60-80% behavior tests for any non-static app.
- An ELEMENT CONTRACT section below lists the data-action / data-role / data-field values the static index.html uses. For STATIC element tests, use those exact values.
- For DYNAMIC elements (rows in a list, modal items rendered by JS), the contract won't list them. Tests targeting dynamic elements should drive the UI through the static contract first (e.g. fill the add-form, click add), then query for the resulting dynamic elements by their structural position or by the data-role pattern the docs describe. Don't invent a static selector that doesn't exist; do walk through the actual user flow.
- Include a top-level "function assert(c, m) { if (!c) throw new Error(m); }" helper.
- Use window.__manifexSleep / __manifexClick / __manifexType / __manifexQuery / __manifexQueryAll for UI driving.
- Do NOT emit top-level await or DOM-not-ready code. Assume document is fully loaded when tests run.`;

const EMIT_FILE_TOOL = {
  name: 'emit_file',
  description: 'Emit the requested file as a single string.',
  input_schema: {
    type: 'object' as const,
    properties: {
      content: { type: 'string' as const, description: 'The full file content.' },
    },
    required: ['content' as const],
  },
};

async function emitOneFile(
  label: string,
  sharedSystem: string,
  roleSystem: string,
  serialized: string,
  maxTokens: number,
  extraUserContext?: string,
): Promise<string> {
  // Element contract goes BEFORE the docs (high recency = high attention).
  // The docs are huge and would otherwise drown out a short contract block
  // tacked onto the end. The hard-rule wrapper makes the constraint absolute.
  const userContent = extraUserContext
    ? `${extraUserContext}\n\nThe contract above is ABSOLUTE for the file you're about to emit. Even if the documentation below describes behavior for elements not in the contract, you may NOT use selectors outside the contract. If a doc-described feature has no contract attribute, skip it — the user will iterate.\n\nDOCUMENTATION PAGES (read for context, but the contract overrides):\n\n${serialized}\n\nEmit the ${label} file now by calling emit_file. Every selector you write MUST appear in the contract above.`
    : `DOCUMENTATION PAGES:\n\n${serialized}\n\nEmit the ${label} file now by calling emit_file.`;

  // Try once at the requested budget. If the LLM hits max_tokens before
  // it finishes writing the content string, the tool input arrives with
  // an empty/missing content field. Retry once with a substantially
  // larger budget — the per-file budgets used to be tight to optimize
  // speed but were causing recurring 500s on verbose files.
  const SDK_MAX_NON_STREAMING = 21000;
  const attempt = async (budget: number): Promise<{ content?: string; stopReason: string | null }> => {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: budget,
      temperature: 0,
      system: sharedSystem + '\n' + roleSystem,
      tools: [EMIT_FILE_TOOL],
      tool_choice: { type: 'tool', name: 'emit_file' },
      messages: [{ role: 'user', content: userContent }],
    });
    const toolUse = resp.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(`[${label}] LLM did not call emit_file (stop_reason: ${resp.stop_reason})`);
    }
    const input = toolUse.input as { content?: string };
    return { content: input.content, stopReason: resp.stop_reason };
  };

  let r = await attempt(maxTokens);
  if (r.stopReason === 'max_tokens' || typeof r.content !== 'string' || r.content.length === 0) {
    const retryBudget = Math.min(SDK_MAX_NON_STREAMING, Math.max(maxTokens, 8000) + 8000);
    if (retryBudget > maxTokens) {
      console.warn(`[${label}] hit max_tokens at ${maxTokens}, retrying at ${retryBudget}`);
      r = await attempt(retryBudget);
    }
  }
  if (typeof r.content !== 'string' || r.content.length === 0) {
    throw new Error(`[${label}] emit_file returned empty content after retry (stop_reason: ${r.stopReason})`);
  }
  return r.content;
}

// Scan the emitted HTML for data-action / data-role / data-field values
// so the JS and tests calls can target the EXACT same attribute set the
// HTML renders, eliminating inter-file drift without a coordination round.
function extractElementContract(html: string): string {
  const pick = (attr: string): string[] => {
    const re = new RegExp(`${attr}=[\"']([^\"']+)[\"']`, 'g');
    const values = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) values.add(m[1]);
    return Array.from(values).sort();
  };
  const actions = pick('data-action');
  const roles = pick('data-role');
  const fields = pick('data-field');
  const pages = pick('data-doc-page');
  const lines: string[] = ['ELEMENT CONTRACT (derived from the already-emitted index.html):'];
  lines.push(`- data-action values (${actions.length}): ${actions.length > 0 ? actions.join(', ') : '(none)'}`);
  lines.push(`- data-role values   (${roles.length}): ${roles.length > 0 ? roles.join(', ') : '(none)'}`);
  lines.push(`- data-field values  (${fields.length}): ${fields.length > 0 ? fields.join(', ') : '(none)'}`);
  lines.push(`- data-doc-page values (${pages.length}): ${pages.length > 0 ? pages.join(', ') : '(none)'}`);
  lines.push('Every selector in the file you emit MUST use only values from these lists. Do not invent new ones.');
  return lines.join('\n');
}

function manifestHasTestsPage(state: ManifestState): boolean {
  return Object.keys(state.pages).some(k => /^tests?$/.test(k));
}

export async function compileManifestToCodex(
  state: ManifestState,
  secrets?: { [key: string]: string }
): Promise<CompiledCodex> {
  const serialized = serializePages(state);
  const sharedSystem = buildCompilerSystem(state, secrets);
  const needsTests = manifestHasTestsPage(state);

  // Two-phase pipelined compile with tests on the slow path:
  //   Phase 1: index.html + styles.css in parallel (CSS doesn't need HTML).
  //   Phase 2: app.js, given HTML's exact data-action / data-role /
  //            data-field / data-doc-page values as an explicit ELEMENT
  //            CONTRACT so it targets the same selectors the HTML
  //            actually rendered.
  //
  // Tests.js is NOT on the critical path — it runs in the background
  // after phase 2 completes and updates the compilation cache when
  // ready. The preview is usable without tests; tests become available
  // on the next render of the same manifest sha (cached) or via a
  // future broadcast refresh.
  //
  // Total time to usable preview = (max HTML, CSS) + JS — ~90s typical,
  // down from 140-240s serial. A 1.6-2.7x speedup on the UX-critical
  // path.
  const started = Date.now();

  const [htmlContent, cssContent] = await Promise.all([
    emitOneFile('index.html', sharedSystem, HTML_ROLE, serialized, 16000),
    emitOneFile('styles.css', sharedSystem, CSS_ROLE, serialized, 6000),
  ]);
  const phase1Ms = Date.now() - started;

  const contract = extractElementContract(htmlContent);
  const jsContent = await emitOneFile('app.js', sharedSystem, JS_ROLE, serialized, 18000, contract);
  const phase2Ms = Date.now() - started - phase1Ms;

  const files: CodexFiles = {
    'index.html': htmlContent,
    'styles.css': cssContent,
    'app.js': jsContent,
  };
  const totalMs = Date.now() - started;
  console.log(`[compile] critical-path compile finished in ${totalMs}ms (phase1 ${phase1Ms}ms, phase2 ${phase2Ms}ms)`);

  // Background-phase tests.js generation. Kicked off AFTER we've assembled
  // the critical-path files but BEFORE we return. We intentionally do
  // NOT await — the caller gets the preview-ready codex immediately and
  // tests fill in asynchronously. The cache gets updated once tests
  // land so subsequent renders of the same manifest_sha include them.
  if (needsTests) {
    (async () => {
      try {
        const testsStarted = Date.now();
        const testsContent = await emitOneFile('tests.js', sharedSystem, TESTS_ROLE, serialized, 18000, contract);
        const testsMs = Date.now() - testsStarted;
        console.log(`[compile] background tests.js finished in ${testsMs}ms (${testsContent.length} bytes)`);
        // Update the cache entry with the full file set including tests.
        const updatedFiles: CodexFiles = { ...files, 'tests.js': testsContent };
        const updatedCodex: CompiledCodex = {
          files: updatedFiles,
          codex_sha: sha256(JSON.stringify(updatedFiles)),
          compiler_version: COMPILER_VERSION,
        };
        const { putCachedCompilation } = await import('./store');
        await putCachedCompilation(state.sha, COMPILER_VERSION, updatedCodex);
      } catch (e: any) {
        console.error(`[compile] background tests.js failed:`, e?.message || String(e));
      }
    })();
  }

  return {
    files,
    codex_sha: sha256(JSON.stringify(files)),
    compiler_version: COMPILER_VERSION,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Phase 2B v7 multi-file project compiler.
// ════════════════════════════════════════════════════════════════════════
//
// Emits a real multi-file project (Next.js 15 + Tailwind + SQLite + Drizzle
// by default) plus a stack-agnostic setup.sh / run.sh pair that provisions
// a blank Ubuntu 24.04 box into the running stack. Coexists with the v6
// single-HTML-blob compiler above — chunk 4 of phase 2B will wire the new
// render route into this function and deprecate v6.
//
// Architecture of the parallel emit:
//
//   Phase 1 (in parallel — no cross-deps):
//     - SHELL role:  package.json, tsconfig.json, next.config.mjs,
//                    tailwind.config.ts, postcss.config.mjs, app/layout.tsx,
//                    app/globals.css, .gitignore
//     - DATA role:   drizzle/schema.ts, lib/db.ts, drizzle.config.ts
//     - INFRA role:  setup.sh, run.sh, port
//
//   Phase 2 (given phase 1 as context so imports resolve):
//     - PAGES role:  app/page.tsx, app/**/route.ts, any subroute page.tsx,
//                    and lib/actions.ts if the app needs server actions
//
// The roles are additive: each call emits its own slice of the files map,
// we merge them at the end. INFRA's return also carries the setup/run/port
// top-level fields on CompiledProject.

function readEnvironmentPage(state: ManifestState): { content: string; hasPage: boolean } {
  const candidates = ['environment', 'env', 'stack', 'runtime'];
  for (const key of candidates) {
    const p = state.pages[key];
    if (p && p.content && p.content.trim().length > 0) {
      return { content: p.content, hasPage: true };
    }
  }
  return { content: '', hasPage: false };
}

const DEFAULT_STACK_DECLARATION = `Language: TypeScript
Runtime: Node 20
Framework: Next.js 15 (App Router, RSC, Server Actions enabled)
Styling: Tailwind CSS v3 via PostCSS
Database: SQLite (file: /app/workspace/data.db)
ORM: Drizzle ORM + drizzle-kit (push mode, no migrations directory for v1)
Package manager: npm (ships with apt-installed nodejs)
Dev server port: 3000
Dev command: next dev -p 3000`;

function buildProjectCompilerSystem(state: ManifestState, secrets?: { [key: string]: string }): string {
  const env = readEnvironmentPage(state);
  const stackBlock = env.hasPage
    ? `ENVIRONMENT (declared by the spec's Environment page — follow it literally):\n\n${env.content}\n\nIf the Environment page is silent on any detail below, fall back to the v1 default stack:\n\n${DEFAULT_STACK_DECLARATION}`
    : `ENVIRONMENT (spec has no Environment page — use the v1 default stack):\n\n${DEFAULT_STACK_DECLARATION}`;

  let secretsSection = '';
  if (secrets && Object.keys(secrets).length > 0) {
    secretsSection = `\n\nSECRETS AVAILABLE (inject these values into server-side code only — never into client bundles):
${Object.entries(secrets).map(([k, v]) => `- ${k}: "${v}"`).join('\n')}`;
  }

  return `You are the Manifex v7 project compiler. You compile a multi-page documentation spec into a real, runnable multi-file project on a blank Ubuntu 24.04 box. The documentation IS the source of truth: read every page before deciding what to emit.

${stackBlock}

ABSOLUTE PRINCIPLES:
- Every file you emit must be production-quality TypeScript. No TODO stubs, no "implement this later" comments, no placeholder routes returning 501.
- The project must run with exactly: \`bash setup.sh && bash run.sh\`. No other manual steps. No interactive prompts.
- Environment variables the app needs at runtime are written into a \`.env.local\` file by setup.sh (or committed directly if they're not secrets).
- The dev server MUST bind to 0.0.0.0, not localhost — the devbox agent proxies to 127.0.0.1:<port> from inside the container but Next.js's default bind of localhost IPv6 can flake. Use \`next dev -H 0.0.0.0 -p 3000\`.
- run.sh MUST write the dev server port as a decimal ASCII integer to \`/app/workspace/.manifex-port\` BEFORE exec'ing the dev server (so the agent's proxy can find it). Do this via \`echo 3000 > /app/workspace/.manifex-port\`.
- Next.js projects MUST include a \`next.config.mjs\` with \`output: 'standalone'\` disabled (dev mode only this round) AND \`experimental.serverActions: { allowedOrigins: ['*'] }\` so the devbox's proxy hostname doesn't fail CSRF.
- Tailwind config MUST \`content: ['./app/**/*.{ts,tsx}','./components/**/*.{ts,tsx}','./lib/**/*.{ts,tsx}']\`.
- SQLite path MUST be \`/app/workspace/data.db\` (absolute). Drizzle \`better-sqlite3\` driver.
- Drizzle: use \`drizzle-kit push\` in setup.sh after install (\`npx drizzle-kit push --config=drizzle.config.ts --force\`) so the schema lands before the dev server starts. NO migrations folder for v1.
- Do NOT emit any file outside the workspace root. All paths in your output are RELATIVE, no leading slash, no \`..\`.
- Do NOT emit node_modules, .next, or any build output. setup.sh generates those.
- Do NOT emit package-lock.json — setup.sh generates one via \`npm install\`.

QUALITY BAR (the rendered app must look Stripe/Linear/Notion-grade):
- Typography: Inter font via next/font. Clear hierarchy (text-3xl/4xl font-bold tracking-tight headings, text-base leading-relaxed body text-slate-700).
- Spacing: py-12 to py-20 section padding, max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 content wells, p-6 card padding.
- Colors: slate neutrals + one accent from the Styles page. White / slate-50 alternating section backgrounds.
- Cards: bg-white rounded-xl shadow-sm border border-slate-200, hover:shadow-md transition-shadow duration-200.
- Buttons: rounded-lg px-4 py-2.5 font-medium, colored primary + slate-bordered secondary.
- Forms: text-sm font-medium labels, rounded-lg focus:ring-2 inputs with validation states.
- Never emit Lorem ipsum, never emit emojis (inline <svg> or geometric unicode instead — same rule as v6).
- Responsive: mobile-first with sm: / md: / lg: breakpoints.
- Empty states: never blank — helpful text, subtle icons, sample data.

CONTENT RULES:
- Every interactive element needs a stable \`data-action\` / \`data-role\` / \`data-field\` attribute so future tests can target it. kebab-case values.
- Also emit \`data-doc-page\` / \`data-doc-section\` on major blocks so the visual-edit bridge can map rendered elements back to the spec.
- Follow the documentation exactly. Do NOT invent features that aren't in the docs.${secretsSection}

OUTPUT CONTRACT:
You will receive role-specific instructions telling you which slice of the project to emit. Call the \`emit_project_section\` tool exactly once with the right fields for your role. DO NOT emit text outside the tool call.`;
}

const SHELL_PROJECT_ROLE = `
YOUR ROLE: SHELL (project scaffolding, no app logic)

Emit these files via emit_project_section.files:
- package.json         — dependencies: next@^15, react@^19, react-dom@^19, tailwindcss@^3, postcss, autoprefixer, drizzle-orm, better-sqlite3, drizzle-kit, typescript, @types/node, @types/react, @types/react-dom, @types/better-sqlite3. "scripts": { "dev": "next dev -H 0.0.0.0 -p 3000", "build": "next build", "start": "next start -H 0.0.0.0 -p 3000" }. No optional fields. No lockfile.
- tsconfig.json        — Standard Next.js 15 App Router tsconfig (strict, ESNext module, bundler moduleResolution, jsx preserve, include ["next-env.d.ts","**/*.ts","**/*.tsx",".next/types/**/*.ts"]).
- next.config.mjs      — \`export default { experimental: { serverActions: { allowedOrigins: ['*'] } } }\`
- tailwind.config.ts   — content globs per system rules above, theme extend with Inter font family.
- postcss.config.mjs   — tailwindcss + autoprefixer
- app/layout.tsx       — root layout: loads Inter via next/font/google, imports ./globals.css, wraps children in <html lang="en"> <body className="min-h-screen bg-white font-sans antialiased text-slate-900">.
- app/globals.css      — @tailwind base/components/utilities; :root custom properties for the palette declared on the Styles page.
- .gitignore           — node_modules, .next, data.db, .env.local, .manifex-port

Do NOT emit app/page.tsx, app/**/route.ts, lib/*, drizzle/*, or any setup/run scripts. Those belong to other roles.`;

const DATA_PROJECT_ROLE = `
YOUR ROLE: DATA (schema + db client + drizzle config)

Emit these files via emit_project_section.files:
- drizzle/schema.ts    — Drizzle schema tables describing every entity the documentation's Data Model / data storage page declares. Use better-sqlite3 driver (sqliteTable from drizzle-orm/sqlite-core). Each table exports its inferred Select/Insert types: \`export type Foo = typeof foo.$inferSelect; export type NewFoo = typeof foo.$inferInsert;\`. Include createdAt timestamps (integer mode: 'timestamp') with \`$defaultFn(() => new Date())\`.
- lib/db.ts            — Exports a shared Drizzle client: \`import Database from 'better-sqlite3'; import { drizzle } from 'drizzle-orm/better-sqlite3'; import * as schema from '@/drizzle/schema'; const sqlite = new Database('/app/workspace/data.db'); export const db = drizzle(sqlite, { schema });\`. Also re-export \`schema\`.
- drizzle.config.ts    — \`export default { schema: './drizzle/schema.ts', out: './drizzle', dialect: 'sqlite', dbCredentials: { url: '/app/workspace/data.db' } } satisfies Config\` (import Config from 'drizzle-kit').
- lib/seed.ts          — Idempotent seed helper: imports db + schema, checks row count, inserts 3-8 realistic sample rows into each primary table if empty. Use real-looking content appropriate to the documented domain, not Lorem ipsum. Exports a \`seed()\` async function that returns a summary.

If the app has NO persistent data (pure static landing page, for example), still emit a minimal schema.ts with at least a \`_ping\` table and a no-op seed — this keeps setup.sh's drizzle-kit push step consistent across all projects.`;

const INFRA_PROJECT_ROLE = `
YOUR ROLE: INFRA (setup + run scripts + port number)

Emit the following via emit_project_section:
- setup: a full bash script string that provisions a blank Ubuntu 24.04 box (running as root, /app/workspace is cwd) into a working Next.js dev environment. Required steps in order:
    1. \`set -euo pipefail\`
    2. \`export DEBIAN_FRONTEND=noninteractive\`
    3. \`apt-get update\`
    4. \`apt-get install -y --no-install-recommends build-essential python3 ca-certificates\` (better-sqlite3 needs build tools; node is already on the image)
    5. \`apt-get clean && rm -rf /var/lib/apt/lists/*\`
    6. \`echo "[setup] installing npm dependencies…" && npm install --no-audit --no-fund --loglevel=error\`
    7. \`echo "[setup] pushing drizzle schema…" && npx drizzle-kit push --config=drizzle.config.ts --force\`
    8. \`echo "[setup] seeding database…" && node --input-type=module -e "import('./lib/seed.ts').then(m => m.seed()).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exit(1); })"\` (OR call via tsx/ts-node if import of .ts fails; use whichever the rest of the toolchain supports — if in doubt, skip the seed step here and rely on the app creating its own demo data on first request)
    9. \`echo "[setup] complete"\`
    setup.sh MUST be re-runnable — steps 6-8 should be idempotent. If a step typically takes a while, emit a human-readable echo before it so the /__logs stream shows progress.

- run: a bash script string that STARTS the dev server and writes its port. Required steps in order:
    1. \`set -euo pipefail\`
    2. \`echo 3000 > /app/workspace/.manifex-port\`
    3. \`exec npx next dev -H 0.0.0.0 -p 3000\`
    Do NOT background the dev server (\`&\`). The agent's /__exec detach=true mode handles backgrounding. run.sh must block on the dev server so agent logs keep flowing.

- port: the integer 3000 (or whatever port run.sh binds — they MUST match).

Do NOT emit any files in this role. files should be {} or omitted. setup/run/port are the only outputs.`;

const PAGES_PROJECT_ROLE = `
YOUR ROLE: PAGES (all app/ routes, server actions, UI components)

You are running AFTER the SHELL and DATA roles have finished. A \`PHASE 1 CONTEXT\` block below shows exactly what they emitted — in particular the Drizzle schema in drizzle/schema.ts and the db client at lib/db.ts. Your imports MUST match those exports literally.

Emit these files via emit_project_section.files:
- app/page.tsx              — the home route. Server Component by default. Query the db via the exported client, render real data, use Tailwind for styling.
- app/**/page.tsx           — every additional route the docs describe (dashboard, list views, detail views, etc.). One file per documented page. Use App Router folder conventions (app/expenses/page.tsx, app/expenses/[id]/page.tsx, etc).
- app/api/*/route.ts        — API handlers if the docs call for JSON endpoints (GET/POST/PATCH/DELETE handlers as named exports).
- lib/actions.ts            — all server actions ('use server' at file top). Each exported function takes FormData or typed args, mutates the db via the shared client, and returns a simple success/error shape. Use \`revalidatePath\` after mutations.
- components/*.tsx          — shared client components (forms with useFormState, interactive widgets, nav). Mark with 'use client' only when state/effects required.
- app/not-found.tsx         — simple 404 page styled consistently.

Import the db via \`import { db, schema } from '@/lib/db'\`. Import server actions via \`import { createFoo, deleteFoo } from '@/lib/actions'\`.

Do NOT re-emit any file that SHELL or DATA already emitted. Every file you emit is ADDITIVE to their output and must not collide. If you need a config adjustment (e.g. a tailwind plugin), add it to tailwind.config.ts by re-emitting ONLY that one path as a complete replacement.`;

// Tool spec for the v7 project compiler. files is an open-ended object
// mapping project-relative paths to full file contents. setup/run/port
// are only meaningful in the INFRA role but are kept on every call's
// schema for symmetry; the role prompts gate which fields get used.
const EMIT_PROJECT_SECTION_TOOL = {
  name: 'emit_project_section',
  description: 'Emit a slice of the multi-file project. files is a path→content map for the files this role owns. setup/run/port are only emitted by the INFRA role.',
  input_schema: {
    type: 'object' as const,
    properties: {
      files: {
        type: 'object' as const,
        description: 'Project-relative path → full file content for every file this role owns. Keys are POSIX paths without a leading slash.',
        additionalProperties: { type: 'string' as const },
      },
      setup: { type: 'string' as const, description: 'Full bash script provisioning a blank Ubuntu box. INFRA role only.' },
      run: { type: 'string' as const, description: 'Full bash script starting the dev server. INFRA role only.' },
      port: { type: 'integer' as const, description: 'Dev server port. INFRA role only.' },
    },
    required: ['files' as const],
  },
};

interface ProjectSectionResult {
  files: ProjectFiles;
  setup?: string;
  run?: string;
  port?: number;
}

async function emitProjectSection(
  label: string,
  sharedSystem: string,
  roleSystem: string,
  serialized: string,
  maxTokens: number,
  extraUserContext?: string,
): Promise<ProjectSectionResult> {
  const userContent = extraUserContext
    ? `${extraUserContext}\n\nDOCUMENTATION PAGES:\n\n${serialized}\n\nEmit the ${label} section now by calling emit_project_section.`
    : `DOCUMENTATION PAGES:\n\n${serialized}\n\nEmit the ${label} section now by calling emit_project_section.`;

  const SDK_MAX_NON_STREAMING = 21000;
  const attempt = async (budget: number) => {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: budget,
      temperature: 0,
      system: sharedSystem + '\n' + roleSystem,
      tools: [EMIT_PROJECT_SECTION_TOOL],
      tool_choice: { type: 'tool', name: 'emit_project_section' },
      messages: [{ role: 'user', content: userContent }],
    });
    const toolUse = resp.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(`[${label}] LLM did not call emit_project_section (stop_reason: ${resp.stop_reason})`);
    }
    const input = toolUse.input as ProjectSectionResult;
    return { input, stopReason: resp.stop_reason };
  };

  let r = await attempt(maxTokens);
  const filesEmpty = !r.input.files || Object.keys(r.input.files).length === 0;
  const missingInfra = label === 'INFRA' && (!r.input.setup || !r.input.run || !r.input.port);
  const shouldRetry = r.stopReason === 'max_tokens' || (label !== 'INFRA' && filesEmpty) || missingInfra;
  if (shouldRetry) {
    const retryBudget = Math.min(SDK_MAX_NON_STREAMING, Math.max(maxTokens, 8000) + 8000);
    if (retryBudget > maxTokens) {
      console.warn(`[${label}] retry at ${retryBudget} (stop_reason=${r.stopReason}, files=${Object.keys(r.input.files || {}).length})`);
      r = await attempt(retryBudget);
    }
  }

  const rawFiles = (r.input.files || {}) as Record<string, unknown>;
  // Coerce: Claude will occasionally emit JSON-shaped files (package.json,
  // tsconfig.json) as parsed objects instead of strings, ignoring the
  // additionalProperties: { type: 'string' } hint. Stringify those back
  // into file contents rather than fail the whole compile. Numbers/booleans
  // get String()'d for symmetry.
  const files: ProjectFiles = {};
  for (const [p, raw] of Object.entries(rawFiles)) {
    // Path safety first — reject before we touch content.
    if (p.startsWith('/') || p.includes('..') || p.startsWith('__manifex/')) {
      throw new Error(`[${label}] illegal file path: ${p}`);
    }
    if (typeof raw === 'string') {
      files[p] = raw;
    } else if (raw && typeof raw === 'object') {
      try {
        files[p] = JSON.stringify(raw, null, 2) + '\n';
      } catch (e: any) {
        throw new Error(`[${label}] file ${p} had non-string object content that failed to stringify: ${e?.message || e}`);
      }
    } else if (raw != null) {
      files[p] = String(raw);
    } else {
      throw new Error(`[${label}] file ${p} has null/undefined content`);
    }
  }
  const out: ProjectSectionResult = { files };
  if (typeof r.input.setup === 'string') out.setup = r.input.setup;
  if (typeof r.input.run === 'string') out.run = r.input.run;
  if (typeof r.input.port === 'number' && Number.isFinite(r.input.port)) out.port = r.input.port;

  if (label === 'INFRA' && (!out.setup || !out.run || !out.port)) {
    throw new Error(`[${label}] incomplete infra payload: setup=${!!out.setup}, run=${!!out.run}, port=${out.port}`);
  }
  if (label !== 'INFRA' && Object.keys(files).length === 0) {
    throw new Error(`[${label}] emitted zero files`);
  }
  return out;
}

function summarizePhase1ForPages(shell: ProjectFiles, data: ProjectFiles): string {
  const pick = (files: ProjectFiles, path: string): string | null => {
    const v = files[path];
    return typeof v === 'string' ? v : null;
  };
  const schema = pick(data, 'drizzle/schema.ts');
  const dbClient = pick(data, 'lib/db.ts');
  const pkg = pick(shell, 'package.json');
  const lines: string[] = ['PHASE 1 CONTEXT — files the SHELL and DATA roles already emitted.'];
  lines.push('Your imports MUST line up with what these files actually export. Do not restate or re-emit them.');
  lines.push('');
  if (pkg) {
    lines.push('── package.json ──');
    lines.push(pkg);
    lines.push('');
  }
  if (schema) {
    lines.push('── drizzle/schema.ts ──');
    lines.push(schema);
    lines.push('');
  }
  if (dbClient) {
    lines.push('── lib/db.ts ──');
    lines.push(dbClient);
    lines.push('');
  }
  const shellPaths = Object.keys(shell).filter(p => p !== 'package.json').sort();
  const dataPaths = Object.keys(data).filter(p => p !== 'drizzle/schema.ts' && p !== 'lib/db.ts').sort();
  if (shellPaths.length > 0) {
    lines.push('── other SHELL files (already written — do not re-emit) ──');
    for (const p of shellPaths) lines.push(`  ${p}`);
    lines.push('');
  }
  if (dataPaths.length > 0) {
    lines.push('── other DATA files (already written — do not re-emit) ──');
    for (const p of dataPaths) lines.push(`  ${p}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function compileManifestToProject(
  state: ManifestState,
  secrets?: { [key: string]: string }
): Promise<CompiledProject> {
  const serialized = serializePages(state);
  const sharedSystem = buildProjectCompilerSystem(state, secrets);

  // Phase 1: SHELL + DATA + INFRA in parallel. No cross-deps — each role
  // owns a disjoint set of paths and INFRA's scripts only need to reference
  // filenames, not file contents.
  const started = Date.now();
  const [shellSection, dataSection, infraSection] = await Promise.all([
    emitProjectSection('SHELL', sharedSystem, SHELL_PROJECT_ROLE, serialized, 12000),
    emitProjectSection('DATA', sharedSystem, DATA_PROJECT_ROLE, serialized, 10000),
    emitProjectSection('INFRA', sharedSystem, INFRA_PROJECT_ROLE, serialized, 4000),
  ]);
  const phase1Ms = Date.now() - started;

  // Phase 2: PAGES, given phase 1 as literal context so imports line up.
  const phase1Summary = summarizePhase1ForPages(shellSection.files, dataSection.files);
  const pagesSection = await emitProjectSection(
    'PAGES',
    sharedSystem,
    PAGES_PROJECT_ROLE,
    serialized,
    18000,
    phase1Summary,
  );
  const phase2Ms = Date.now() - started - phase1Ms;

  // Merge, with phase 2 allowed to overwrite phase 1 for the narrow
  // "adjust tailwind.config.ts" escape hatch the PAGES prompt permits.
  const files: ProjectFiles = {
    ...shellSection.files,
    ...dataSection.files,
    ...pagesSection.files,
  };

  const setup = infraSection.setup!;
  const run = infraSection.run!;
  const port = infraSection.port!;

  const totalMs = Date.now() - started;
  console.log(`[v7-compile] finished in ${totalMs}ms (phase1 ${phase1Ms}ms, phase2 ${phase2Ms}ms, files=${Object.keys(files).length}, port=${port})`);

  return {
    files,
    setup,
    run,
    port,
    codex_sha: sha256(JSON.stringify({ files, setup, run, port })),
    compiler_version: PROJECT_COMPILER_VERSION,
  };
}
