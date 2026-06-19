import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../../services/api-client';
import { createSSEStream, type ModelInfo, type DoneEvent } from '../../services/sse-client';
import { MessageBubble } from './MessageBubble';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model_used: string | null;
  model_reason: string | null;
  created_at: string;
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
        // Try to find an active session for this project
        const response = await get<{
          sessions: Session[];
          pagination: { total: number };
        }>(`/api/projects/${projectId}/sessions?limit=1`);

        const activeSession = response.sessions.find((s) => !s.ended_at);

        if (activeSession) {
          // Resume existing session
          const sessionData = await get<{ session: Session; messages: Message[] }>(
            `/api/sessions/${activeSession.id}`
          );
          setSession(sessionData.session);
          setMessages(sessionData.messages);
        } else {
          // Start a new session
          const newSession = await post<{ session: SessionContext }>(
            `/api/projects/${projectId}/sessions`,
            { session_type: 'coaching' }
          );
          setSessionContext(newSession.session);
          setSession({
            id: newSession.session.sessionId,
            project_id: newSession.session.projectId,
            session_type: newSession.session.sessionType,
            summary: null,
            next_steps: null,
            started_at: new Date().toISOString(),
            ended_at: null,
          });
          // If Quinn generated a proactive opening message, show it
          if (newSession.session.openingMessage) {
            setMessages([
              {
                id: `opener-${Date.now()}`,
                role: 'assistant',
                content: newSession.session.openingMessage,
                model_used: null,
                model_reason: null,
                created_at: new Date().toISOString(),
              },
            ]);
          } else {
            setMessages([]);
          }
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

  // Send message handler. Pass overrideContent to send a command (e.g. /help)
  // without going through the input box.
  const handleSendMessage = useCallback(async (overrideContent?: string) => {
    const content = (overrideContent ?? inputValue).trim();
    if (!session || !content || isStreaming) return;

    if (overrideContent === undefined) setInputValue('');
    setIsStreaming(true);
    setStreamingContent('');
    setModelInfo(null);

    // Add user message to the list immediately
    const userMessage: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      model_used: null,
      model_reason: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);

    // Stream the response
    const stream = createSSEStream(`/api/sessions/${session.id}/messages`, {
      body: { content },
      method: 'POST',
    });

    let fullContent = '';

    stream
      .onToken((token) => {
        fullContent += token;
        setStreamingContent(fullContent);
      })
      .onModelInfo((info) => {
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
          model_used: modelInfo?.model || null,
          model_reason: modelInfo?.reason || null,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setStreamingContent('');
        setIsStreaming(false);
        setModelInfo(null);
      })
      .onError((err) => {
        setError(err.message);
        setIsStreaming(false);
        setStreamingContent('');
      });

    abortRef.current = () => stream.abort();
  }, [session, inputValue, isStreaming, modelInfo]);

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
          .filter((m) => m.role !== 'system')
          .map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

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
