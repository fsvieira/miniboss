/**
 * Message filter for LLM context.
 *
 * - Considera apenas mensagens de "respostas" (role === 'user' ou 'assistant').
 * - Keeps the last N responses (default: 8).
 * - Inclui **todas** as mensagens a partir da primeira dessas respostas (incluindo todas as tools associadas).
 * - Removes approval messages.
 * - Optionally removes 'system' messages (avoids duplication with LLM system prompt).
 *
 * IMPORTANT: This filtering ONLY affects what is sent to the AI model.
 * Has no impact on what is stored in the database or the chat the user sees.
 */

function hasToolCallsInMessage(m) {
  if (!m) return false;
  const tc = m.tool_calls;
  if (Array.isArray(tc) && tc.length > 0) return true;
  if (typeof tc === 'string' && tc.trim().startsWith('[')) return true;
  return false;
}

function filterMessagesForLLM(messages, options = {}) {
  const lastNResponses = options.lastNResponses ?? 200;
  const minAssistantLength = options.minAssistantLength ?? 0;
  const excludeSystem = options.excludeSystem ?? false;

  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const lastAssistant = [...messages].reverse().find(m => m && m.role === 'assistant') || null;

  // 1. Coletar todas as mensagens de "respostas" (user + assistant)
  const dialogue = messages.filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant')
  );

  // 2. Se tivermos poucas respostas, devolvemos (quase) tudo, mas limpamos assistants curtos
  if (dialogue.length <= lastNResponses) {
    return messages.filter((m, idx) => {
      if (!m) return false;
      if (['approval_request', 'approval_approved', 'approval_denied'].includes(m.role)) {
        return false;
      }
      if (m.role === 'system' && excludeSystem) {
        return false;
      }
      if (m.role === 'assistant') {
        const content = (m.content || '').toString();
        const isLastAssistant = lastAssistant && m === lastAssistant;
        return hasToolCallsInMessage(m) || content.length >= minAssistantLength || isLastAssistant;
      }
      return true;
    });
  }

  // 3. Fetch the last N dialogue responses
  const lastN = dialogue.slice(-lastNResponses);
  const firstOfWindow = lastN[0];

  if (!firstOfWindow || firstOfWindow.id == null) {
    // safety fallback
    return messages;
  }

  // 4. Find the index in the original list
  const startIndex = messages.findIndex((m) => m && m.id === firstOfWindow.id);

  if (startIndex === -1) {
    return messages;
  }

  // 5. Include EVERYTHING from there (no cuts in tools)
  let result = messages.slice(startIndex);

  // 6. Still remove approval messages, system (if excludeSystem) and very short assistants within the window
  result = result.filter((m) => {
    if (!m) return false;
    if (['approval_request', 'approval_approved', 'approval_denied'].includes(m.role)) {
      return false;
    }
    if (m.role === 'system' && excludeSystem) {
      return false;
    }
    if (m.role === 'assistant') {
      const content = (m.content || '').toString();
      const isLastAssistant = lastAssistant && m === lastAssistant;
      return hasToolCallsInMessage(m) || content.length >= minAssistantLength || isLastAssistant;
    }
    return true;
  });

  return result;
}

/**
 * Converts DB-shaped messages (raw rows) into clean OpenAI chat completion format.
 * Handles:
 *  - tool_calls stored as JSON string
 *  - tool results using tool_call_id + tool_result → content
 */
const TOOL_CONTEXT_MAX_CHARS = 12000;

function parseJsonSafe(payload) {
  if (typeof payload !== 'string') return null;
  try {
    return JSON.parse(payload);
  } catch (_) {
    return null;
  }
}

function normalizeMessagesForLLM(messages) {
  if (!Array.isArray(messages)) return [];

  return messages.map((m) => {
    if (!m) return null;

    if (m.role === 'tool') {
      let rawContent = m.tool_result ?? m.content ?? '';
      if (rawContent === null || rawContent === undefined) rawContent = '';
      if (typeof rawContent !== 'string') {
        rawContent = String(rawContent);
      }

      const meta = {
        toolName: m.tool_name || 'tool',
        rawLength: rawContent.length,
        truncated: false
      };

      const parsed = parseJsonSafe(rawContent);
      if (parsed && typeof parsed === 'object') {
        if (parsed.path) meta.path = parsed.path;
        if (Array.isArray(parsed.files)) {
          meta.paths = parsed.files
            .map(entry => entry?.path)
            .filter(Boolean)
            .slice(0, 3);
        }
        if (typeof parsed.preview === 'string') {
          meta.previewLength = parsed.preview.length;
        }
        if (parsed.note) meta.note = parsed.note;
        if (parsed.truncated) meta.flaggedTruncated = true;
      }

      let content = rawContent;
      if (content.length > TOOL_CONTEXT_MAX_CHARS) {
        content = `${content.slice(0, TOOL_CONTEXT_MAX_CHARS)}\n\n[TRUNCATED — original tool result length ${rawContent.length} chars. Re-run the tool with narrower scope to retrieve the remainder.]`;
        meta.truncated = true;
        meta.truncatedAt = TOOL_CONTEXT_MAX_CHARS;
      }

      const message = {
        role: 'tool',
        tool_call_id: m.tool_call_id || m.id || undefined,
        content,
      };

      message.__meta = meta;
      return message;
    }

    if (m.role === 'assistant') {
      let toolCalls = m.tool_calls;
      if (typeof toolCalls === 'string') {
        try {
          toolCalls = JSON.parse(toolCalls);
        } catch {
          toolCalls = null;
        }
      }

      return {
        role: 'assistant',
        content: m.content || null,
        ...(toolCalls && toolCalls.length ? {
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: tc.type === 'custom' ? 'custom' : 'function',
            function: tc.function || { name: '', arguments: '' },
          }))
        } : {}),
      };
    }

    // user and fallback
    return {
      role: m.role,
      content: m.content ?? '',
    };
  }).filter(Boolean);
}

module.exports = {
  filterMessagesForLLM,
  normalizeMessagesForLLM,
};
