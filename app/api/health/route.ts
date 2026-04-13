import { NextResponse } from 'next/server';

export async function GET() {
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasSupabaseUrl = !!process.env.SUPABASE_PROJECT_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_KEY;

  return NextResponse.json({
    ok: true,
    uptime_seconds: Math.round(process.uptime()),
    pid: process.pid,
    node: process.version,
    env: {
      anthropic_key: hasAnthropicKey,
      supabase_url: hasSupabaseUrl,
      supabase_key: hasSupabaseKey,
    },
    timestamp: new Date().toISOString(),
  });
}
