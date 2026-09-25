'use strict';

/**
 * Specific error for invalid transitions in the state machine.
 */
class ProtocolStateError extends Error {
  /**
   * @param {string} conversationId
   * @param {string} message
   * @param {Object} [details={}]
   */
  constructor(conversationId, message, details = {}) {
    super(message);
    this.name = 'ProtocolStateError';
    this.conversationId = conversationId;
    this.details = details;
  }
}

/**
 * Error for when a protocol is not found.
 */
class ProtocolNotFoundError extends Error {
  /**
   * @param {string} conversationId
   * @param {string} conversationType
   */
  constructor(conversationId, conversationType) {
    super(`No protocol found for conversation ${conversationId} (type: ${conversationType})`);
    this.name = 'ProtocolNotFoundError';
    this.conversationId = conversationId;
    this.conversationType = conversationType;
  }
}

module.exports = {
  ProtocolStateError,
  ProtocolNotFoundError,
};
