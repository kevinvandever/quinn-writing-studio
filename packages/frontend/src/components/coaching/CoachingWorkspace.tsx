import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { post } from '../../services/api-client';
import { createSSEStream, SSEHttpError, type ModelInfo, type DoneEvent } from '../../services/sse-client';
import { MessageBubble } from './MessageBubble';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model_used: string | null;
  model_reason: string | null;
  created_at: string;
  /** Client-only marker shown where one session ended and the next began. */
  divider?: boolean;
}

interface Session {
  id: string;
  project_id: string;
  session_type: string;
  summary: string | null;
  next_steps: string | null;
  started_at: string;
  ended_at: string | null;
}

interface SessionContext {
  sessionId: string;
  projectId: string;
  sessionType: string;
  project: {
    name: string;
    centralQuestion: string | null;
    description: string | null;
  };
  staleCorpus: boolean;
  inactivityDays: number | null;
  openingMessage: string | null;
}

/** Response of POST /api/projects/:id/sessions/current */
type CurrentSessionResponse =
  | { resumed: true; session: Session; messages: Message[] }
  | { resumed: false; session: SessionContext };

/** Turn a freshly started session's context into the Session shape the UI tracks. */
function sessionFromContext(ctx: SessionContext): Session {
  return {
    id: ctx.sessionId,
    project_id: ctx.projectId,
    session_type: ctx.sessionType,
    summary: null,
    next_steps: null,
    started_at: new Date().toISOString(),
    ended_at: null,
  };
}

function openerMessages(ctx: SessionContext): Message[] {
  if (!ctx.openingMessage) return [];
  return [
    {
      id: `opener-${Date.now()}`,
      role: 'assistant',
      content: ctx.openingMessage,
      model_used: null,
      model_reason: null,
      created_at: new Date().toISOString(),
    },
  ];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CoachingWorkspace() {
  const { id: projectId } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null);
  const [isEndingSession, setIsEndingSession] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  // Auto-scroll to bottom on new messages
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  // Start or resume session on mount
  useEffect(() => {
    if (!projectId) return;

    async function initSession() {
      setIsLoading(true);
      setError(null);

      try {
        // The server resumes the open session if it's still active, or closes
        // an idle one (saving Quinn's notes) and starts fresh.
        const current = await post<CurrentSessionResponse>(
          `/api/projects/${projectId}/sessions/current`,
          { session_type: 'coaching' }
        );

        if (current.resumed) {
          setSession(current.session);
          setMessages(current.messages);
        } else {
          setSessionContext(current.session);
          setSession(sessionFromContext(current.session));
          // If Quinn generated a proactive opening message, show it
          setMessages(openerMessages(current.session));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to initialize session';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }

    initSession();
  }, [projectId]);

  /**
   * Show the writer's message and stream Quinn's reply from the given session.
   * If the server says that session has ended (closed after going idle while
   * this page stayed open), start a new session and send the message there.
   */
  const streamMessage = useCallback(
    (targetSession: Session, content: string, isRetry = false) => {
      setIsStreaming(true);
      setStreamingContent('');
      setModelInfo(null);
      setError(null);

      // Add user message to the list immediately
      const tempId = `temp-${Date.now()}`;
      const userMessage: Message = {
        id: tempId,
        role: 'user',
        content,
        model_used: null,
        model_reason: null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Stream the response
      const stream = createSSEStream(`/api/sessions/${targetSession.id}/messages`, {
        body: { content },
        method: 'POST',
      });

      let fullContent = '';
      let streamedModel: ModelInfo | null = null;

      stream
        .onToken((token) => {
          fullContent += token;
          setStreamingContent(fullContent);
        })
        .onModelInfo((info) => {
          streamedModel = info;
          setModelInfo(info);
        })
        .onRetrying((event) => {
          setStreamingContent(`Quinn is in high demand right now — trying again (attempt ${event.attempt})...`);
        })
        .onDone((_event: DoneEvent) => {
          // Add the complete assistant message
          const assistantMessage: Message = {
            id: `temp-${Date.now()}-assistant`,
            role: 'assistant',
            content: fullContent,
            model_used: streamedModel?.model || null,
            model_reason: streamedModel?.reason || null,
            created_at: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, assistantMessage]);
          setStreamingContent('');
          setIsStreaming(false);
          setModelInfo(null);
        })
        .onError((err) => {
          if (err instanceof SSEHttpError && err.status === 409 && !isRetry && projectId) {
            void rollOverAndResend(targetSession, tempId, content);
            return;
          }
          setError(err.message);
          setIsStreaming(false);
          setStreamingContent('');
        });

      abortRef.current = () => stream.abort();
    },
    // rollOverAndResend (below) only uses state setters and projectId, so a
    // stale copy of it behaves the same as a fresh one.
    [projectId]
  );

  /**
   * The previous session closed while the page was open. Start a new one
   * (without Quinn's greeting, since the writer is mid-thought), mark the break
   * in the transcript, and send the message again.
   */
  async function rollOverAndResend(previous: Session, tempId: string, content: string) {
    try {
      const current = await post<CurrentSessionResponse>(
        `/api/projects/${projectId}/sessions/current`,
        { session_type: previous.session_type, skip_opener: true }
      );
      const next = current.resumed ? current.session : sessionFromContext(current.session);
      const divider: Message = {
        id: `divider-${Date.now()}`,
        role: 'system',
        content: 'Earlier session ended · Quinn saved her notes from it',
        model_used: null,
        model_reason: null,
        created_at: new Date().toISOString(),
        divider: true,
      };
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        divider,
        ...(current.resumed ? current.messages : []),
      ]);
      if (!current.resumed) setSessionContext(current.session);
      setSession(next);
      streamMessage(next, content, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start a new session');
      setIsStreaming(false);
      setStreamingContent('');
    }
  }

  // Send message handler. Pass overrideContent to send a command (e.g. /help)
  // without going through the input box.
  const handleSendMessage = useCallback(async (overrideContent?: string) => {
    const content = (overrideContent ?? inputValue).trim();
    if (!session || !content || isStreaming) return;

    if (overrideContent === undefined) setInputValue('');
    streamMessage(session, content);
  }, [session, inputValue, isStreaming, streamMessage]);

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // End session handler
  const handleEndSession = async () => {
    if (!session || isEndingSession) return;

    setIsEndingSession(true);
    setError(null);
    try {
      const result = await post<{ summary: string; next_steps: string }>(
        `/api/sessions/${session.id}/end`
      );
      setSession((prev) =>
        prev ? { ...prev, ended_at: new Date().toISOString(), summary: result.summary, next_steps: result.next_steps } : null
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to end session';
      setError(message);
    } finally {
      setIsEndingSession(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sage-600 mx-auto mb-4" />
          <p className="text-ink-muted font-serif italic">Starting coaching session...</p>
        </div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-red-700 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-sage-600 text-white rounded-lg hover:bg-sage-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-warm-200 bg-warm-50">
        <div>
          <h2 className="font-serif text-xl font-semibold text-ink">
            Coaching Session
          </h2>
          {sessionContext?.project && (
            <p className="text-sm text-ink-muted mt-0.5">{sessionContext.project.name}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {session && !session.ended_at && (
            <>
              <button
                onClick={() => handleSendMessage('/help')}
                disabled={isStreaming}
                className="px-3 py-2 text-sm font-medium text-sage-700 bg-sage-100 rounded-lg hover:bg-sage-200 transition-colors border border-sage-200 disabled:opacity-60 disabled:cursor-not-allowed"
                title="Show Quinn's structured coaching workflows"
              >
                Workflows
              </button>
              <button
                onClick={handleEndSession}
                disabled={isEndingSession}
                className="px-4 py-2 text-sm font-medium text-warm-700 bg-warm-200 rounded-lg hover:bg-warm-300 hover:text-ink transition-colors border border-warm-300 disabled:opacity-60 disabled:cursor-not-allowed"
                title="End this session and save Quinn's notes"
              >
                {isEndingSession ? 'Saving notes...' : 'End Session'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stale corpus / inactivity notices */}
      {sessionContext?.staleCorpus && (
        <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200">
          <p className="text-sm text-amber-800">
            📝 Your corpus hasn&apos;t been updated in a while. Consider re-importing your latest Scrivener project.
          </p>
        </div>
      )}
      {sessionContext?.inactivityDays && sessionContext.inactivityDays > 7 && (
        <div className="px-5 py-2.5 bg-sage-50 border-b border-sage-200">
          <p className="text-sm text-sage-800">
            👋 Welcome back! It&apos;s been {sessionContext.inactivityDays} days since your last session.
          </p>
        </div>
      )}

      {/* Session ended notice */}
      {session?.ended_at && (
        <div className="px-5 py-4 bg-warm-100 border-b border-warm-200">
          <p className="font-serif text-sm font-medium text-ink mb-1">Session complete</p>
          {session.summary && (
            <p className="text-sm text-ink-muted leading-relaxed">{session.summary}</p>
          )}
          {session.next_steps && (
            <p className="text-sm text-ink-muted mt-2">
              <span className="font-medium text-ink">Next time:</span> {session.next_steps}
            </p>
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-ink-muted mt-12">
            <p className="text-3xl mb-3">🖋️</p>
            <p className="font-serif text-lg text-ink">What are we working on today?</p>
            <p className="text-sm mt-2 text-warm-500">Quinn is ready when you are.</p>
            <p className="text-sm mt-1 text-warm-500">
              Tip: type <span className="font-mono text-sage-700">/help</span> (or tap Workflows) to run a structured session like Essay Triage or an Editorial Pass.
            </p>
          </div>
        )}

        {messages
          .filter((m) => m.role !== 'system' || m.divider)
          .map((message) =>
            message.divider ? (
              <div key={message.id} className="flex items-center gap-3 py-1" role="separator">
                <div className="flex-1 border-t border-warm-300" />
                <span className="text-xs text-warm-500">{message.content}</span>
                <div className="flex-1 border-t border-warm-300" />
              </div>
            ) : (
              <MessageBubble key={message.id} message={message} />
            )
          )}

        {/* Streaming response */}
        {isStreaming && streamingContent && (
          <MessageBubble
            message={{
              id: 'streaming',
              role: 'assistant',
              content: streamingContent,
              model_used: modelInfo?.model || null,
              model_reason: modelInfo?.reason || null,
              created_at: new Date().toISOString(),
            }}
            isStreaming
          />
        )}

        {/* Loading indicator while waiting for first token */}
        {isStreaming && !streamingContent && (
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-sage-100 flex items-center justify-center flex-shrink-0">
              <span className="text-sm">🖋️</span>
            </div>
            <div className="bg-warm-100 rounded-2xl rounded-tl-sm px-5 py-3">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-sage-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-sage-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-sage-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {session && !session.ended_at && (
        <div className="border-t border-warm-200 bg-warm-50 px-5 py-4">
          {error && (
            <p className="text-sm text-red-700 mb-2">{error}</p>
          )}
          <div className="flex items-end gap-3">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What's on your mind... (type /help for workflows)"
              className="flex-1 resize-none rounded-xl border border-warm-300 bg-white px-4 py-3 text-coaching text-ink placeholder:text-warm-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent min-h-[48px] max-h-[200px] transition-shadow"
              rows={1}
              disabled={isStreaming}
              aria-label="Message input"
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={!inputValue.trim() || isStreaming}
              className="px-4 py-3 bg-sage-600 text-white rounded-xl hover:bg-sage-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
              aria-label="Send message"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
