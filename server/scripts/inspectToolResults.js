#!/usr/bin/env node
'use strict';

/**
 * One-off diagnostic: inspects `role='tool'` messages per conversation for the
 * signatures of the "tool result lost between execution and history" bug.
 *
 * Signatures of the loss point:
 *   - tool_result = '{}'               (masked empty — old handleToolResult fallback)
 *   - tool_result = NULL                (never written)
 *   - status = 'processing' with no processed_at (stuck / never finalized)
 *   - tool_result containing the {"__empty":true} marker
 *
 * Also prints the current PRAGMA journal_mode for the connection.
 *
 * Usage:
 *   node server/scripts/inspectToolResults.js [--conversation <id>] [--only-problems]
 */

const { DatabaseConnection } = require('../services/db');

function parseArgs(argv) {
  const args = { conversationId: null, onlyProblems: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--conversation') args.conversationId = Number(argv[++i]);
    else if (a === '--only-problems') args.onlyProblems = true;
  }
  return args;
}

function classify(row) {
  const tr = row.tool_result;
  const markers = [];
  if (tr === null) markers.push('NULL');
  else if (tr === '{}') markers.push("'{}'");
  else if (tr && tr.includes('"__empty"')) markers.push('__empty');
  if (row.status === 'processing' && !row.processed_at) markers.push('stuck-processing');
  return markers;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new DatabaseConnection();
  try {
    const journal = connection.db.pragma('journal_mode');
    const journalVal = Array.isArray(journal) && journal[0]
      ? journal[0].journal_mode
      : (typeof journal === 'string' ? journal : JSON.stringify(journal));
    console.log(`[journal_mode] ${journalVal}`);

    let convFilter = '';
    const params = [];
    if (args.conversationId) {
      convFilter = 'WHERE m.conversation_id = ?';
      params.push(args.conversationId);
    }

    const rows = connection.db.prepare(`
      SELECT m.id, m.conversation_id, m.tool_name, m.status, m.processed_at,
             m.tool_result, c.title
      FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      ${convFilter}
      ORDER BY m.conversation_id ASC, m.id ASC
    `).all(...params).filter((r) => r.tool_name !== null);

    let problems = 0;
    let total = 0;
    let currentConv = null;

    for (const row of rows) {
      total++;
      const markers = classify(row);
      if (args.onlyProblems && markers.length === 0) continue;

      if (row.conversation_id !== currentConv) {
        currentConv = row.conversation_id;
        console.log(`\n=== Conversation ${currentConv} (${row.title || 'no title'}) ===`);
      }

      const preview = row.tool_result === null
        ? '<NULL>'
        : String(row.tool_result).substring(0, 200);
      const len = row.tool_result === null ? 0 : String(row.tool_result).length;

      const flag = markers.length ? `  *** ${markers.join(', ')}` : '';
      if (markers.length) problems++;
      console.log(
        `  #${row.id} ${row.tool_name} status=${row.status} processed_at=${row.processed_at || '-'} len=${len}${flag}`
      );
      if (!args.onlyProblems) {
        console.log(`      ${JSON.stringify(preview)}`);
      }
    }

    console.log(`\n=== Summary: ${total} tool messages, ${problems} with loss signatures ===`);
    if (problems === 0 && total > 0) {
      console.log('No empty/NULL/stuck tool results found.');
    }
  } finally {
    connection.close();
  }
}

main();
