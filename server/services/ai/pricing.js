const { DatabaseAPI, DatabaseConnection } = require('../db');
const {
  PER_MILLION,
  sanitizePer1M,
  sanitizePricingEntry,
  isPaidModel,
} = require('./priceCatalog');

const PRICING_CACHE_KEY = 'model_pricing';
const PRICING_CATALOG_VERSION = 2;
const LEGACY_SCOPE = 'legacy';

/**
 * Default age after which the cached catalog is considered stale (24h).
 */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── Shared DB connection (avoids opening a connection per lookup) ──────────

let sharedConnection = null;
let sharedDb = null;
let injectedDb = null;

function getDb() {
  if (injectedDb) return injectedDb;
  if (!sharedDb) {
    sharedConnection = new DatabaseConnection();
    sharedDb = new DatabaseAPI(sharedConnection);
  }
  return sharedDb;
}

/**
 * Injects a database API (used by tests and by callers that already own a connection).
 * @param {object|null} db
 */
function setPricingDb(db) {
  injectedDb = db || null;
}

/**
 * Closes the module-level connection (tests / graceful shutdown).
 */
function closeSharedConnection() {
  if (sharedConnection) {
    try {
      sharedConnection.close();
    } catch (_) {}
  }
  sharedConnection = null;
  sharedDb = null;
}

// ── Catalog persistence ────────────────────────────────────────────────────

/**
 * Parses the raw setting value into the versioned catalog shape.
 * Legacy (flat) catalogs — written by older versions — are migrated into a
 * dedicated scope so their entries stay readable until a fresh fetch replaces them.
 *
 * @param {string|null} raw
 * @returns {{version: number, providers: object}|null}
 */
function parseCatalog(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  if (parsed.version === PRICING_CATALOG_VERSION && parsed.providers && typeof parsed.providers === 'object') {
    return { version: PRICING_CATALOG_VERSION, providers: parsed.providers };
  }

  // Legacy flat map: { "<model id>": { prompt, completion } }
  return {
    version: PRICING_CATALOG_VERSION,
    providers: {
      [LEGACY_SCOPE]: {
        fetchedAt: null,
        source: 'provider',
        models: parsed,
      },
    },
  };
}

function readCatalog() {
  try {
    return parseCatalog(getDb().getSetting(PRICING_CACHE_KEY));
  } catch (_) {
    return null;
  }
}

function writeCatalog(catalog) {
  getDb().setSetting(PRICING_CACHE_KEY, JSON.stringify(catalog));
}

/**
 * Orders the catalog scopes: most recently fetched first, legacy scope last.
 * @param {{providers: object}} catalog
 */
function orderedScopes(catalog) {
  const scopes = Object.entries(catalog.providers || {}).map(([id, scope]) => ({
    id,
    scope: scope && typeof scope === 'object' ? scope : { models: {} },
  }));
  scopes.sort((a, b) => {
    const aTime = a.scope.fetchedAt ? Date.parse(a.scope.fetchedAt) : 0;
    const bTime = b.scope.fetchedAt ? Date.parse(b.scope.fetchedAt) : 0;
    if (aTime === bTime) return a.id === LEGACY_SCOPE ? 1 : (b.id === LEGACY_SCOPE ? -1 : 0);
    return bTime - aTime;
  });
  return scopes;
}

// ── Paid-model gate ────────────────────────────────────────────────────────

const PAID_MODELS_SETTING = 'allow_paid_models';

/**
 * Whether models with a known positive price may be used.
 * Default: `false` (the gate is closed until the cost audit passes).
 *
 * @returns {boolean}
 */
function arePaidModelsAllowed() {
  try {
    const raw = getDb().getSetting(PAID_MODELS_SETTING);
    if (raw == null || raw === '') return false;
    return String(raw).toLowerCase() === 'true' || raw === '1';
  } catch (_) {
    return false;
  }
}

/**
 * Checks a model against the paid-model gate.
 * A model whose price is *unknown* is not blocked: we cannot prove it is paid.
 *
 * @param {string} modelId
 * @returns {{allowed: boolean, paid: boolean, reason: string|null}}
 */
function checkPaidModelGate(modelId) {
  const pricing = getModelPricing(modelId);
  const paid = isPaidModel(pricing);
  if (!paid) return { allowed: true, paid: false, reason: null };
  if (arePaidModelsAllowed()) return { allowed: true, paid: true, reason: null };
  return {
    allowed: false,
    paid: true,
    reason: `Model "${modelId}" has a paid price and paid models are disabled (setting "${PAID_MODELS_SETTING}" = false). Enable it in Settings once the cost audit (server/scripts/costAudit.js) passes.`,
  };
}

// ── Public catalog API ─────────────────────────────────────────────────────

/**
 * Stores the pricing of a provider's model list.
 * The fetch is authoritative for that provider: its previous scope is replaced, so
 * stale entries (and the `-1` sentinel of retired routers) do not survive.
 *
 * @param {Array<{id: string, pricing?: object}>} models - Normalised models (USD per 1M).
 * @param {object} [options]
 * @param {number|string|null} [options.providerId] - Provider scope.
 * @param {string} [options.source='provider']
 * @param {string} [options.fetchedAt]
 * @returns {object|null} The stored entries.
 */
function cacheModelPricing(models, options = {}) {
  if (!Array.isArray(models)) return null;

  const providerId = options.providerId != null ? String(options.providerId) : LEGACY_SCOPE;
  const source = options.source || 'provider';
  const fetchedAt = options.fetchedAt || new Date().toISOString();

  const entries = {};
  for (const model of models) {
    if (!model?.id || !model.pricing) continue;
    const sanitized = sanitizePricingEntry(model.pricing);
    if (!sanitized) continue;
    entries[model.id] = sanitized;
  }

  try {
    const catalog = readCatalog() || { version: PRICING_CATALOG_VERSION, providers: {} };
    catalog.version = PRICING_CATALOG_VERSION;
    catalog.providers[providerId] = { fetchedAt, source, models: entries };
    writeCatalog(catalog);
    return entries;
  } catch (err) {
    console.warn('[pricing] Failed to persist pricing catalog:', err?.message || err);
    return null;
  }
}

/**
 * Returns the pricing (USD per 1M tokens) of a model, or `null` when unknown.
 * Never fabricates a zero price for a model that has no catalog entry.
 *
 * @param {string} modelId
 * @returns {{prompt: number|null, completion: number|null, cacheRead: number|null, cacheWrite: number|null, fetchedAt: string|null, source: string}|null}
 */
function getModelPricing(modelId) {
  if (!modelId) return null;
  const catalog = readCatalog();
  if (!catalog) return null;

  for (const { scope } of orderedScopes(catalog)) {
    const raw = scope.models?.[modelId];
    if (!raw) continue;
    const entry = sanitizePricingEntry(raw);
    if (!entry) return null;
    return {
      ...entry,
      fetchedAt: scope.fetchedAt || null,
      source: scope.source || 'provider',
    };
  }

  return null;
}

/**
 * Returns the age (ms) of the catalog entry for a provider, or `null` when unknown.
 * @param {number|string} providerId
 * @returns {number|null}
 */
function getCatalogAgeMs(providerId) {
  const catalog = readCatalog();
  if (!catalog) return null;
  const scope = catalog.providers?.[String(providerId)];
  if (!scope?.fetchedAt) return null;
  const parsed = Date.parse(scope.fetchedAt);
  if (!Number.isFinite(parsed)) return null;
  return Date.now() - parsed;
}

/**
 * Summary of the cached catalog (used by the audit script and the settings UI).
 * @returns {{providerCount: number, modelCount: number, fetchedAt: string|null}}
 */
function getCatalogStatus() {
  const catalog = readCatalog();
  if (!catalog) return { providerCount: 0, modelCount: 0, fetchedAt: null };

  const scopes = orderedScopes(catalog);
  let modelCount = 0;
  let fetchedAt = null;
  for (const { scope } of scopes) {
    modelCount += Object.keys(scope.models || {}).length;
    const time = scope.fetchedAt ? Date.parse(scope.fetchedAt) : 0;
    if (Number.isFinite(time) && (fetchedAt === null || time > Date.parse(fetchedAt))) {
      fetchedAt = scope.fetchedAt;
    }
  }

  return { providerCount: scopes.length, modelCount, fetchedAt };
}

// ── Cost computation ───────────────────────────────────────────────────────

/**
 * Calculates the cost in USD of a call.
 *
 * cost = (prompt - cacheRead)/1e6 * promptPrice
 *      + cacheRead/1e6 * cacheReadPrice
 *      + cacheWrite/1e6 * cacheWritePrice
 *      + completion/1e6 * completionPrice
 *
 * `null` is returned whenever the cost cannot be determined exactly — an unknown
 * price is never silently turned into a zero cost.
 *
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {object|null} pricing - Catalog entry (USD per 1M tokens).
 * @param {{read?: number, write?: number}|null} [cacheTokens] - Cache token counters.
 * @param {{cacheIncludedInPrompt?: boolean}} [options] - OpenAI-compatible APIs report the
 *        cached tokens *inside* `prompt_tokens`; Anthropic-style APIs report them separately.
 * @returns {number|null}
 */
function computeCostUsd(promptTokens, completionTokens, pricing, cacheTokens = null, options = {}) {
  if (!pricing || typeof pricing !== 'object') return null;

  const promptPrice = sanitizePer1M(pricing.prompt);
  const completionPrice = sanitizePer1M(pricing.completion);
  const cacheReadPrice = sanitizePer1M(pricing.cacheRead);
  const cacheWritePrice = sanitizePer1M(pricing.cacheWrite);

  const prompt = Math.max(0, Number(promptTokens) || 0);
  const completion = Math.max(0, Number(completionTokens) || 0);
  const cacheRead = Math.max(0, Number(cacheTokens?.read) || 0);
  const cacheWrite = Math.max(0, Number(cacheTokens?.write) || 0);

  // A token class without a price makes the whole call unpriceable.
  if (prompt > 0 && promptPrice == null) return null;
  if (completion > 0 && completionPrice == null) return null;
  if (cacheRead > 0 && cacheReadPrice == null) return null;
  if (cacheWrite > 0 && cacheWritePrice == null) return null;

  // Cache tokens are already included in `prompt_tokens` on OpenAI-compatible APIs.
  const cacheIncludedInPrompt = options.cacheIncludedInPrompt !== false;
  const billablePrompt = cacheIncludedInPrompt ? Math.max(0, prompt - cacheRead) : prompt;

  let total = 0;
  if (promptPrice != null) total += (billablePrompt / PER_MILLION) * promptPrice;
  if (cacheReadPrice != null) total += (cacheRead / PER_MILLION) * cacheReadPrice;
  if (cacheWritePrice != null) total += (cacheWrite / PER_MILLION) * cacheWritePrice;
  if (completionPrice != null) total += (completion / PER_MILLION) * completionPrice;

  return Number.isFinite(total) ? total : null;
}

// ── Refresh policy ─────────────────────────────────────────────────────────

/**
 * Fetches the provider's model list and refreshes its catalog scope.
 * Never throws — a provider outage must not break the caller.
 *
 * @param {object} options
 * @param {object} options.provider - Provider row ({ id, api_key, base_url }).
 * @param {number|string} [options.providerId]
 * @param {boolean} [options.force]
 * @returns {Promise<{ok: boolean, models?: Array, error?: string, stale: boolean}>}
 */
async function refreshModelPricing(options = {}) {
  const { provider, providerId, force = false } = options;
  if (!provider || !provider.base_url) {
    return { ok: false, error: 'Provider not configured', stale: true };
  }

  const scopeId = providerId != null ? String(providerId) : (provider.id != null ? String(provider.id) : LEGACY_SCOPE);

  if (!force) {
    const age = getCatalogAgeMs(scopeId);
    if (age != null && age < CATALOG_MAX_AGE_MS) {
      return { ok: true, skipped: true, stale: false };
    }
  }

  try {
    const { AiClient } = require('./AiClient');
    const client = new AiClient({
      apiKey: provider.api_key || 'dummy',
      baseUrl: provider.base_url,
      timeout: 15000,
      maxRetries: 1,
    });
    let models;
    try {
      models = await client.listModels();
    } finally {
      client.close();
    }
    cacheModelPricing(models, { providerId: scopeId, source: 'provider' });
    return { ok: true, models, stale: false };
  } catch (error) {
    const message = error?.message || String(error);
    console.warn('[pricing] Catalog refresh failed:', message);
    return { ok: false, error: message, stale: true };
  }
}

/**
 * Ensures a usable pricing entry exists for a model, refreshing the catalog when
 * it is missing or outdated. A refresh failure never blocks the caller: the last
 * known catalog is used and the result is flagged as stale.
 *
 * @param {object} options
 * @param {object} [options.provider]
 * @param {number|string} [options.providerId]
 * @param {string} [options.model]
 * @returns {Promise<{pricing: object|null, stale: boolean}>}
 */
async function ensureModelPricing(options = {}) {
  const { provider, providerId, model } = options;

  let pricing = getModelPricing(model);
  const scopeId = providerId != null ? String(providerId) : (provider?.id != null ? String(provider.id) : null);

  const age = scopeId != null ? getCatalogAgeMs(scopeId) : null;
  const missing = !pricing;
  const outdated = age == null || age >= CATALOG_MAX_AGE_MS;

  if (provider && (missing || outdated)) {
    const result = await refreshModelPricing({ provider, providerId: scopeId });
    if (result.ok) {
      pricing = getModelPricing(model);
      return { pricing, stale: false };
    }
    return { pricing, stale: true };
  }

  const stale = scopeId != null && age != null && age >= CATALOG_MAX_AGE_MS;
  return { pricing, stale };
}

module.exports = {
  PRICING_CACHE_KEY,
  PRICING_CATALOG_VERSION,
  CATALOG_MAX_AGE_MS,
  PAID_MODELS_SETTING,
  cacheModelPricing,
  getModelPricing,
  getCatalogAgeMs,
  getCatalogStatus,
  computeCostUsd,
  refreshModelPricing,
  ensureModelPricing,
  arePaidModelsAllowed,
  checkPaidModelGate,
  setPricingDb,
  closeSharedConnection,
};
