#!/usr/bin/env node
'use strict';

/**
 * Ground-truth cost probe.
 *
 * Sends one fixed, small request to a named model and prints the cost MiniBoss
 * computes for it. The operator then reads the same request in the provider's
 * dashboard (e.g. the Kilo dashboard) and compares the two numbers.
 *
 * Usage:
 *   node server/scripts/costProbe.js --model <model-id> [options]
 *
 * Options:
 *   --model <id>       Model to probe (required).
 *   --provider <id>    Provider to use (default: the active one).
 *   --prompt <text>    Prompt to send (default: a fixed, short one).
 *   --json             Print machine-readable JSON only.
 *
 * The documented tolerance is the cache-read discount: the OpenAI-compatible
 * response does not expose the cache counters, so a cached prompt may be billed
 * cheaper by the provider than the estimate printed here.
 */

const { DatabaseAPI, DatabaseConnection } = require('../services/db');
const { AiClient } = require('../services/ai/AiClient');
const pricing = require('../services/ai/pricing');

const DEFAULT_PROMPT = 'Reply with exactly the word: ok';

function parseArgs(argv) {
  const args = { model: null, providerId: null, prompt: DEFAULT_PROMPT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model') args.model = argv[++i];
    else if (arg === '--provider') args.providerId = Number(argv[++i]);
    else if (arg === '--prompt') args.prompt = argv[++i];
    else if (arg === '--json') args.json = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    console.error('Usage: node server/scripts/costProbe.js --model <model-id> [--provider <id>] [--json]');
    return 2;
  }

  const connection = new DatabaseConnection();
  const db = new DatabaseAPI(connection);

  try {
    const provider = args.providerId != null
      ? db.getProvider(args.providerId)
      : (db.getActiveProviders()[0] || null);

    if (!provider) {
      console.error('No provider configured (no active provider found).');
      return 2;
    }

    // Make sure the catalog matches the provider before pricing anything.
    const refresh = await pricing.refreshModelPricing({
      provider,
      providerId: provider.id,
      force: true,
    });
    if (!refresh.ok) {
      console.warn(`[costProbe] Catalog refresh failed (${refresh.error}); using the cached catalog.`);
    }

    const client = new AiClient({
      apiKey: provider.api_key || 'dummy',
      baseUrl: provider.base_url,
      timeout: 120000,
      maxRetries: 1,
    });

    let result;
    try {
      result = await client.chatCompletion({
        model: args.model,
        messages: [{ role: 'user', content: args.prompt }],
        maxTokens: 32,
      });
    } finally {
      client.close();
    }

    const usage = result.usage || null;
    const responseModel = result.responseModel || args.model;
    const entry = pricing.getModelPricing(responseModel) || pricing.getModelPricing(args.model);

    const costUsd = usage
      ? pricing.computeCostUsd(
        usage.promptTokens || 0,
        usage.completionTokens || 0,
        entry,
        { read: usage.cacheReadTokens || 0, write: usage.cacheWriteTokens || 0 },
        { cacheIncludedInPrompt: usage.cacheIncludedInPrompt !== false }
      )
      : null;

    const report = {
      provider: { id: provider.id, name: provider.name, base_url: provider.base_url },
      requested_model: args.model,
      response_model: responseModel,
      prompt: args.prompt,
      usage: usage ? {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        cache_read_tokens: usage.cacheReadTokens || 0,
        cache_write_tokens: usage.cacheWriteTokens || 0,
      } : null,
      price_per_1m: entry ? {
        prompt: entry.prompt,
        completion: entry.completion,
        cache_read: entry.cacheRead,
        cache_write: entry.cacheWrite,
      } : null,
      computed_cost_usd: costUsd,
      catalog_fetched_at: entry?.fetchedAt || null,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return costUsd == null ? 1 : 0;
    }

    console.log('── Cost probe ──');
    console.log(`Provider:     ${provider.name} (${provider.base_url})`);
    console.log(`Model:        ${args.model}${responseModel !== args.model ? ` → answered by ${responseModel}` : ''}`);
    console.log(`Prompt:       ${JSON.stringify(args.prompt)}`);
    console.log(`Usage:        prompt=${usage?.promptTokens ?? '—'} completion=${usage?.completionTokens ?? '—'} cache_read=${usage?.cacheReadTokens ?? 0} cache_write=${usage?.cacheWriteTokens ?? 0}`);
    console.log(`Price/1M:     ${entry ? `prompt=${entry.prompt} completion=${entry.completion} cache_read=${entry.cacheRead ?? '—'} cache_write=${entry.cacheWrite ?? '—'}` : '(unknown — the model has no catalog entry)'}`);
    console.log(`Computed cost: ${costUsd == null ? 'UNKNOWN (no price for this model)' : '$' + costUsd.toFixed(8)}`);
    console.log('');
    console.log('Now open the provider dashboard, find this same request and compare the billed amount.');
    console.log('Expected tolerance: the cache-read discount (the OpenAI-compatible response does not');
    console.log('expose the cache counters, so a cached prompt is billed cheaper than the estimate above).');

    return costUsd == null ? 1 : 0;
  } finally {
    connection.close();
    pricing.closeSharedConnection();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[costProbe] Failed:', err && err.stack ? err.stack : err);
    process.exit(2);
  });
