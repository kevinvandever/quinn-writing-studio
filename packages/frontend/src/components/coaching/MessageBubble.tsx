// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model_used: string | null;
  model_reason: string | null;
  created_at: string;
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function MessageBubble({ message, isStreaming = false }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isOpus = message.model_used === 'opus';

  const timestamp = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isUser) {
    return (
      <div className="flex items-start gap-3 justify-end">
        <div className="max-w-[75%]">
          <div className="bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-3">
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          </div>
          <p className="text-xs text-gray-400 mt-1 text-right">{timestamp}</p>
        </div>
        <div className="w-8 h-8 rounded-full bg-indigo-200 flex items-center justify-center flex-shrink-0">
          <span className="text-sm">👤</span>
        </div>
      </div>
    );
  }

  // Quinn (assistant) message
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
        <span className="text-sm">🖋️</span>
      </div>
      <div className="max-w-[75%]">
        {/* Stepping up notification when Opus is used */}
        {isOpus && message.model_reason && (
          <div className="mb-2 px-3 py-1.5 bg-purple-50 border border-purple-200 rounded-lg">
            <div className="flex items-center gap-1.5">
              <span className="text-xs">⚡</span>
              <span className="text-xs text-purple-700 font-medium">Stepping up</span>
            </div>
            <p className="text-xs text-purple-600 mt-0.5">{message.model_reason}</p>
          </div>
        )}

        <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
          <p className="text-sm text-gray-900 whitespace-pre-wrap">
            {message.content}
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-indigo-600 ml-0.5 animate-pulse" />
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 mt-1">
          <p className="text-xs text-gray-400">{timestamp}</p>
          {/* Model indicator badge */}
          {message.model_used && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                isOpus
                  ? 'bg-purple-100 text-purple-700'
                  : 'bg-gray-200 text-gray-600'
              }`}
            >
              {message.model_used === 'opus' ? 'Opus' : 'Sonnet'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
