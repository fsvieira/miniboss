/**
 * AI module — Pure communication layer with AI providers.
 */

// Re-export main class
const { AiClient } = require('./AiClient');

// Re-export types for external use
const types = require('./types');

module.exports = {
  AiClient,
  ...types,
};