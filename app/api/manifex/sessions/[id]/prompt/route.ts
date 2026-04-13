import { NextResponse } from 'next/server';
import { getSession, updateSession, makeManifestState } from '@/lib/store';
import { editManifest } from '@/lib/modal';
import type { ConversationMessage } from '@/lib/types';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const prompt: string = (body.prompt || '').trim();
  const image: { base64: string; media_type: string } | undefined = body.image;
  if (!prompt && !image) return NextResponse.json({ error: 'prompt or image required' }, { status: 400 });

  const conversationContext: ConversationMessage[] = body.conversationContext || [];

  let response;
  try {
    response = await editManifest(session.manifest_state, prompt, {
      conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
      image,
    });
  } catch (e: any) {
    const msg: string = e?.message || 'unknown error';
    const status: number = e?.status || 500;
    let userMessage = 'Something went wrong while thinking about your request.';
    let kind = 'unknown';
    if (status === 429 || /rate.?limit/i.test(msg)) {
      kind = 'rate_limit';
      userMessage = 'The model is rate-limited right now. Try again in a moment.';
    } else if (status === 401 || /api.?key/i.test(msg)) {
      kind = 'auth';
      userMessage = 'The Anthropic API key is missing or invalid. Check ANTHROPIC_API_KEY in .env.local.';
    } else if (/overload|529/i.test(msg)) {
      kind = 'overload';
      userMessage = 'The model is overloaded. Try again in a few seconds.';
    } else if (/content.?filter|safety/i.test(msg)) {
      kind = 'content_filter';
      userMessage = 'The model declined this request. Try rephrasing.';
    } else if (/timeout|ECONNRESET|fetch/i.test(msg)) {
      kind = 'network';
      userMessage = 'Lost connection to the model. Check your internet and try again.';
    }
    console.error('[prompt] editManifest failed:', kind, msg);
    return NextResponse.json({ error: userMessage, kind, detail: msg }, { status });
  }

  if (response.type === 'question') {
    // LLM asked a question — no doc changes, return question for the UI
    return NextResponse.json({
      session,
      response_type: 'question',
      message: response.result.message,
      questions: response.result.questions,
    });
  }

  // LLM updated docs — create pending attempt
  const proposed = makeManifestState(response.result.pages, response.result.tree);

  const updated = await updateSession(id, {
    pending_attempt: {
      prompt,
      proposed_manifest: proposed,
      diff_summary: response.result.diff_summary,
      changed_pages: response.result.changed_pages,
      attempt_number: 1,
    },
  });

  return NextResponse.json({
    session: updated,
    response_type: 'update',
    diff_summary: response.result.diff_summary,
  });
}
