# Manifex Prototype

Doc-first AI development tool. Users iterate on natural-language documentation (the "manifest") via prompts, and an LLM compiles it deterministically to runnable code (the "codex"). The manifest is canonical; the code is a derived artifact. Users never edit code directly.

## Status

Prototype — phases 1-5 build target.

## Stack

- Next.js 15 (App Router) frontend on localhost
- Modal app `manifex-compiler` for LLM operations
- Supabase (reuses DocGen project, `manifex_*` table prefix)
- Anthropic Claude (via DocGen Modal secret)

## Development

```bash
npm install
npm run dev
# Open http://localhost:3000
```

## Architecture

- **Manifest**: single markdown file with Overview/Pages/Styles sections — committed to git
- **Codex**: HTML/CSS/JS build output — gitignored
- **Lock file**: pairs `manifest_sha → codex_sha` for reproducible builds
- **Session**: DB-backed state (history, redo stack, pending attempt)

## Build phases

1. Skeleton — Next.js + DB tables + Modal stubs + API stubs
2. Auth + projects (deferred GitHub OAuth — using local user)
3. Manifest editing loop (prompt → diff → keep/retry/forget)
4. Rendering (compile + preview iframe)
5. Persistence (commit, reload)
