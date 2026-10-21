#!/usr/bin/env node
'use strict';

/**
 * Cost reconciliation harness.
 *
 * Recomputes the cost of every recorded AI call with the current algorithm and
 * compares it with the value stored in `conversation_token_usage`. Also detects
 * calls whose usage was never recorded (lost usage).
 *
 * Usage:
 *   node server/scripts/costAudit.js [options]
 *
 * Options:
 *   --conversation <id>   Only audit this conversation (and its descendants).
 *   --since <YYYY-MM-DD> Only audit rows created after this date.
 *   --provider <id>       Provider used to refresh the live catalog (default: active).
 *   --tolerance <pct>     Allowed delta, in percent (default: 1).
 *   --no-network          Do not fetch the live catalog; use the cached one.
 *
 * Exit code is non-zero when the delta exceeds the tolerance or when unpriced
 * calls are found — usable as a CI/regression check.
 */

const path = require('path');
const { DatabaseAPI, DatabaseConnection } = require('../services/db');
const { AiClient } = require('../services/ai/AiClient');
const pricing = require('../services/ai/pricing');
const { computeCostUsd } = pricing;

function parseArgs(argv) {
  const args = {
    conversationId: null,
    since: null,
    providerId: null,
    tolerancePct: 1,
    network: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--conversation') args.conversationId = Number(argv[++i]);
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--provider') args.providerId = Number(argv[++i]);
    else if (arg === '--tolerance') args.tolerancePct = Number(argv[++i]);
    else if (arg === '--no-network') args.network = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }

  return args;
}

function fmtUsd(value) {
  if (value == null) return '—';
  if (Math.abs(value) >= 0.01) return '$' + value.toFixed(4);
  return '$' + value.toFixed(8);
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(2) + '%';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 18).join('\n'));
    return 0;
  }

  const connection = new DatabaseConnection();
  const db = new DatabaseAPI(connection);

  try {
    // ── 1. Live catalog ───────────────────────────────────────────────────
    let provider = null;
    if (args.providerId != null) {
      provider = db.getProvider(args.providerId);
    } else {
      const active = db.getActiveProviders() || [];
      provider = active[0] || null;
    }

    const catalogStatus = pricing.getCatalogStatus();
    console.log('── Cost audit ──');
    console.log(`Provider: ${provider ? `${provider.name} (id=${provider.id}) ${provider.base_url}` : '(none configured)'}`);
    console.log(`Cached catalog: ${catalogStatus.modelCount} model(s), fetched ${catalogStatus.fetchedAt || 'never'}`);

    if (provider && args.network) {
      const refresh = await pricing.refreshModelPricing({ provider, providerId: provider.id, force: true });
      if (refresh.ok) {
        console.log(`Live catalog: ${refresh.models.length} model(s) fetched from the provider`);
      } else {
        console.log(`Live catalog: FAILED (${refresh.error}) — using the cached catalog`);
      }
    } else if (provider) {
      console.log('Live catalog: skipped (--no-network)');
    }

    // ── 2. Rows ───────────────────────────────────────────────────────────
    const conversationIds = args.conversationId != null
      ? db.getConversationSubtreeIds(args.conversationId)
      : null;

    const where = [];
    const params = [];
    if (conversationIds) {
      where.push(`conversation_id IN (${conversationIds.map(() => '?').join(',')})`);
      params.push(...conversationIds);
    }
    if (args.since) {
      where.push('created_at >= ?');
      params.push(args.since);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db.connection.prepare(`
      SELECT * FROM conversation_token_usage ${whereSql} ORDER BY id
    `).all(...params);

    console.log(`\nRows audited: ${rows.length}`);

    // ── 3. Recompute ──────────────────────────────────────────────────────
    const perModel = new Map();
    let totalStored = 0;
    let totalRecomputed = 0;
    let pricedCalls = 0;
    let unpricedCalls = 0;
    const driftRows = [];
    let maxDeltaPct = 0;

    for (const row of rows) {
      const pricingEntry = pricing.getModelPricing(row.response_model)
        || pricing.getModelPricing(row.model)
        || pricing.getModelPricing(row.requested_model);

      const recomputed = computeCostUsd(
        row.prompt_tokens,
        row.completion_tokens,
        pricingEntry,
        { read: row.cache_read_tokens || 0, write: row.cache_write_tokens || 0 },
        { cacheIncludedInPrompt: true }
      );

      const stored = row.cost_usd != null ? Number(row.cost_usd) : null;
      if (stored != null) totalStored += stored;
      if (recomputed != null) totalRecomputed += recomputed;
      if (stored == null) unpricedCalls += 1;
      else pricedCalls += 1;

      const modelKey = row.response_model || row.requested_model || row.model || '(unknown)';
      const bucket = perModel.get(modelKey) || {
        model: modelKey,
        calls: 0,
        stored: 0,
        recomputed: 0,
        unpriced: 0,
        negative: 0,
      };
      bucket.calls += 1;
      if (stored != null) bucket.stored += stored;
      else bucket.unpriced += 1;
      if (stored != null && stored < 0) bucket.negative += 1;
      if (recomputed != null) bucket.recomputed += recomputed;
      perModel.set(modelKey, bucket);

      if (stored != null && recomputed != null) {
        const delta = recomputed - stored;
        const deltaPct = stored === 0 ? (recomputed === 0 ? 0 : 100) : Math.abs(delta / stored) * 100;
        if (deltaPct > maxDeltaPct) maxDeltaPct = deltaPct;
        if (deltaPct > args.tolerancePct) {
          driftRows.push({ row, stored, recomputed, delta, deltaPct });
        }
      } else if (stored != null && recomputed == null) {
        driftRows.push({ row, stored, recomputed: null, delta: null, deltaPct: 100 });
      }
    }

    // ── 4. Lost usage ─────────────────────────────────────────────────────
    const lostUsage = detectLostUsage(db, conversationIds, args.since);

    // ── 5. Summary ────────────────────────────────────────────────────────
    console.log('\n── Per model ──');
    for (const bucket of [...perModel.values()].sort((a, b) => b.recomputed - a.recomputed)) {
      console.log(
        `  ${bucket.model.padEnd(42)} calls=${String(bucket.calls).padStart(4)} ` +
        `stored=${fmtUsd(bucket.stored).padStart(12)} recomputed=${fmtUsd(bucket.recomputed).padStart(12)} ` +
        `unpriced=${bucket.unpriced}` +
        (bucket.negative ? `  ⚠ negative=${bucket.negative}` : '')
      );
    }

    console.log('\n── Summary ──');
    console.log(`  Stored total:     ${fmtUsd(totalStored)}`);
    console.log(`  Recomputed total: ${fmtUsd(totalRecomputed)}`);
    console.log(`  Delta:            ${fmtUsd(totalRecomputed - totalStored)}`);
    console.log(`  Max per-row delta: ${fmtPct(maxDeltaPct)} (tolerance ${args.tolerancePct}%)`);
    console.log(`  Priced calls:     ${pricedCalls}`);
    console.log(`  Unpriced calls:   ${unpricedCalls}`);
    console.log(`  Rows over tolerance: ${driftRows.length}`);

    if (lostUsage.length > 0) {
      const current = lostUsage.filter(entry => !entry.legacy);
      const legacy = lostUsage.filter(entry => entry.legacy);
      if (current.length > 0) {
        console.log('\n── Lost usage (messages with usage but no usage row) ──');
        for (const entry of current) {
          console.log(`  conversation ${entry.conversation_id}: ${entry.messages_with_usage} message(s) with usage, ${entry.rows} usage row(s) (last ${entry.last_message_at})`);
        }
      }
      if (legacy.length > 0) {
        console.log(`\n── Lost usage before usage recording existed: ${legacy.length} conversation(s) (out of scope, history is not rewritten) ──`);
      }
    } else {
      console.log('\n── Lost usage: none detected ──');
    }

    if (driftRows.length > 0) {
      console.log('\n── Rows over tolerance (first 20) ──');
      for (const drift of driftRows.slice(0, 20)) {
        console.log(
          `  #${drift.row.id} conv=${drift.row.conversation_id} model=${drift.row.model} ` +
          `stored=${fmtUsd(drift.stored)} recomputed=${fmtUsd(drift.recomputed)} delta=${fmtPct(drift.deltaPct)}`
        );
      }
    }

    const negativeRows = rows.filter(row => row.cost_usd != null && Number(row.cost_usd) < 0);
    if (negativeRows.length > 0) {
      console.log(`\n⚠ ${negativeRows.length} stored row(s) with a NEGATIVE cost (written by the old algorithm).`);
    }

    const currentLostUsage = lostUsage.filter(entry => !entry.legacy);
    const failed = driftRows.length > 0
      || unpricedCalls > 0
      || negativeRows.length > 0
      || currentLostUsage.length > 0;
    console.log(`\nResult: ${failed ? 'FAIL' : 'OK'}`);
    return failed ? 1 : 0;
  } finally {
    connection.close();
    pricing.closeSharedConnection();
  }
}

/**
 * Counts assistant messages carrying a usage block that have no matching row in
 * `conversation_token_usage` — the fingerprint of a lost recording (A6/A7).
 *
 * Conversations whose messages all predate the first recorded usage row are
 * reported separately: they belong to the era before usage was recorded at all
 * and are out of scope (history is never rewritten).
 */
function detectLostUsage(db, conversationIds, since) {
  const where = ["role = 'assistant'", "raw_response IS NOT NULL", "raw_response != ''"];
  const params = [];
  if (conversationIds) {
    where.push(`conversation_id IN (${conversationIds.map(() => '?').join(',')})`);
    params.push(...conversationIds);
  }
  if (since) {
    where.push('created_at >= ?');
    params.push(since);
  }

  const rows = db.connection.prepare(`
    SELECT conversation_id, raw_response, created_at FROM messages WHERE ${where.join(' AND ')}
  `).all(...params);

  const withUsage = new Map();
  for (const row of rows) {
    let parsed = null;
    try {
      parsed = JSON.parse(row.raw_response);
    } catch (_) {
      continue;
    }
    const usage = parsed && parsed.usage;
    if (!usage || typeof usage !== 'object') continue;
    const hasTokens = usage.prompt_tokens != null || usage.completion_tokens != null;
    if (!hasTokens) continue;
    const entry = withUsage.get(row.conversation_id) || { count: 0, last: null };
    entry.count += 1;
    if (!entry.last || String(row.created_at) > String(entry.last)) entry.last = row.created_at;
    withUsage.set(row.conversation_id, entry);
  }

  // The first recorded usage row marks the moment usage recording became active.
  const firstRow = db.connection.prepare(
    'SELECT MIN(created_at) AS first FROM conversation_token_usage'
  ).get();
  const recordingStartedAt = firstRow?.first || null;

  const lost = [];
  for (const [conversationId, entry] of withUsage) {
    const row = db.connection.prepare(
      'SELECT COUNT(*) AS c FROM conversation_token_usage WHERE conversation_id = ?'
    ).get(conversationId);
    const usageRows = Number(row?.c) || 0;
    if (entry.count <= usageRows) continue;

    const legacy = recordingStartedAt != null && String(entry.last) < String(recordingStartedAt);
    lost.push({
      conversation_id: conversationId,
      messages_with_usage: entry.count,
      rows: usageRows,
      last_message_at: entry.last,
      legacy,
    });
  }

  return lost;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[costAudit] Failed:', err && err.stack ? err.stack : err);
    process.exit(2);
  });
