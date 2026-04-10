// In-memory store for prototype Phase 1.
// Real Supabase persistence wired in Phase 2+.
//
// Reset on dev server restart. Survives hot reload via globalThis.

import type { ManifexProject, ManifexSession, ManifestState } from './types';
import { sha256 } from './crypto';
import { LOCAL_DEV_USER } from './types';

interface Store {
  projects: Map<string, ManifexProject>;
  sessions: Map<string, ManifexSession>;
}

declare global {
  // eslint-disable-next-line no-var
  var __manifex_store: Store | undefined;
}

if (!globalThis.__manifex_store) {
  globalThis.__manifex_store = {
    projects: new Map(),
    sessions: new Map(),
  };
}

export const store: Store = globalThis.__manifex_store;

export const STARTER_MANIFEST = `# My App

## Overview
A simple web application built with Manifex.

## Pages
- Home page with a welcome message

## Styles
- Clean, modern design with system fonts
- Light background, dark text
`;

export function makeManifestState(content: string): ManifestState {
  return {
    content,
    sha: sha256(content),
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
