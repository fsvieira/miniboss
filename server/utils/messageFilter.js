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

/**
 * Formats the result of `runCommand` as labelled text for the LLM.
 *
 * The raw JSON is kept in the database/UI; the model gets a plain-text layout
 * that makes an empty stdout (with output on stderr) impossible to misread as
 * "no output". Empty fields are omitted on purpose: a trailing `stderr:` label
 * with nothing after it was what led the model to claim there was no output.
 * Internal diagnostics (`captureSource`, `sandboxed`) are dropped.
 *
 * @param {Object} result
 * @returns {string|null}
 */
function formatRunCommandToolContent(result) {
  if (!result || typeof result !== 'object') return null;
  if (!('stdout' in result) && !('stderr' in result) && !('exitCode' in result)) return null;

  const stdout = result.stdout == null ? '' : String(result.stdout);
  const stderr = result.stderr == null ? '' : String(result.stderr);
  const exitCode = result.exitCode == null ? 0 : result.exitCode;

  const lines = [`exitCode: ${exitCode}`];

  if (stdout.trim() !== '') {
    lines.push('stdout:', stdout);
  }
  if (stderr.trim() !== '') {
    lines.push('stderr:', stderr);
  }

  if (stdout.trim() === '' && stderr.trim() !== '') {
    lines.push('[stdout is empty; the output above is on stderr]');
  } else if (stdout.trim() === '' && stderr.trim() === '') {
    lines.push('[command produced no output]');
  }

  const setup = result.setup;
  if (setup && setup.status === 'failed') {
    const detail = setup.summary ? `: ${String(setup.summary).trim()}` : '';
    lines.push(`[setup FAILED${detail}]`);
  }

  return lines.join('\n');
}

/**
 * A tool message is "complete" when it has a final status (anything other than
 * pending/processing) or, in legacy rows with no status, a non-null
 * tool_result/content. Incomplete tool messages must never reach the model.
 */
function isToolMessageComplete(m) {
  if (!m) return false;
  const status = m.status;
  const hasResult = (m.tool_result !== null && m.tool_result !== undefined && String(m.tool_result) !== '')
    || (m.content !== null && m.content !== undefined && String(m.content) !== '');
  if (status && status !== 'pending' && status !== 'processing') return true;
  if (!status) return hasResult;
  return false;
}

function normalizeMessagesForLLM(messages) {
  if (!Array.isArray(messages)) return [];

  // First pass: collect the tool_call_id of every tool message that has a final
  // result, so the assistants below only keep tool_calls whose result actually
  // exists. Orphan tool_calls (pending tools, or tools not created at all in
  // terminal states) are invalid for the OpenAI API and must be dropped.
  const completedToolCallIds = new Set();
  for (const m of messages) {
    if (!m || m.role !== 'tool' || !isToolMessageComplete(m)) continue;
    const callId = m.tool_call_id || m.id;
    if (callId) completedToolCallIds.add(String(callId));
  }

  return messages.map((m) => {
    if (!m) return null;

    if (m.role === 'tool') {
      if (!isToolMessageComplete(m)) {
        return null;
      }

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
      if (meta.toolName === 'runCommand') {
        const formatted = formatRunCommandToolContent(parsed);
        if (formatted != null) content = formatted;
      }
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

      // Keep only tool_calls that have a completed tool message in the window.
      // If none remain, omit the `tool_calls` property entirely (an empty array
      // of tool_calls is invalid for the OpenAI API).
      let keptToolCalls = null;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        keptToolCalls = toolCalls.filter(
          tc => tc.id && completedToolCallIds.has(String(tc.id))
        );
      }

      return {
        role: 'assistant',
        content: m.content || null,
        ...(keptToolCalls && keptToolCalls.length ? {
          tool_calls: keptToolCalls.map(tc => ({
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
  formatRunCommandToolContent,
};
