/**
 * Build a structured error object from an LLM/API error, preserving all metadata.
 */
function buildStructuredError(error) {
  const structured = {
    message: error?.error?.message || error?.message || 'Unknown error',
    status: error?.status || null,
    code: error?.code || null,
    type: error?.type || null,
    error_message: error?.error?.message || null,
  };

  // Preserve metadata from provider errors (e.g., rate limit details)
  if (error?.error?.metadata) {
    structured.metadata = error.error.metadata;
  }

  // For OpenAI-style errors that have the full error nested
  if (error.message && typeof error.message === 'object') {
    const msg = error.message;
    structured.message = msg.error ? msg.error.message : JSON.stringify(msg);
    if (msg.error?.metadata) {
      structured.metadata = msg.error.metadata;
    }
  }

  return structured;
}

/**
 * Extract retry_after seconds from various error shapes (OpenAI, OpenRouter, etc.)
 */
function getRetryAfter(error) {
  // Direct retry-after header
  if (error?.headers?.get) {
    const retryAfter = error.headers.get('retry-after');
    if (retryAfter) {
      return parseInt(retryAfter, 10);
    }
  }

  // OpenRouter-style metadata
  if (error?.error?.metadata?.retry_after_seconds) {
    return error.error.metadata.retry_after_seconds;
  }

  if (error?.error?.metadata?.retry_after_seconds_raw) {
    return Math.ceil(error.error.metadata.retry_after_seconds_raw);
  }

  // Default fallback
  return 30;
}

/**
 * Check if the error is a rate limit error (429)
 */
function isRateLimitError(error) {
  return error?.status === 429 || error?.code === 429 || error?.error?.code === 429;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  buildStructuredError,
  getRetryAfter,
  isRateLimitError,
  sleep,
};