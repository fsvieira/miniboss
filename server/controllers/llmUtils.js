/**
 * llmUtils.js — LEGACY / REMOVIDO.
 *
 * Manual retry was removed in Phase B (resilience): retries are now
 * delegados no SDK da OpenAI (maxRetries configurado no AiClient).
 * Ver `server/services/ai/AiClient.js` e `server/services/conversationManager.js`.
 *
 * Kept only as an empty file to not break legacy imports.
 */
module.exports = {};
