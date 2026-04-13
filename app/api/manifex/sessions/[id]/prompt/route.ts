import { NextResponse } from 'next/server';
import { getSession, updateSession, makeManifestState } from '@/lib/store';
import { editManifest, editManifestShallow } from '@/lib/modal';
import type { ConversationMessage, DocPage, TreeNode } from '@/lib/types';

function classifyError(e: any): { status: number; kind: string; userMessage: string; detail: string } {
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
  return { status, kind, userMessage, detail: msg };
}

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
  const acceptHeader = req.headers.get('accept') || '';
  const wantsSse = acceptHeader.includes('text/event-stream');
  const existingConversation: ConversationMessage[] = Array.isArray(session.manifest_state?.conversation)
    ? session.manifest_state.conversation
    : [];

  // ─────────────────────────────────────────────────────────────────────
  // SSE (two-pass) branch
  // ─────────────────────────────────────────────────────────────────────
  // When the client opts in via Accept: text/event-stream, we run the
  // shallow scaffold pass first (~15-30s), persist + stream the draft,
  // then run the deep pass (~60-180s), persist + stream the complete
  // response. Single connection, two events. Image uploads still use
  // the non-SSE path because they go straight to the deep pass.
  if (wantsSse && !image) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: any) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        };

        try {
          // Pass 1 — shallow scaffold.
          const shallowStarted = Date.now();
          let shallow;
          try {
            shallow = await editManifestShallow(session.manifest_state, prompt, {
              conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
            });
          } catch (e: any) {
            // The shallow tool sometimes refuses for first-prompt clarification —
            // fall through to the deep pass directly.
            console.warn('[prompt-sse] shallow failed, falling through to deep:', e?.message);
            shallow = null;
          }

          let shallowDraft: { pages: { [path: string]: DocPage }; tree: TreeNode[] } | undefined;
          let shallowResult: any = null;

          if (shallow && shallow.type === 'update') {
            const draftProposed = makeManifestState(shallow.result.pages, shallow.result.tree);
            const nowIso = new Date().toISOString();
            const userMessage: ConversationMessage = {
              role: 'user',
              content: prompt,
              answers: body.answers,
              timestamp: nowIso,
            };
            const draftAssistant: ConversationMessage = {
              role: 'assistant',
              content: shallow.result.diff_summary || 'Drafting structure…',
              diff_summary: shallow.result.diff_summary,
              changed_pages: shallow.result.changed_pages,
              timestamp: nowIso,
            };
            const draftManifest = {
              ...session.manifest_state,
              conversation: [...existingConversation, userMessage, draftAssistant],
            };
            const updated = await updateSession(id, {
              manifest_state: draftManifest,
              pending_attempt: {
                prompt,
                proposed_manifest: draftProposed,
                diff_summary: shallow.result.diff_summary,
                changed_pages: shallow.result.changed_pages,
                attempt_number: 1,
                draft: true,
              },
            });
            shallowDraft = { pages: shallow.result.pages, tree: shallow.result.tree };
            shallowResult = shallow.result;
            const shallowMs = Date.now() - shallowStarted;
            console.log(`[prompt-sse] shallow pass finished in ${shallowMs}ms (${Object.keys(shallow.result.pages).length} pages)`);
            send('draft', {
              session: updated,
              response_type: 'draft_update',
              diff_summary: shallow.result.diff_summary,
              elapsed_ms: shallowMs,
            });
          }

          // Pass 2 — deep refinement. If the shallow pass succeeded, deepen
          // the same tree; otherwise this is the first LLM call.
          const deepStarted = Date.now();
          let deep;
          try {
            deep = await editManifest(session.manifest_state, prompt, {
              conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
              shallowDraft,
            });
          } catch (e: any) {
            const cls = classifyError(e);
            console.error('[prompt-sse] deep editManifest failed:', cls.kind, cls.detail);
            send('error', { error: cls.userMessage, kind: cls.kind, detail: cls.detail });
            controller.close();
            return;
          }

          const nowIso = new Date().toISOString();
          const userMessage: ConversationMessage = {
            role: 'user',
            content: prompt,
            answers: body.answers,
            timestamp: nowIso,
          };

          if (deep.type === 'question') {
            // The deep pass turned into a clarifying question after all.
            // Persist the question (overwriting the draft pending_attempt)
            // and stream a 'complete' event with the question payload.
            const assistantMessage: ConversationMessage = {
              role: 'assistant',
              content: deep.result.message,
              questions: deep.result.questions,
              timestamp: nowIso,
            };
            const finalManifest = {
              ...session.manifest_state,
              conversation: [...existingConversation, userMessage, assistantMessage],
            };
            const updated = await updateSession(id, {
              manifest_state: finalManifest,
              pending_attempt: null,
            });
            send('complete', {
              session: updated,
              response_type: 'question',
              message: deep.result.message,
              questions: deep.result.questions,
            });
            controller.close();
            return;
          }

          const proposed = makeManifestState(deep.result.pages, deep.result.tree);
          const assistantMessage: ConversationMessage = {
            role: 'assistant',
            content: deep.result.diff_summary || 'Changes applied.',
            diff_summary: deep.result.diff_summary,
            changed_pages: deep.result.changed_pages,
            timestamp: nowIso,
          };
          const finalManifest = {
            ...session.manifest_state,
            conversation: [...existingConversation, userMessage, assistantMessage],
          };
          const updated = await updateSession(id, {
            manifest_state: finalManifest,
            pending_attempt: {
              prompt,
              proposed_manifest: proposed,
              diff_summary: deep.result.diff_summary,
              changed_pages: deep.result.changed_pages,
              attempt_number: 1,
              draft: false,
            },
          });
          const deepMs = Date.now() - deepStarted;
          console.log(`[prompt-sse] deep pass finished in ${deepMs}ms (${Object.keys(deep.result.pages).length} pages)`);
          send('complete', {
            session: updated,
            response_type: 'update',
            diff_summary: deep.result.diff_summary,
            elapsed_ms: deepMs,
          });
          controller.close();
        } catch (outer: any) {
          console.error('[prompt-sse] stream crashed:', outer?.message);
          try { controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: outer?.message || 'stream crashed' })}\n\n`)); } catch {}
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Non-SSE (legacy single-pass) branch
  // ─────────────────────────────────────────────────────────────────────
  let response;
  try {
    response = await editManifest(session.manifest_state, prompt, {
      conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
      image,
    });
  } catch (e: any) {
    const cls = classifyError(e);
    console.error('[prompt] editManifest failed:', cls.kind, cls.detail);
    return NextResponse.json({ error: cls.userMessage, kind: cls.kind, detail: cls.detail }, { status: cls.status });
  }

  const nowIso = new Date().toISOString();
  const userMessage: ConversationMessage = {
    role: 'user',
    content: prompt,
    answers: body.answers,
    timestamp: nowIso,
  };

  if (response.type === 'question') {
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
      draft: false,
    },
  });

  return NextResponse.json({
    session: updated,
    response_type: 'update',
    diff_summary: response.result.diff_summary,
  });
}
