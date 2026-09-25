const { Tiktoken } = require('js-tiktoken/lite');
const o200k_base = require('js-tiktoken/ranks/o200k_base');

// Fallback when the provider does not return context length.
// We use a conservative modern default (most current models are 8k-128k+).
const DEFAULT_TOKEN_LIMIT = 32768;

let tokenizer;
try {
  tokenizer = new Tiktoken(o200k_base);
} catch (_) {
  tokenizer = null;
}

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  if (tokenizer) {
    return tokenizer.encode(text).length;
  }
  const words = text.trim().split(/\s+/);
  return Math.ceil(words.length / 0.75);
}

function countMessageTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.role || '');
    total += estimateTokens(msg.content || '');
  }
  return total;
}

function getTokenLimit(model) {
  // We prefer real values from the provider.
  // If nothing is known, return a safe minimum so UI calculations don't break.
  return DEFAULT_TOKEN_LIMIT;
}

module.exports = {
  estimateTokens,
  countMessageTokens,
  getTokenLimit,
  DEFAULT_TOKEN_LIMIT
};