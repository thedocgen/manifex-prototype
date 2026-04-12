'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ManifexProject } from '@/lib/types';

const TEMPLATES = [
  { name: 'Class Quiz', prompt: 'Make a class quiz app where a teacher can create multiple-choice questions and students can take the quiz and see their score at the end.' },
  { name: 'Birthday RSVP', prompt: 'Make a birthday party RSVP page where guests can see the party details (date, time, location, theme) and respond yes/no with how many people they\'re bringing.' },
  { name: 'Chore Tracker', prompt: 'Make a family chore tracker where parents can assign chores to kids, kids can check them off, and everyone can see a weekly progress chart.' },
  { name: 'Study Planner', prompt: 'Make a study planner where students can add subjects, schedule study sessions on a weekly calendar, and track hours studied per subject.' },
  { name: 'Wedding RSVP', prompt: 'Make a wedding RSVP page with event details, a form for guests to confirm attendance, meal preference, and any dietary needs.' },
  { name: 'Habit Tracker', prompt: 'Make a daily habit tracker where I can add habits, check them off each day, and see a streak counter and monthly calendar view of my progress.' },
  { name: 'Recipe Collection', prompt: 'Make a personal recipe collection app where I can add recipes with ingredients and steps, search by name, and filter by category (breakfast, dinner, dessert, etc.).' },
  { name: 'Soccer Signup', prompt: 'Make a soccer team signup page where players can register with their name, age, position preference, and parents can add emergency contact info.' },
  { name: 'Reading Log', prompt: 'Make a reading log where I can add books I\'ve read with title, author, rating, and notes. Show my total books read this year and a list sorted by date.' },
  { name: 'Event Registration', prompt: 'Make an event registration page where organizers set the event details and attendees can register with their name, email, and select which sessions they want to attend.' },
];

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

export default function HomePage() {
  const router = useRouter();
  const [builds, setBuilds] = useState<ManifexProject[]>([]);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    const res = await fetch('/api/manifex/projects');
    const data = await res.json();
    setBuilds(data.projects || []);
    setLoaded(true);
  };

  useEffect(() => { load(); }, []);

  const openBuild = async (projectId: string) => {
    const res = await fetch(`/api/manifex/projects/${projectId}/sessions`, { method: 'POST' });
    const data = await res.json();
    if (data.session) router.push(`/${data.session.id}`);
  };

  const createFromPrompt = async (buildPrompt: string, buildName?: string) => {
    if (!buildPrompt.trim()) return;
    setCreating(true);
    try {
      const name = buildName || buildPrompt.slice(0, 60).replace(/[^\w\s]/g, '').trim();
      const res = await fetch('/api/manifex/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.project) {
        // Create session
        const sessRes = await fetch(`/api/manifex/projects/${data.project.id}/sessions`, { method: 'POST' });
        const sessData = await sessRes.json();
        if (sessData.session) {
          // Send the initial prompt to the session
          await fetch(`/api/manifex/sessions/${sessData.session.id}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: buildPrompt }),
          });
          router.push(`/${sessData.session.id}`);
        }
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* Hero section */}
      <main style={{ maxWidth: '800px', margin: '0 auto', padding: '80px 32px 48px' }}>
        <div style={{ textAlign: 'center', marginBottom: '48px' }}>
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '52px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: '0 0 12px',
            lineHeight: 1.1,
            color: 'var(--text)',
          }}>
            Manifex
          </h1>
          <p style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '24px',
            fontWeight: 400,
            color: 'var(--text-muted)',
            margin: '0 0 8px',
            fontStyle: 'italic',
          }}>
            Tell it. Get it.
          </p>
          <p style={{
            fontSize: '16px',
            color: 'var(--text-dim)',
            margin: '0 0 40px',
            lineHeight: 1.5,
          }}>
            Describe what you want and watch it come to life.<br />
            No code. No templates. Just your words.
          </p>

          {/* Main prompt input */}
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '16px',
            padding: '20px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.04)',
          }}>
            <textarea
              data-testid="home-prompt-input"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  createFromPrompt(prompt);
                }
              }}
              placeholder="What do you want to build? Try: Make a chore chart for my kids"
              disabled={creating}
              rows={2}
              style={{
                width: '100%',
                resize: 'none',
                fontFamily: 'var(--font-sans)',
                fontSize: '16px',
                border: 'none',
                background: 'transparent',
                padding: '0',
                marginBottom: '12px',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                data-testid="home-create-btn"
                onClick={() => createFromPrompt(prompt)}
                disabled={!prompt.trim() || creating}
                className="mx-btn mx-btn-primary"
                style={{ padding: '12px 24px', fontSize: '15px' }}
              >
                {creating ? <><span className="mx-spinner" /> Building…</> : 'Tell me →'}
              </button>
            </div>
          </div>
        </div>

        {/* Templates gallery */}
        <div style={{ marginBottom: '64px' }}>
          <h2 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '20px',
            fontWeight: 600,
            color: 'var(--text-muted)',
            margin: '0 0 20px',
            textAlign: 'center',
          }}>
            Or start with an idea
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '12px',
          }}>
            {TEMPLATES.map(t => (
              <button
                key={t.name}
                onClick={() => createFromPrompt(t.prompt, t.name)}
                disabled={creating}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: '12px',
                  padding: '16px',
                  cursor: 'pointer',
                  textAlign: 'center',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: 'var(--text)',
                  transition: 'all 0.15s ease',
                  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
                }}
                onMouseEnter={e => {
                  (e.target as HTMLElement).style.borderColor = 'var(--accent)';
                  (e.target as HTMLElement).style.transform = 'translateY(-2px)';
                  (e.target as HTMLElement).style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.06)';
                }}
                onMouseLeave={e => {
                  (e.target as HTMLElement).style.borderColor = 'var(--border)';
                  (e.target as HTMLElement).style.transform = 'none';
                  (e.target as HTMLElement).style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.04)';
                }}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>

        {/* Existing builds */}
        {loaded && builds.length > 0 && (
          <div>
            <h2 style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '20px',
              fontWeight: 600,
              color: 'var(--text)',
              margin: '0 0 16px',
            }}>
              Your Builds
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {builds.map(b => (
                <div
                  key={b.id}
                  className="mx-card"
                  onClick={() => openBuild(b.id)}
                  data-testid={`build-${b.id}`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <h3 style={{
                      fontFamily: 'var(--font-serif)',
                      fontSize: '18px',
                      fontWeight: 600,
                      margin: 0,
                    }}>{b.name}</h3>
                    <span style={{ fontSize: '13px', color: 'var(--text-dim)' }}>{timeAgo(b.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer with lab brand */}
      <footer style={{
        borderTop: '1px solid var(--border)',
        padding: '24px 32px',
        textAlign: 'center',
        fontSize: '13px',
        color: 'var(--text-dim)',
      }}>
        <span>Manifex by Manifex Labs · Documentation as code</span>
        <span style={{ margin: '0 8px' }}>·</span>
        <a href="/about" style={{ color: 'var(--text-dim)', textDecoration: 'underline' }}>
          Why is Manifex different?
        </a>
      </footer>
    </div>
  );
}
