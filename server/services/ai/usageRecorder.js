const { getModelPricing, computeCostUsd } = require('./pricing');

/**
 * Single entry point for persisting the usage of an AI call.
 *
 * Every provider call must go through here (audit with
 * `grep -rn "chatCompletion" server/`), otherwise the spend is invisible.
 *
 * The recorder never fabricates a cost: when the price of the model is unknown the
 * row is stored with `cost_usd = NULL` and `pricing_source = 'unknown'`, which the
 * aggregation surfaces as a partial (incomplete) total.
 */

/**
 * @typedef {Object} NormalizedUsage
 * @property {number|null} promptTokens
 * @property {number|null} completionTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {boolean} [cacheIncludedInPrompt]
 */

/**
 * Records the token usage of an AI call.
 *
 * @param {object} params
 * @param {object} params.db - Database API (must expose `recordTokenUsage`).
 * @param {number} params.conversationId
 * @param {string} [params.requestedModel] - The model that was asked for.
 * @param {string} [params.responseModel] - The model that actually answered.
 * @param {NormalizedUsage|null} params.usage
 * @param {number|string} [params.providerId]
 * @param {string} [params.pricingSource] - Force the pricing source ('stale', ...).
 * @returns {{recorded: boolean, costUsd: number|null, pricingSource: string, model: string|null}}
 */
function recordUsage(params = {}) {
  const {
    db,
    conversationId,
    requestedModel = null,
    responseModel = null,
    usage,
    providerId = null,
    pricingSource: forcedPricingSource = null,
  } = params;

  const empty = {
    recorded: false,
    costUsd: null,
    pricingSource: 'unknown',
    model: responseModel || requestedModel || null,
  };

  if (!db || conversationId == null || !usage) return empty;

  const promptTokens = Number(usage.promptTokens);
  const completionTokens = Number(usage.completionTokens);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return empty;

  const cacheReadTokens = Math.max(0, Number(usage.cacheReadTokens) || 0);
  const cacheWriteTokens = Math.max(0, Number(usage.cacheWriteTokens) || 0);

  const effectiveModel = responseModel || requestedModel || null;

  // A8: price against the model that actually answered; fall back to the requested
  // one only when the provider did not tell us which model it used.
  let pricing = effectiveModel ? getModelPricing(effectiveModel) : null;
  let pricingSource = 'provider';
  let pricedModel = effectiveModel;

  if (!pricing && requestedModel && requestedModel !== effectiveModel) {
    pricing = getModelPricing(requestedModel);
    pricedModel = requestedModel;
    pricingSource = 'requested';
  }

  if (!pricing) {
    pricingSource = forcedPricingSource || 'unknown';
  } else if (forcedPricingSource) {
    pricingSource = forcedPricingSource;
  } else if (pricingSource === 'provider' && pricing.source && pricing.source !== 'provider') {
    pricingSource = pricing.source;
  }

  const costUsd = computeCostUsd(
    promptTokens || 0,
    completionTokens || 0,
    pricing,
    { read: cacheReadTokens, write: cacheWriteTokens },
    { cacheIncludedInPrompt: usage.cacheIncludedInPrompt !== false }
  );

  db.recordTokenUsage({
    conversation_id: conversationId,
    // `model` is kept for backwards compatibility: the responded model when known.
    model: pricedModel || effectiveModel || requestedModel || null,
    requested_model: requestedModel || null,
    response_model: responseModel || null,
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    cost_usd: costUsd,
    pricing_source: pricingSource,
    provider_id: providerId,
  });

  return {
    recorded: true,
    costUsd,
    pricingSource,
    model: pricedModel || effectiveModel || null,
  };
}

module.exports = { recordUsage };
