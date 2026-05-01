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
          setMessages([]);
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

  // Send message handler
  const handleSendMessage = useCallback(async () => {
    if (!session || !inputValue.trim() || isStreaming) return;

    const content = inputValue.trim();
    setInputValue('');
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
    if (!session) return;

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
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto mb-4" />
          <p className="text-gray-600">Starting coaching session...</p>
        </div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Coaching Session
          </h2>
          {sessionContext?.project && (
            <p className="text-sm text-gray-500">{sessionContext.project.name}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {session && !session.ended_at && (
            <button
              onClick={handleEndSession}
              className="px-3 py-1.5 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              End Session
            </button>
          )}
        </div>
      </div>

      {/* Stale corpus / inactivity notices */}
      {sessionContext?.staleCorpus && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200">
          <p className="text-sm text-amber-800">
            📝 Your corpus hasn&apos;t been updated in a while. Consider re-importing your latest Scrivener project.
          </p>
        </div>
      )}
      {sessionContext?.inactivityDays && sessionContext.inactivityDays > 7 && (
        <div className="px-4 py-2 bg-blue-50 border-b border-blue-200">
          <p className="text-sm text-blue-800">
            👋 Welcome back! It&apos;s been {sessionContext.inactivityDays} days since your last session.
          </p>
        </div>
      )}

      {/* Session ended notice */}
      {session?.ended_at && (
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <p className="text-sm font-medium text-gray-700">Session ended</p>
          {session.summary && (
            <p className="text-sm text-gray-600 mt-1">{session.summary}</p>
          )}
          {session.next_steps && (
            <p className="text-sm text-gray-500 mt-1">
              <span className="font-medium">Next steps:</span> {session.next_steps}
            </p>
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-gray-500 mt-8">
            <p className="text-lg mb-2">🖋️</p>
            <p>Start your coaching session by sending a message.</p>
            <p className="text-sm mt-1">Quinn is ready to help with your writing.</p>
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
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
              <span className="text-sm">🖋️</span>
            </div>
            <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {session && !session.ended_at && (
        <div className="border-t border-gray-200 bg-white px-4 py-3">
          {error && (
            <p className="text-sm text-red-600 mb-2">{error}</p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
              className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent min-h-[44px] max-h-[200px]"
              rows={1}
              disabled={isStreaming}
              aria-label="Message input"
            />
            <button
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isStreaming}
              className="px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
