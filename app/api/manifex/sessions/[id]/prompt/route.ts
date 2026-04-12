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

  // Build conversation context for multi-turn flows
  // Include recent messages so the LLM can see Q&A exchanges
  const recentConversation = session.conversation.slice(-6); // last 3 exchanges max

  const response = await editManifest(session.manifest_state, prompt, {
    conversationContext: recentConversation.length > 0 ? recentConversation : undefined,
  });

  // Add user message to conversation
  const userMsg: ConversationMessage = {
    role: 'user',
    content: prompt,
    timestamp: new Date().toISOString(),
  };

  if (response.type === 'question') {
    // LLM asked a question — add both messages to conversation, no doc changes
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: response.result.message,
      questions: response.result.questions,
      timestamp: new Date().toISOString(),
    };

    const updated = await updateSession(id, {
      conversation: [...session.conversation, userMsg, assistantMsg],
    });

    return NextResponse.json({
      session: updated,
      response_type: 'question',
      message: response.result.message,
      questions: response.result.questions,
    });
  }

  // LLM updated docs — create pending attempt
  const proposed = makeManifestState(response.result.pages, response.result.tree);

  const assistantMsg: ConversationMessage = {
    role: 'assistant',
    content: response.result.diff_summary,
    timestamp: new Date().toISOString(),
  };

  const updated = await updateSession(id, {
    conversation: [...session.conversation, userMsg, assistantMsg],
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
  });
}
