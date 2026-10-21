'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

const {
  normalizePer1M,
  normalizePricingBlock,
  sanitizePer1M,
} = require('../services/ai/priceCatalog');

const pricing = require('../services/ai/pricing');
const { AiClient } = require('../services/ai/AiClient');
const { recordUsage } = require('../services/ai/usageRecorder');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (err) {
    console.error(`❌ ${label}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
    throw err;
  }
}

// ── In-memory database (catalog + aggregation) ──────────────────────────────

function createMemoryDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT,
      parent_id INTEGER
    );
    CREATE TABLE conversation_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      model TEXT,
      requested_model TEXT,
      response_model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      pricing_source TEXT,
      provider_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const settings = new Map();
  raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run.bind(null);

  const db = {
    getSetting(key) {
      const row = raw.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) {
      raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    },
    getConversation(id) {
      return raw.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;
    },
    getConversationSubtreeIds(conversationId) {
      const ids = new Set([Number(conversationId)]);
      let frontier = [Number(conversationId)];
      while (frontier.length > 0) {
        const placeholders = frontier.map(() => '?').join(',');
        const children = raw.prepare(
          `SELECT id FROM conversations WHERE parent_id IN (${placeholders})`
        ).all(...frontier);
        frontier = children.map(c => Number(c.id)).filter(id => !ids.has(id));
        for (const id of frontier) ids.add(id);
      }
      return Array.from(ids);
    },
    recordTokenUsage(data) {
      const result = raw.prepare(`
        INSERT INTO conversation_token_usage (
          conversation_id, model, requested_model, response_model,
          prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, pricing_source, provider_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        data.conversation_id,
        data.model || null,
        data.requested_model || null,
        data.response_model || null,
        Number(data.prompt_tokens) || 0,
        Number(data.completion_tokens) || 0,
        Number(data.cache_read_tokens) || 0,
        Number(data.cache_write_tokens) || 0,
        data.cost_usd != null ? Number(data.cost_usd) : null,
        data.pricing_source || null,
        data.provider_id != null ? Number(data.provider_id) : null
      );
      return result.lastInsertRowid;
    },
    raw,
  };

  // The aggregation lives in the real DatabaseAPI — reuse it against the memory DB.
  const { DatabaseAPI } = require('../services/db/api');
  const api = new DatabaseAPI({
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
  });
  db.api = api;

  return db;
}

// ── 1. Canonical normalisation (A1) ────────────────────────────────────────

check('per-token string is converted to per-1M', () => {
  assert.strictEqual(normalizePer1M('0.000002'), 2);
  assert.strictEqual(normalizePer1M('0.000003'), 3);
  assert.strictEqual(normalizePer1M('0.00001'), 10);
});

check('negative sentinel becomes unknown (null), never a negative price', () => {
  assert.strictEqual(normalizePer1M('-1'), null);
  assert.strictEqual(normalizePer1M(-1), null);
  assert.strictEqual(normalizePer1M('-0.5'), null);
});

check('free model keeps a zero price', () => {
  assert.strictEqual(normalizePer1M('0'), 0);
  assert.strictEqual(normalizePer1M(0), 0);
});

check('missing/garbage prices become unknown', () => {
  assert.strictEqual(normalizePer1M(null), null);
  assert.strictEqual(normalizePer1M(undefined), null);
  assert.strictEqual(normalizePer1M(''), null);
  assert.strictEqual(normalizePer1M('not-a-price'), null);
});

check('the old "< 0.01 heuristic" is gone (no double conversion)', () => {
  // 0.000002 must become exactly 2 — not 2000000.
  assert.strictEqual(normalizePer1M('0.000002'), 2);
});

check('pricing block carries the cache prices', () => {
  const block = normalizePricingBlock({
    prompt: '0.000002',
    completion: '0.00001',
    input_cache_read: '0.0000002',
    input_cache_write: '0.0000025',
  });
  assert.deepStrictEqual(block, {
    prompt: 2,
    completion: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  });
});

check('a block with only the -1 sentinel normalizes to null', () => {
  assert.strictEqual(normalizePricingBlock({ prompt: '-1', completion: '-1' }), null);
});

check('stored per-1M values are sanitized, not rescaled', () => {
  assert.strictEqual(sanitizePer1M(2), 2);
  assert.strictEqual(sanitizePer1M(-1), null);
  assert.strictEqual(sanitizePer1M(null), null);
});

// ── 2. Cost computation (A2) ───────────────────────────────────────────────

check('unknown pricing yields null, never 0', () => {
  assert.strictEqual(pricing.computeCostUsd(1000, 100, null), null);
});

check('negative price yields null', () => {
  assert.strictEqual(
    pricing.computeCostUsd(1000, 100, { prompt: -1, completion: -1 }),
    null
  );
});

check('prompt + completion are priced per 1M tokens', () => {
  const cost = pricing.computeCostUsd(1_000_000, 500_000, { prompt: 2, completion: 10 });
  assert.strictEqual(cost, 2 + 5);
});

check('cache read/write prices are applied', () => {
  const cost = pricing.computeCostUsd(
    1_000_000,
    0,
    { prompt: 2, completion: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    { read: 400_000, write: 100_000 }
  );
  // 600k fresh prompt tokens at $2/1M + 400k cache reads at $0.2/1M + 100k writes at $2.5/1M
  assert.strictEqual(cost, 1.2 + 0.08 + 0.25);
});

check('cache tokens without a cache price are unpriceable', () => {
  assert.strictEqual(
    pricing.computeCostUsd(1_000_000, 0, { prompt: 2, completion: 10 }, { read: 400_000 }),
    null
  );
});

check('a token class without a price makes the call unpriceable', () => {
  assert.strictEqual(pricing.computeCostUsd(1000, 100, { prompt: 2 }), null);
});

// ── 3. Catalog semantics (A2) ──────────────────────────────────────────────

const memoryDb = createMemoryDb();
pricing.setPricingDb(memoryDb);

check('catalog stores and returns the per-1M prices', () => {
  pricing.cacheModelPricing(
    [{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: 2, completion: 10 } }],
    { providerId: 7 }
  );
  const entry = pricing.getModelPricing('anthropic/claude-sonnet-5');
  assert.strictEqual(entry.prompt, 2);
  assert.strictEqual(entry.completion, 10);
});

check('unknown model returns null (never a fabricated 0)', () => {
  assert.strictEqual(pricing.getModelPricing('does/not-exist'), null);
});

check('the -1 sentinel is not stored as a price', () => {
  pricing.cacheModelPricing(
    [{ id: 'kilo-auto/frontier', pricing: { prompt: -1, completion: -1 } }],
    { providerId: 7 }
  );
  const entry = pricing.getModelPricing('kilo-auto/frontier');
  assert.strictEqual(entry, null);
});

check('a refresh replaces the previous scope (no stale entries survive)', () => {
  pricing.cacheModelPricing(
    [{ id: 'stale/model', pricing: { prompt: 1, completion: 1 } }],
    { providerId: 7 }
  );
  assert.ok(pricing.getModelPricing('stale/model'));
  pricing.cacheModelPricing(
    [{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: 2, completion: 10 } }],
    { providerId: 7 }
  );
  assert.strictEqual(pricing.getModelPricing('stale/model'), null);
});

check('a legacy flat catalog with -1 is read as unknown', () => {
  memoryDb.setSetting('model_pricing', JSON.stringify({
    'legacy/model': { prompt: -1, completion: -1 },
    'legacy/ok': { prompt: 3, completion: 6 },
  }));
  assert.strictEqual(pricing.getModelPricing('legacy/model'), null);
  assert.strictEqual(pricing.getModelPricing('legacy/ok').prompt, 3);
});

// ── 4. Recording + aggregation (A5/A6/A7) ──────────────────────────────────

check('the recorder stores the cost and the audit columns', () => {
  pricing.cacheModelPricing(
    [{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: 2, completion: 10 } }],
    { providerId: 7 }
  );
  const result = recordUsage({
    db: memoryDb.api,
    conversationId: 1,
    requestedModel: 'anthropic/claude-sonnet-5',
    responseModel: 'anthropic/claude-sonnet-5',
    usage: { promptTokens: 1_000_000, completionTokens: 100_000 },
    providerId: 7,
  });
  assert.strictEqual(result.recorded, true);
  assert.strictEqual(result.costUsd, 2 + 1);
  assert.strictEqual(result.pricingSource, 'provider');

  const row = memoryDb.raw.prepare('SELECT * FROM conversation_token_usage WHERE conversation_id = 1').get();
  assert.strictEqual(row.requested_model, 'anthropic/claude-sonnet-5');
  assert.strictEqual(row.response_model, 'anthropic/claude-sonnet-5');
  assert.strictEqual(row.pricing_source, 'provider');
  assert.strictEqual(row.cost_usd, 3);
});

check('an unpriced call is stored with a NULL cost', () => {
  recordUsage({
    db: memoryDb.api,
    conversationId: 1,
    requestedModel: 'unknown/model',
    usage: { promptTokens: 100, completionTokens: 10 },
  });
  const row = memoryDb.raw.prepare(
    'SELECT * FROM conversation_token_usage WHERE response_model IS NULL AND requested_model = ?'
  ).get('unknown/model');
  assert.strictEqual(row.cost_usd, null);
  assert.strictEqual(row.pricing_source, 'unknown');
});

check('the aggregation reports the coverage of priced calls', () => {
  const usage = memoryDb.api.getConversationTokenUsage(1);
  assert.strictEqual(usage.call_count, 2);
  assert.strictEqual(usage.priced_calls, 1);
  assert.strictEqual(usage.unpriced_calls, 1);
  assert.ok(usage.coverage < 1, 'coverage must be below 1 when a call is unpriced');
  assert.strictEqual(usage.partial, true);
  assert.strictEqual(usage.total_cost_usd, 3);
});

check('the strict aggregation refuses to show a partial total', () => {
  const usage = memoryDb.api.getConversationTokenUsage(1, { strict: true });
  assert.strictEqual(usage.total_cost_usd, null);
});

check('the per-model breakdown is available', () => {
  const breakdown = memoryDb.api.getConversationTokenUsageByModel(1);
  assert.ok(Array.isArray(breakdown));
  const unknown = breakdown.find(entry => entry.model === 'unknown/model');
  assert.ok(unknown, 'the unpriced model must appear in the breakdown');
  assert.strictEqual(unknown.cost_usd, null);
  assert.strictEqual(unknown.unpriced_calls, 1);
});

// ── 5. Streaming usage capture (A4) ────────────────────────────────────────

async function collectChunks(chunks) {
  const client = new AiClient({ apiKey: 'test', baseUrl: 'http://localhost:1' });
  const seen = [];
  async function* stream() {
    for (const chunk of chunks) yield chunk;
  }
  await client._processStream(stream(), (chunk) => seen.push(chunk));
  return seen;
}

async function runStreamingTests() {
  const finishChunks = await collectChunks([
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], model: 'anthropic/claude-sonnet-5' },
    { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56 } },
  ]);

  const finish = finishChunks.find(chunk => chunk.type === 'finish');
  check('the finish event is emitted exactly once', () => {
    assert.strictEqual(finishChunks.filter(c => c.type === 'finish').length, 1);
  });
  check('usage arriving after the finish_reason chunk is still captured', () => {
    assert.ok(finish, 'a finish event must be emitted');
    assert.strictEqual(finish.usage.promptTokens, 1234);
    assert.strictEqual(finish.usage.completionTokens, 56);
  });
  check('the responded model is captured', () => {
    assert.strictEqual(finish.responseModel, 'anthropic/claude-sonnet-5');
  });

  const kiloChunks = await collectChunks([
    { choices: [{ delta: { content: 'hi' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      model: 'kilo-auto/frontier',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  ]);
  const kiloFinish = kiloChunks.find(chunk => chunk.type === 'finish');
  check('the provider usage in the finish_reason chunk still works (Kilo shape)', () => {
    assert.strictEqual(kiloFinish.usage.promptTokens, 10);
    assert.strictEqual(kiloFinish.usage.completionTokens, 20);
  });

  const noUsageChunks = await collectChunks([
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  check('a stream without usage still emits the finish event', () => {
    const f = noUsageChunks.find(chunk => chunk.type === 'finish');
    assert.ok(f);
    assert.strictEqual(f.usage, null);
  });

  const cachedChunks = await collectChunks([
    { choices: [{ delta: { content: 'hi' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 600 },
      },
    },
  ]);
  const cachedFinish = cachedChunks.find(chunk => chunk.type === 'finish');
  check('cache token counters are captured', () => {
    assert.strictEqual(cachedFinish.usage.cacheReadTokens, 600);
    assert.strictEqual(cachedFinish.usage.cacheIncludedInPrompt, true);
  });
}

runStreamingTests()
  .then(() => {
    pricing.closeSharedConnection();
    pricing.setPricingDb(null);
    console.log(`\nAll pricing tests passed (${passed} checks).`);
  })
  .catch((err) => {
    pricing.closeSharedConnection();
    console.error(err);
    process.exit(1);
  });
