/**
 * Single authoritative state per conversation (Phase E — item 5 of the plan).
 *
 * Derived state enum from processing_state + phase + active descendants:
 *   - 'running':   active processing (queued/sending/ai_processing/tool_exec/tool_results)
 *                  OR conversation with active descendant (active_focus_id without report).
 *   - 'waiting':   non-terminal phase without active processing (ex: waiting_focus without active child).
 *   - 'completed': terminal phase (stopped/completed/report_sent/idle) without active processing.
 *   - 'error':     phase error/cancelled.
 */

const ACTIVE_PROCESSING = ['queued', 'sending', 'ai_processing', 'tool_exec', 'tool_results', 'cancelling'];
const TERMINAL_PHASES = ['stopped', 'completed', 'report_sent', 'idle'];
const ERROR_PHASES = ['error', 'cancelled'];

/**
 * Computes the authoritative state of a conversation.
 * @param {Object} conv - Conversation record (at least processing_state, phase, active_focus_id).
 * @param {Object} [db] - Optional DatabaseAPI, used to resolve the active focus.
 * @returns {string} 'running' | 'waiting' | 'completed' | 'error'
 */
function computeConversationStatus(conv, db = null) {
  if (!conv) return 'completed';

  const ps = conv.processing_state;

  // Active processing -> running
  if (ACTIVE_PROCESSING.includes(ps)) return 'running';

  // Terminal error phase -> error
  if (ERROR_PHASES.includes(conv.phase)) return 'error';

  // Active descendant (focus without report) -> running for parent chain
  if (conv.active_focus_id && db) {
    try {
      const active = db.getConversation(conv.active_focus_id);
      if (active && !active.focus_report) return 'running';
    } catch (_) {}
  }

  // Terminal phase -> completed
  if (TERMINAL_PHASES.includes(conv.phase)) return 'completed';

  // Any other non-terminal phase without active processing -> waiting
  return 'waiting';
}

module.exports = { computeConversationStatus };
