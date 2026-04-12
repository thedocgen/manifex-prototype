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
  if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 });

  // Client passes recent conversation for multi-turn context
  const conversationContext: ConversationMessage[] = body.conversationContext || [];

  const response = await editManifest(session.manifest_state, prompt, {
    conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
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
