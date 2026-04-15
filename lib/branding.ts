// Single source of truth for the user-facing product name.
//
// Local dev (Manidex) sets NEXT_PUBLIC_MANIFEX_PRODUCT_NAME=Manidex in
// .env.local and sees "Manidex" in titles, brand marks, and footers.
// Production Fly deploys leave the var unset and render "Manifex".
//
// Note on the env var prefix: Next.js only inlines process.env values
// into client-component bundles when the var starts with NEXT_PUBLIC_.
// Jesse's brief asked for a plain MANIFEX_PRODUCT_NAME, but client
// components (the editor, home page, about page) need access to the
// value at render time in the browser. Using NEXT_PUBLIC_ is the
// idiomatic Next.js way and keeps the branding working on both server
// and client components with one env var. When we fork Manidex and
// Manifex into separate repos, the env var disappears and each repo
// hardcodes its own product name.
export const PRODUCT_NAME = (process.env.NEXT_PUBLIC_MANIFEX_PRODUCT_NAME || 'Manifex').trim();
