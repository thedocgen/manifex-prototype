'use client';
import { useState, useEffect } from 'react';
import { Brand } from '@/components/Brand';
import { BUILTIN_CONNECTORS as REGISTRY } from '@/lib/connectors';

const STORAGE_KEY = 'manifex.connectors.v1';

interface Connector {
  id: string;
  name: string;
  description: string;
  behaviorWhenEnabled?: string;
  enabled: boolean;
  builtin: boolean;
  endpoint?: string;
}

// Built-in connector cards rehydrated from the shared lib/connectors.ts
// registry so the UI and the server agree on names + descriptions.
const BUILTIN_CONNECTORS: Connector[] = REGISTRY.map(c => ({
  id: c.id,
  name: c.name,
  description: c.description,
  behaviorWhenEnabled: c.behaviorWhenEnabled,
  enabled: false,
  builtin: true,
}));

interface ConnectorTemplate {
  label: string;
  endpoint: string;
  description: string;
}

const TEMPLATES: ConnectorTemplate[] = [
  {
    label: 'Anthropic image generation',
    endpoint: 'https://api.anthropic.com/v1/images',
    description: 'Manifex spec writes image features as if Anthropic image generation is available.',
  },
  {
    label: 'OpenAI DALL-E',
    endpoint: 'https://api.openai.com/v1/images/generations',
    description: 'Manifex spec writes image features as if DALL-E is available.',
  },
  {
    label: 'Vercel deploy',
    endpoint: 'https://api.vercel.com/v13/deployments',
    description: 'Manifex spec writes a Publish flow as if Vercel deploy is available.',
  },
];

function mergeWithBuiltins(stored: Connector[]): Connector[] {
  // Reconcile stored data with the latest registry content. Stored entries
  // win on enabled-state, but description / behaviorWhenEnabled / name come
  // from the registry so prompt updates propagate to existing users.
  const storedById = new Map(stored.map(c => [c.id, c]));
  const result: Connector[] = [];
  for (const builtin of BUILTIN_CONNECTORS) {
    const s = storedById.get(builtin.id);
    result.push(s ? { ...builtin, enabled: !!s.enabled } : builtin);
    storedById.delete(builtin.id);
  }
  // Any custom (non-builtin) entries the user added.
  for (const remaining of storedById.values()) {
    if (!remaining.builtin) result.push(remaining);
  }
  return result;
}

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<Connector[]>(BUILTIN_CONNECTORS);
  const [hydrated, setHydrated] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEndpoint, setNewEndpoint] = useState('');
  const [newApiKey, setNewApiKey] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Connector[];
        if (Array.isArray(parsed)) setConnectors(mergeWithBuiltins(parsed));
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(connectors)); } catch {}
  }, [connectors, hydrated]);

  const toggleConnector = (id: string) => {
    setConnectors(prev =>
      prev.map(c => (c.id === id ? { ...c, enabled: !c.enabled } : c))
    );
  };

  const removeConnector = (id: string) => {
    setConnectors(prev => prev.filter(c => c.id !== id));
  };

  const addCustomConnector = () => {
    if (!newName.trim() || !newEndpoint.trim()) return;
    const connector: Connector = {
      id: `custom-${Date.now()}`,
      name: newName.trim(),
      description: `MCP endpoint: ${newEndpoint.trim()}`,
      enabled: true,
      builtin: false,
      endpoint: newEndpoint.trim(),
    };
    setConnectors(prev => [...prev, connector]);
    setNewName('');
    setNewEndpoint('');
    setNewApiKey('');
  };

  return (
    <div style={{ minHeight: '100vh', fontFamily: 'var(--font-sans)' }}>
      <Brand />

      <main style={{ maxWidth: '680px', margin: '0 auto', padding: '64px 32px' }}>
        <h1 style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '40px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '0 0 12px',
          lineHeight: 1.2,
          color: 'var(--text)',
        }}>
          Connectors
        </h1>
        <p style={{
          fontSize: '17px',
          lineHeight: 1.6,
          color: 'var(--text-muted)',
          margin: '0 0 12px',
        }}>
          Tell Manifex what tools you have. The doc spec it writes will use them.
        </p>
        <p style={{
          fontSize: '13px',
          lineHeight: 1.5,
          color: 'var(--text-dim)',
          margin: '0 0 32px',
        }}>
          Connectors are intent declarations. Enabling Image Generation makes Manifex include photo features in the spec.
          Enabling Database makes it write specs around shared multi-user records instead of browser storage.
          Real provider wiring lands later — for now, enabling a connector changes what gets <em>described</em>, not what gets called at runtime.
        </p>

        {/* Active count */}
        <div style={{
          fontSize: '12px',
          color: 'var(--text-dim)',
          marginBottom: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <span
            data-testid="connectors-active-count"
            style={{
              padding: '2px 9px',
              borderRadius: '999px',
              background: connectors.filter(c => c.enabled).length > 0 ? 'rgba(16, 185, 129, 0.14)' : 'rgba(0,0,0,0.04)',
              color: connectors.filter(c => c.enabled).length > 0 ? '#047857' : 'var(--text-dim)',
              fontWeight: 600,
            }}
          >
            {connectors.filter(c => c.enabled).length} active
          </span>
          <span>· {connectors.length} available</span>
        </div>

        {/* Connector list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '48px' }}>
          {connectors.map(c => (
            <div
              key={c.id}
              className="mx-card"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: '16px',
                cursor: 'default',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 4px', color: 'var(--text)' }}>
                  {c.name}
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: '0 0 6px', lineHeight: 1.5 }}>
                  {c.description}
                </p>
                {c.behaviorWhenEnabled && (
                  <p style={{
                    fontSize: '12px',
                    color: c.enabled ? 'var(--accent)' : 'var(--text-dim)',
                    margin: 0,
                    lineHeight: 1.5,
                    fontStyle: 'italic',
                    opacity: c.enabled ? 1 : 0.65,
                  }}>
                    {c.enabled ? 'Active: ' : 'When enabled: '}{c.behaviorWhenEnabled}
                  </p>
                )}
                {!c.builtin && c.endpoint && (
                  <p style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '6px 0 0', fontFamily: 'var(--font-mono, monospace)' }}>
                    {c.endpoint}
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, paddingTop: '2px' }}>
                <span style={{
                  fontSize: '12px',
                  color: c.enabled ? 'var(--accent)' : 'var(--text-dim)',
                  fontWeight: 500,
                }}>
                  {c.enabled ? 'Enabled' : 'Disabled'}
                </span>
                <button
                  onClick={() => toggleConnector(c.id)}
                  style={{
                    width: '40px',
                    height: '22px',
                    borderRadius: '11px',
                    border: 'none',
                    cursor: 'pointer',
                    position: 'relative',
                    background: c.enabled ? 'var(--accent)' : 'var(--border)',
                    transition: 'background 0.2s',
                  }}
                >
                  <span style={{
                    position: 'absolute',
                    top: '2px',
                    left: c.enabled ? '20px' : '2px',
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </button>
                {!c.builtin && (
                  <button
                    onClick={() => removeConnector(c.id)}
                    title="Remove connector"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-dim)',
                      fontSize: '16px',
                      padding: '4px 6px',
                    }}
                  >×</button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Add Custom Connector */}
        <div style={{
          borderTop: '1px solid var(--border)',
          paddingTop: '32px',
        }}>
          <h2 style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '24px',
            fontWeight: 600,
            margin: '0 0 16px',
            color: 'var(--accent)',
          }}>
            Add Custom Connector
          </h2>
          <p style={{
            fontSize: '14px',
            color: 'var(--text-dim)',
            margin: '0 0 16px',
            lineHeight: 1.5,
          }}>
            Pick a template, or wire up your own MCP-compatible service.
          </p>

          {/* Templates row */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: '20px',
          }}>
            {TEMPLATES.map(t => (
              <button
                key={t.label}
                onClick={() => { setNewName(t.label); setNewEndpoint(t.endpoint); }}
                title={t.description}
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '12px',
                  padding: '6px 12px',
                  borderRadius: '999px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input
              type="text"
              placeholder="Connector name (e.g. Anthropic image generation)"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '14px',
                padding: '10px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text)',
                outline: 'none',
              }}
            />
            <div>
              <input
                type="text"
                placeholder="MCP endpoint URL (e.g. https://api.example.com/v1/...)"
                value={newEndpoint}
                onChange={e => setNewEndpoint(e.target.value)}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '14px',
                  padding: '10px 14px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--text)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <p
                style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '4px 2px 0', lineHeight: 1.5 }}
                title="MCP (Model Context Protocol) is an open standard for letting AI assistants talk to external tools. The endpoint here is just a label for now — Manifex uses it to flag the capability in your spec, not to make live calls."
              >
                What's MCP? <span style={{ textDecoration: 'underline dotted', cursor: 'help' }}>An open standard for AI tool integrations</span> — Manifex uses this URL as a label for the capability, not to make live calls.
              </p>
            </div>
            <input
              type="password"
              placeholder="API Key"
              value={newApiKey}
              onChange={e => setNewApiKey(e.target.value)}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '14px',
                padding: '10px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text)',
                outline: 'none',
              }}
            />
            <div>
              <button
                onClick={addCustomConnector}
                disabled={!newName.trim() || !newEndpoint.trim()}
                className="mx-btn mx-btn-primary"
                style={{ padding: '10px 24px', fontSize: '14px' }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      </main>

      <footer style={{
        borderTop: '1px solid var(--border)',
        padding: '24px 32px',
        textAlign: 'center',
        fontSize: '13px',
        color: 'var(--text-dim)',
        fontFamily: 'var(--font-sans)',
      }}>
        Manifex by Manifex Labs
      </footer>
    </div>
  );
}
