/**
 * Canonical price normalisation for AI model catalogs.
 *
 * Reference implementation: Kilo's own gateway (`packages/kilo-gateway/src/api/models.ts`
 * in Kilo-Org/kilocode, function `parseApiPrice`):
 *
 *   if (!price) return undefined
 *   const parsed = parseFloat(price)
 *   if (isNaN(parsed) || parsed < 0) return undefined
 *   return parsed * 1_000_000
 *
 * Rules implemented here (kept in sync with the reference):
 *   - the provider exposes prices in USD **per token**; the catalog stores USD **per 1M tokens**
 *   - the conversion is unconditional — there is no "suspicious value" threshold
 *   - a negative value is a sentinel for "price unknown" and never becomes a price
 *   - zero is a legitimate price (free models) and stays zero
 *
 * The previous MiniBoss implementation used a `< 0.01 → × 1e6` heuristic, which inflated
 * cheap models by 1e6× and happily stored the `-1` sentinel of the `kilo-auto/*` routers
 * as a real price (producing negative costs).
 */

const PER_MILLION = 1_000_000;

// Prices are USD per 1M tokens — they never need more than a handful of decimals.
// The raw multiplication (0.0000002 * 1e6) leaves binary floating point noise
// (0.19999999999999998), so the result is rounded to a sane precision.
const PRICE_DECIMALS = 10;

function roundPrice(value) {
  const factor = 10 ** PRICE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Parses a raw provider price into a number, without applying any unit conversion.
 * Accepts numbers and strings (`"0.000002"`, `"$0.15"`, `"1.5"`). Currency symbols and
 * whitespace are stripped; anything non-numeric yields `null`.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseRawPrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  const cleaned = String(raw).trim().replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalises a raw provider price (USD per token) to USD per 1M tokens.
 *
 * @param {unknown} raw - Raw price from the provider's `/models` payload.
 * @returns {number|null} USD per 1M tokens, or `null` when the price is unknown.
 */
function normalizePer1M(raw) {
  const parsed = parseRawPrice(raw);
  if (parsed == null) return null;
  // Negative values are sentinels for "unknown price" (e.g. Kilo's `kilo-auto/*` = -1).
  if (parsed < 0) return null;
  // Unconditional conversion: $/token → $/1M tokens (0 stays 0 for free models).
  return roundPrice(parsed * PER_MILLION);
}

/**
 * Normalises a price that is already expressed in USD per 1M tokens (catalog values).
 * Unlike {@link normalizePer1M} this does **not** scale the value — it only rejects
 * invalid/negative entries.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function sanitizePer1M(value) {
  if (value == null) return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return null;
  return num;
}

/**
 * Normalises a whole pricing block coming straight from the provider.
 * Accepts both the OpenRouter/Kilo shape (`input_cache_read` / `input_cache_write`)
 * and the internal shape (`cacheRead` / `cacheWrite`).
 *
 * @param {object|null} pricing - Raw provider pricing block.
 * @returns {{prompt: number|null, completion: number|null, cacheRead: number|null, cacheWrite: number|null}|null}
 */
function normalizePricingBlock(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;

  const prompt = normalizePer1M(pricing.prompt);
  const completion = normalizePer1M(pricing.completion);
  const cacheRead = normalizePer1M(pricing.input_cache_read ?? pricing.cacheRead);
  const cacheWrite = normalizePer1M(pricing.input_cache_write ?? pricing.cacheWrite);

  if (prompt == null && completion == null && cacheRead == null && cacheWrite == null) {
    return null;
  }

  return { prompt, completion, cacheRead, cacheWrite };
}

/**
 * Sanitises a stored catalog entry (already in USD per 1M tokens).
 *
 * @param {object|null} entry
 * @returns {{prompt: number|null, completion: number|null, cacheRead: number|null, cacheWrite: number|null}|null}
 */
function sanitizePricingEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const prompt = sanitizePer1M(entry.prompt);
  const completion = sanitizePer1M(entry.completion);
  const cacheRead = sanitizePer1M(entry.cacheRead ?? entry.input_cache_read);
  const cacheWrite = sanitizePer1M(entry.cacheWrite ?? entry.input_cache_write);

  if (prompt == null && completion == null && cacheRead == null && cacheWrite == null) {
    return null;
  }

  return { prompt, completion, cacheRead, cacheWrite };
}

/**
 * True when a pricing entry carries at least one usable (non-negative) price.
 *
 * @param {object|null} pricing
 * @returns {boolean}
 */
function isPriced(pricing) {
  if (!pricing || typeof pricing !== 'object') return false;
  return (
    sanitizePer1M(pricing.prompt) != null ||
    sanitizePer1M(pricing.completion) != null ||
    sanitizePer1M(pricing.cacheRead) != null ||
    sanitizePer1M(pricing.cacheWrite) != null
  );
}

/**
 * True when the model is known to cost money (a known, positive price).
 * Models with an unknown price are *not* considered paid — we cannot prove they are.
 *
 * @param {object|null} pricing
 * @returns {boolean}
 */
function isPaidModel(pricing) {
  if (!pricing || typeof pricing !== 'object') return false;
  const prompt = sanitizePer1M(pricing.prompt);
  const completion = sanitizePer1M(pricing.completion);
  return (prompt != null && prompt > 0) || (completion != null && completion > 0);
}

module.exports = {
  PER_MILLION,
  parseRawPrice,
  normalizePer1M,
  sanitizePer1M,
  normalizePricingBlock,
  sanitizePricingEntry,
  isPriced,
  isPaidModel,
};
