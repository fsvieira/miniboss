const { DatabaseAPI, DatabaseConnection } = require('../db');

const PRICING_CACHE_KEY = 'model_pricing';

/**
 * Price per 1M tokens per model, in USD (USD per 1M tokens).
 * Cached in settings (key `model_pricing`) and updated when listing models.
 */

function parseCache(cacheValue) {
  if (!cacheValue) return {};
  try {
    const parsed = JSON.parse(cacheValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Updates the pricing cache with the listed models.
 * @param {Array<{id: string, pricing?: {prompt?: number|null, completion?: number|null}}>} models
 */
function cacheModelPricing(models) {
  if (!Array.isArray(models)) return;
  try {
    const connection = new DatabaseConnection();
    const db = new DatabaseAPI(connection);
    const cache = parseCache(db.getSetting(PRICING_CACHE_KEY));
    for (const model of models) {
      if (!model?.id || !model.pricing) continue;
      cache[model.id] = {
        prompt: model.pricing.prompt != null ? model.pricing.prompt : null,
        completion: model.pricing.completion != null ? model.pricing.completion : null,
      };
    }
    db.setSetting(PRICING_CACHE_KEY, JSON.stringify(cache));
    connection.close();
  } catch (_) {}
}

/**
 * Returns the pricing (USD per 1M tokens) for a model.
 * @param {string} modelId
 * @returns {{prompt: number|null, completion: number|null}|null}
 */
function getModelPricing(modelId) {
  if (!modelId) return null;
  try {
    const connection = new DatabaseConnection();
    const db = new DatabaseAPI(connection);
    const cache = parseCache(db.getSetting(PRICING_CACHE_KEY));
    connection.close();
    return cache[modelId] || null;
  } catch (_) {
    return null;
  }
}

/**
 * Calculates the cost in USD for a call.
 * cost = prompt_tokens/1e6 * pricing.prompt + completion_tokens/1e6 * pricing.completion
 * No price → null.
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {{prompt: number|null, completion: number|null}|null} pricing
 * @returns {number|null}
 */
function computeCostUsd(promptTokens, completionTokens, pricing) {
  if (!pricing) return null;
  const promptPrice = pricing.prompt;
  const completionPrice = pricing.completion;
  if (promptPrice == null && completionPrice == null) return null;

  const promptCost = promptPrice != null
    ? (Number(promptTokens) || 0) / 1e6 * promptPrice
    : 0;
  const completionCost = completionPrice != null
    ? (Number(completionTokens) || 0) / 1e6 * completionPrice
    : 0;
  const total = promptCost + completionCost;
  return Number.isFinite(total) ? total : null;
}

module.exports = {
  PRICING_CACHE_KEY,
  cacheModelPricing,
  getModelPricing,
  computeCostUsd,
};
