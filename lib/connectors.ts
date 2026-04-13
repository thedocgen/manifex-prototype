// Built-in connector registry. Single source of truth for both the UI
// (renders descriptions + behavior-when-enabled on the connectors page)
// and the server (injects systemHints into the doc-generation user
// message when the user has opted into them).
//
// Connectors are intent declarations: enabling one tells Manifex "this
// kind of capability is available to me", and the LLM doc spec writes
// features that use that capability. The runtime side is intentionally
// a no-op for v1 — real provider wiring happens later. The doc-level
// effect is real and immediate.

export interface Connector {
  id: string;
  name: string;
  description: string;
  behaviorWhenEnabled: string;
  systemHint: string;
}

export const BUILTIN_CONNECTORS: Connector[] = [
  {
    id: 'image-gen',
    name: 'Image Generation',
    description: 'Tell Manifex you have a way to generate or display images so it includes visual features in the spec.',
    behaviorWhenEnabled:
      'Manifex will write specs that include profile photos, product galleries, gallery views, image upload flows, and visual cards. The compiled app renders <img> tags with placeholder URLs.',
    systemHint:
      'IMAGE GENERATION is available. The user can produce or supply images. You MAY include features that use images: profile photos, product/recipe/entry photos, gallery grids, image upload + display, hero photos. Use placeholder image URLs from picsum.photos or unsplash.com in the spec. Do not invent OAuth flows or third-party providers — just describe the image features as if a render-time image source exists.',
  },
  {
    id: 'deploy',
    name: 'Deploy',
    description: 'Tell Manifex the app should be publishable so it includes a Publish flow in the spec.',
    behaviorWhenEnabled:
      'Manifex will write specs that include a "Publish to web" button and a description of the published URL. The compiled app renders the button as a no-op for now — real deploy wiring is a follow-up.',
    systemHint:
      'DEPLOY is available. The user wants this app to be publishable. Include a Publish or Share section in the Pages and Layout spec, with a Publish button (data-action="publish") that, when clicked, should display a sharable URL. The compiled app may stub the URL as "yourapp.manifex.app/preview" — the runtime is a future feature, but the spec acknowledges it.',
  },
  {
    id: 'database',
    name: 'Database',
    description: 'Tell Manifex you want shared, persistent multi-user data instead of browser-local storage.',
    behaviorWhenEnabled:
      'Manifex will write Data and Storage specs that describe shared records visible to multiple users, with create/read/update/delete via a remote API. The compiled app uses fetch() against a placeholder /api endpoint.',
    systemHint:
      'DATABASE is available. The user wants shared multi-user data, not browser-local storage. The Data and Storage page MUST describe records as living in a shared database, list the entities and their fields, and describe CRUD operations against a /api/<entity> REST endpoint. The compiled app should call fetch("/api/...") for reads/writes — the route is a placeholder for now, but the spec assumes it exists.',
  },
];

const BY_ID: Record<string, Connector> = Object.fromEntries(
  BUILTIN_CONNECTORS.map(c => [c.id, c]),
);

export function getConnector(id: string): Connector | undefined {
  return BY_ID[id];
}

/**
 * Build the CONNECTORS block to inject into the doc-generation user
 * message. Returns an empty string when no connectors are enabled so
 * the prompt stays clean for users who haven't opted into anything.
 */
export function buildConnectorsBlock(enabledIds: string[] | undefined | null): string {
  if (!enabledIds || enabledIds.length === 0) return '';
  const found = enabledIds
    .map(id => BY_ID[id])
    .filter((c): c is Connector => !!c);
  if (found.length === 0) return '';
  const lines = ['CONNECTORS AVAILABLE TO THE USER (these capabilities are in scope for the spec — feel free to include features that use them):'];
  for (const c of found) {
    lines.push(`\n- ${c.name}: ${c.systemHint}`);
  }
  return lines.join('\n');
}
