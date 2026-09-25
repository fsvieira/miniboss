'use strict';

/**
 * @typedef {Object} ProtocolAction
 * @property {string} setProcessingState - 'queued' | 'stopped' | 'error' | 'idle'
 * @property {number} [scheduleRetryMs] - If > 0, schedule retry after N ms
 * @property {boolean} [autoReport] - If true, generate auto-report (focus)
 * @property {string} [nextPhase] - New phase after transition
 * @property {string} [reason] - Transition reason
 */

/**
 * Base interface that all protocols must implement.
 *
 * Each protocol defines:
 * - The conversation lifecycle (phases)
 * - The tools available in each phase
 * - The transitions between phases based on events
 * - The actions the ConversationManager must execute after each transition
 *
 * @abstract
 */
class ProtocolInterface {
  /**
   * @returns {string} Unique protocol name (ex: 'chat', 'focus', 'main')
   */
  get name() {
    throw new Error('Protocol must implement get name()');
  }

  /**
   * @returns {string} Initial phase state
   */
  get initialState() {
    throw new Error('Protocol must implement get initialState()');
  }

  /**
   * Returns the names of tools available in the current phase + tool_mode.
   * @param {string} phase - Current conversation phase
   * @param {string} [toolMode] - Tool mode (optional, for fine-tuning)
   * @returns {string[]} Array of allowed tool names
   */
  getTools(phase, toolMode) {
    throw new Error('Protocol must implement getTools()');
  }

  /**
   * Processes an event and returns the action the ConversationManager must execute.
   *
   * @param {string} event - Event name (ex: 'ai_responded_with_tools', 'iteration_exhausted')
   * @param {Object} context - Transition context
   * @param {Object} context.db - DatabaseAPI
   * @param {Object} context.conversation - Conversation data
   * @param {Array} [context.toolMessages] - Tool result messages (if applicable)
   * @param {number} [context.maxIterations] - Remaining iterations
   * @param {Error} [context.error] - Error (if applicable)
   * @returns {Promise<ProtocolAction>}
   */
  async handleEvent(event, context) {
    throw new Error('Protocol must implement handleEvent()');
  }

  /**
   * Serializes the protocol state for persistence.
   * @returns {Object}
   */
  serialize() {
    throw new Error('Protocol must implement serialize()');
  }

  /**
   * Creates an instance from persisted state.
   * @param {Object} state - Persisted state
   * @returns {ProtocolInterface}
   */
  static fromPersisted(state) {
    throw new Error('Protocol must implement static fromPersisted()');
  }
}

module.exports = { ProtocolInterface };