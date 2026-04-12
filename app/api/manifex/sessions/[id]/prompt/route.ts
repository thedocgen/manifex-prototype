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

  const response = await editManifest(session.manifest_state, prompt, {
    conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
    image,
  });

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
