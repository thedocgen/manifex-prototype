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
  const enabledConnectors: string[] = Array.isArray(body.connectors)
    ? body.connectors.filter((c: any) => typeof c === 'string')
    : [];
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
    // Compact request id so log lines from concurrent requests stay readable.
    const reqId = Math.random().toString(36).slice(2, 8);
    const log = (msg: string) => console.log(`[prompt-sse ${reqId} ${id.slice(0, 8)}] ${msg}`);
    const encoder = new TextEncoder();
    let controllerClosed = false;

    log('start');

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: any) => {
          if (controllerClosed) {
            log(`send(${event}) skipped — controller already closed`);
            return false;
          }
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
            log(`sent event=${event}`);
            return true;
          } catch (e: any) {
            log(`send(${event}) threw: ${e?.message}`);
            controllerClosed = true;
            return false;
          }
        };
        const safeClose = () => {
          if (controllerClosed) return;
          try { controller.close(); } catch {}
          controllerClosed = true;
        };

        try {
          // Pass 1 — shallow scaffold.
          log('shallow start');
          const shallowStarted = Date.now();
          let shallow;
          try {
            shallow = await editManifestShallow(session.manifest_state, prompt, {
              conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
              enabledConnectors: enabledConnectors.length > 0 ? enabledConnectors : undefined,
            });
            log(`shallow returned type=${shallow.type} pages=${Object.keys((shallow as any).result?.pages || {}).length}`);
          } catch (e: any) {
            // The shallow tool sometimes refuses for first-prompt clarification —
            // fall through to the deep pass directly.
            console.warn(`[prompt-sse ${reqId}] shallow failed, falling through to deep:`, e?.message);
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
          //
          // Race against a hard timeout. The Anthropic SDK has its own
          // timeouts but we've seen deep calls hang indefinitely. Without
          // this race, an unresolved deep call leaves pending_attempt.
          // draft=true forever and the user is stuck with a non-clickable
          // 'Refining content…' pill.
          const DEEP_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes — safety net; the prompt-level narrow-edit allowance should make most deep passes return in 30-90s.
          log(`deep start hasShallowDraft=${!!shallowDraft}`);
          const deepStarted = Date.now();
          let deep;
          let deepFailure: { kind: string; userMessage: string; detail: string } | null = null;
          try {
            const deepPromise = editManifest(session.manifest_state, prompt, {
              conversationContext: conversationContext.length > 0 ? conversationContext : undefined,
              shallowDraft,
              enabledConnectors: enabledConnectors.length > 0 ? enabledConnectors : undefined,
            });
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`deep pass timed out after ${DEEP_TIMEOUT_MS}ms`)), DEEP_TIMEOUT_MS);
            });
            deep = await Promise.race([deepPromise, timeoutPromise]);
            log(`deep returned type=${deep.type} after ${Date.now() - deepStarted}ms`);
          } catch (e: any) {
            const cls = classifyError(e);
            // Override the user-facing message for the bare-timeout case.
            if (/deep pass timed out/i.test(cls.detail)) {
              cls.kind = 'timeout';
              cls.userMessage = 'The deep refinement is taking unusually long. The structure draft is still here — click Try again to retry, or Never mind to discard.';
            }
            log(`deep editManifest failed kind=${cls.kind} detail=${cls.detail}`);
            deepFailure = { kind: cls.kind, userMessage: cls.userMessage, detail: cls.detail };
          }

          // Recovery path: deep pass failed. We MUST clear pending_attempt.
          // draft so the UI unsticks. Three options for what to do with
          // the existing shallow draft:
          //   1. Drop pending_attempt entirely → user loses the draft.
          //   2. Mark draft=false and keep the shallow content → user can
          //      click Looks good but compiles a half-baked spec.
          //   3. Mark draft=false but flag the proposed_manifest with an
          //      'incomplete' marker so the UI shows a Try again CTA.
          // Going with #2: it's the simplest unstick, and the assistant
          // message we persist alongside it tells the user the deep pass
          // failed and Try again is the right next action.
          if (deepFailure) {
            const nowIsoFail = new Date().toISOString();
            const userMessage: ConversationMessage = {
              role: 'user',
              content: prompt,
              answers: body.answers,
              timestamp: nowIsoFail,
            };
            const errorAssistant: ConversationMessage = {
              role: 'assistant',
              content: deepFailure.userMessage,
              timestamp: nowIsoFail,
            };
            // Replay the conversation: existing + user + (draft assistant if it ran) + error
            const conversationWithError: ConversationMessage[] = [...existingConversation, userMessage];
            if (shallowResult) {
              conversationWithError.push({
                role: 'assistant',
                content: shallowResult.diff_summary || 'Drafting structure…',
                diff_summary: shallowResult.diff_summary,
                changed_pages: shallowResult.changed_pages,
                timestamp: nowIsoFail,
              });
            }
            conversationWithError.push(errorAssistant);

            const recoveryManifest = {
              ...session.manifest_state,
              conversation: conversationWithError,
            };

            // Refetch to get the row's current pending_attempt (with the
            // shallow draft populated by the earlier write) and set draft=false.
            const refreshed = await getSession(id);
            const existingPending = refreshed?.pending_attempt;
            const recoveryPending = existingPending
              ? { ...existingPending, draft: false }
              : null;

            try {
              log('recovery write start');
              const recovered = await updateSession(id, {
                manifest_state: recoveryManifest,
                pending_attempt: recoveryPending,
              });
              log(`recovery write ok draft=${recovered.pending_attempt?.draft}`);
              send('error', {
                error: deepFailure.userMessage,
                kind: deepFailure.kind,
                detail: deepFailure.detail,
                session: recovered,
              });
            } catch (recoveryErr: any) {
              log(`recovery write failed: ${recoveryErr?.message}`);
              send('error', {
                error: deepFailure.userMessage,
                kind: deepFailure.kind,
                detail: deepFailure.detail,
              });
            }
            safeClose();
            return;
          }

          if (!deep) {
            // Defensive: should be unreachable since deepFailure handles all error paths.
            log('deep result is undefined with no failure recorded — defensive');
            send('error', { error: 'Internal error: deep pass produced no result', kind: 'unknown' });
            safeClose();
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
            log('deep returned question — persisting + clearing pending');
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
            log(`question write ok pending_now=${!!updated.pending_attempt}`);
            send('complete', {
              session: updated,
              response_type: 'question',
              message: deep.result.message,
              questions: deep.result.questions,
            });
            safeClose();
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
          log('update write start');
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
          log(`update write ok draft=${updated.pending_attempt?.draft} after ${deepMs}ms`);
          send('complete', {
            session: updated,
            response_type: 'update',
            diff_summary: deep.result.diff_summary,
            elapsed_ms: deepMs,
          });
          safeClose();
        } catch (outer: any) {
          log(`stream crashed: ${outer?.message}`);
          // Last-resort recovery: clear any draft flag the inner code may
          // have left set so the session doesn't lock the UI.
          try {
            log('outer recovery: refetching session');
            const refreshed = await getSession(id);
            if (refreshed?.pending_attempt?.draft) {
              log('outer recovery: clearing draft flag');
              await updateSession(id, {
                pending_attempt: { ...refreshed.pending_attempt, draft: false },
              });
              log('outer recovery write ok');
            } else {
              log(`outer recovery: nothing to clear (pending=${!!refreshed?.pending_attempt} draft=${refreshed?.pending_attempt?.draft})`);
            }
          } catch (recErr: any) {
            log(`outer recovery write failed: ${recErr?.message}`);
          }
          send('error', { error: outer?.message || 'stream crashed' });
          safeClose();
        } finally {
          log('start() finally');
        }
      },
      cancel(reason) {
        // Fires when the consumer (browser) closes the stream early. Helps
        // distinguish 'client disconnected mid-deep' from 'server stalled'.
        log(`stream cancelled by consumer: ${reason || '(no reason)'}`);
        controllerClosed = true;
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
      enabledConnectors: enabledConnectors.length > 0 ? enabledConnectors : undefined,
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
