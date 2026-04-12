'use client';
import { useState } from 'react';
import { Brand } from '@/components/Brand';

interface Connector {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  endpoint?: string;
}

const BUILTIN_CONNECTORS: Connector[] = [
  {
    id: 'image-gen',
    name: 'Image Generation',
    description: 'Generate images for your app',
    enabled: false,
    builtin: true,
  },
  {
    id: 'deploy',
    name: 'Deploy',
    description: 'Publish your app to a live URL',
    enabled: false,
    builtin: true,
  },
  {
    id: 'database',
    name: 'Database',
    description: 'Connect to external data storage',
    enabled: false,
    builtin: true,
  },
];

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<Connector[]>(BUILTIN_CONNECTORS);
  const [newName, setNewName] = useState('');
  const [newEndpoint, setNewEndpoint] = useState('');
  const [newApiKey, setNewApiKey] = useState('');

  const toggleConnector = (id: string) => {
    setConnectors(prev =>
      prev.map(c => (c.id === id ? { ...c, enabled: !c.enabled } : c))
    );
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
          margin: '0 0 40px',
        }}>
          Add external tools and services that Manifex can use when building your apps.
        </p>

        {/* Connector list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '48px' }}>
          {connectors.map(c => (
            <div
              key={c.id}
              className="mx-card"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'default',
              }}
            >
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 4px', color: 'var(--text)' }}>
                  {c.name}
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--text-dim)', margin: 0 }}>
                  {c.description}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
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
            margin: '0 0 20px',
            lineHeight: 1.5,
          }}>
            Connect any MCP-compatible service by providing its endpoint URL.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input
              type="text"
              placeholder="Connector name"
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
            <input
              type="text"
              placeholder="MCP Endpoint URL"
              value={newEndpoint}
              onChange={e => setNewEndpoint(e.target.value)}
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
