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

  // Optimistic concurrency: if the client tells us which manifest sha they
  // were looking at, refuse to apply when someone else has moved the
  // session forward. Without expected_sha we trust the caller (legacy clients).
  const expectedSha: string | undefined = body.expected_sha;
  if (expectedSha && expectedSha !== session.manifest_state.sha) {
    return NextResponse.json({
      error: 'The docs have changed since you loaded them. Refresh to see the latest, then try again.',
      kind: 'sha_conflict',
      current_sha: session.manifest_state.sha,
      expected_sha: expectedSha,
      session,
    }, { status: 409 });
  }

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

  // Build the new conversation state on the server so this write is the
  // single source of truth for "turn N completed". We append the user's
  // message and the resulting assistant message to the existing
  // manifest_state.conversation (the authoritative copy), then persist
  // it atomically alongside pending_attempt. This eliminates the race
  // between the client's /conversation persist POST and the /prompt
  // updateSession — both used to touch overlapping parts of the row and
  // occasionally left the local UI out of sync.
  const nowIso = new Date().toISOString();
  const existingConversation: ConversationMessage[] = Array.isArray(session.manifest_state?.conversation)
    ? session.manifest_state.conversation
    : [];
  const userMessage: ConversationMessage = {
    role: 'user',
    content: prompt,
    answers: body.answers,
    timestamp: nowIso,
  };

  if (response.type === 'question') {
    // LLM asked a question — no doc changes, but we still persist both
    // messages so the conversation survives a refresh.
    const assistantMessage: ConversationMessage = {
      role: 'assistant',
      content: response.result.message,
      questions: response.result.questions,
      timestamp: nowIso,
    };
    const updatedManifest = {
      ...session.manifest_state,
      conversation: [...existingConversation, userMessage, assistantMessage],
    };
    const updated = await updateSession(id, { manifest_state: updatedManifest });
    return NextResponse.json({
      session: updated,
      response_type: 'question',
      message: response.result.message,
      questions: response.result.questions,
    });
  }

  // LLM updated docs — create pending attempt AND append both messages
  // to the conversation in one write.
  const proposed = makeManifestState(response.result.pages, response.result.tree);
  const assistantMessage: ConversationMessage = {
    role: 'assistant',
    content: response.result.diff_summary || 'Changes applied.',
    diff_summary: response.result.diff_summary,
    changed_pages: response.result.changed_pages,
    timestamp: nowIso,
  };
  const updatedManifest = {
    ...session.manifest_state,
    conversation: [...existingConversation, userMessage, assistantMessage],
  };

  const updated = await updateSession(id, {
    manifest_state: updatedManifest,
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
