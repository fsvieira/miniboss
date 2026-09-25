/**
 * Processing States — state machine that controls when a conversation
 * is sent or not for AI processing.
 *
 * This is a generic layer, independent of the protocol (chat, main, focus).
 * O protocolo decide a phase; o processing_state decide o scheduling.
 */
const PROCESSING_STATES = Object.freeze({
  /** Conversation stopped, nothing pending. Waiting for new user message. */
  IDLE: 'idle',

  /** Marked to be sent to the AI. ConversationManager will pick it up. */
  QUEUED: 'queued',

  /** Being prepared for sending (atomic transition — no one else can pick it up). */
  SENDING: 'sending',

  /** AI is generating response. */
  AI_PROCESSING: 'ai_processing',

  /** Tools are executing. */
  TOOL_EXEC: 'tool_exec',

  /** Tool results processed, deciding next step. */
  TOOL_RESULTS: 'tool_results',

  /** Ciclo completou (sem tools ou maxIterations == 0). */
  STOPPED: 'stopped',

  /** Falhou irrecuperavelmente. */
  ERROR: 'error',

  /**
   * Cancellation requested: user clicked "stop". This state persists
   * in the DB so the loop (tools/queued) does NOT relaunch requests to the AI until
   * que a conversa sexa finalizada como terminal (idle/cancelled).
   */
  CANCELLING: 'cancelling',
});

/**
 * Estados em que a conversa pode ser "claimada" pelo ConversationManager.
 */
const CLAIMABLE_STATES = Object.freeze([
  PROCESSING_STATES.QUEUED,
  PROCESSING_STATES.TOOL_RESULTS,
]);

/**
 * Terminal states — conversation should not be processed nor rescheduled.
 */
const TERMINAL_STATES = Object.freeze([
  PROCESSING_STATES.STOPPED,
  PROCESSING_STATES.ERROR,
]);

/**
 * States where the conversation is "active" (being processed).
 */
const ACTIVE_STATES = Object.freeze([
  PROCESSING_STATES.SENDING,
  PROCESSING_STATES.AI_PROCESSING,
  PROCESSING_STATES.TOOL_EXEC,
  PROCESSING_STATES.TOOL_RESULTS,
]);

/**
 * Estados de mensagens tool.
 * Controlam o lifecycle de cada tool message individual.
 */
const MESSAGE_STATES = Object.freeze({
  /** Tool message created but not yet processed. */
  PENDING: 'pending',

  /** Tool message is being processed (executed). */
  PROCESSING: 'processing',

  /** Tool message processada com sucesso. */
  PROCESSED: 'processed',

  /** Tool message falhou ao processar. */
  ERROR: 'error',
});

/**
 * Terminal states for tool messages (no longer change).
 */
const FINAL_MESSAGE_STATES = Object.freeze([
  MESSAGE_STATES.PROCESSED,
  MESSAGE_STATES.ERROR,
]);

module.exports = {
  PROCESSING_STATES,
  CLAIMABLE_STATES,
  TERMINAL_STATES,
  ACTIVE_STATES,
  MESSAGE_STATES,
  FINAL_MESSAGE_STATES,
};