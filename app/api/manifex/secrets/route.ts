import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_PROJECT_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function client() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

// In-memory fallback when manifex_secrets table doesn't exist yet
const memorySecrets: Map<string, { key: string; value: string; created_at: string }> = new Map();

// Store a secret
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { project_id, key, value } = body;
  if (!project_id || !key || !value) {
    return NextResponse.json({ error: 'project_id, key, and value required' }, { status: 400 });
  }

  // Try Supabase first, fall back to in-memory
  const { error } = await client()
    .from('manifex_secrets')
    .upsert({ project_id, key, value }, { onConflict: 'project_id,key' });

  if (error) {
    // Table might not exist — use in-memory fallback
    console.warn('manifex_secrets write error (using memory fallback):', error.message);
    memorySecrets.set(`${project_id}:${key}`, { key, value, created_at: new Date().toISOString() });
  }

  return NextResponse.json({ success: true, key });
}

// List secret keys for a project (no values)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');
  if (!projectId) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 });
  }

  const { data, error } = await client()
    .from('manifex_secrets')
    .select('key, created_at')
    .eq('project_id', projectId);

  if (error) {
    // Fallback to in-memory
    const results: { key: string; created_at: string }[] = [];
    for (const [k, v] of memorySecrets) {
      if (k.startsWith(`${projectId}:`)) results.push({ key: v.key, created_at: v.created_at });
    }
    return NextResponse.json({ secrets: results });
  }

  return NextResponse.json({ secrets: (data || []).map(s => ({ key: s.key, created_at: s.created_at })) });
}
