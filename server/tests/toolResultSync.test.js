'use strict';

const assert = require('assert');

let passed = 0;
const failed = [];
function check(label, fn) {
  return (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${label}`);
    } catch (err) {
      failed.push({ label, err });
      console.error(`❌ ${label}`);
      console.error(err && err.stack ? err.stack : err);
    }
  })();
}

const TOOLS_WITHOUT_REPORT = 'tools_without_report';
const TOOLS_WITH_REPORT = 'tools_with_report';

function runCommandMessage() {
  return {
    role: 'assistant',
    tool_calls: JSON.stringify([
      { id: 'call_run_1', type: 'function', function: { name: 'runCommand', arguments: '{}' } },
    ]),
  };
}

function investigateMessage() {
  return {
    role: 'assistant',
    tool_calls: JSON.stringify([
      { id: 'call_inv_1', type: 'function', function: { name: 'investigate', arguments: '{}' } },
    ]),
  };
}

function makeCm(db = {}, socket = {}, toolProcessor = {}) {
  const ConversationManager = require('../services/conversationManager');
  return new ConversationManager(
    db,
    { broadcastToConversation() {}, broadcastStreamDone() {}, broadcastAIStatus() {}, ...socket },
    { setConversationManager() {}, trigger() {}, ...toolProcessor }
  );
}

function createSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      folder_path TEXT,
      sandbox_image TEXT,
      sandbox_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      provider_id INTEGER,
      model TEXT,
      parent_id INTEGER,
      worktree_path TEXT,
      repo_root TEXT,
      git_branch TEXT,
      base_branch TEXT,
      conversation_type TEXT,
      focus_goal TEXT,
      focus_report TEXT,
      plan TEXT,
      mode TEXT,
      active_focus_id INTEGER,
      processing_state TEXT DEFAULT 'idle',
      phase TEXT DEFAULT 'idle',
      max_iterations INTEGER DEFAULT 20,
      last_summarized_at DATETIME,
      ai_touched_files TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_sent_ai_msg_id INTEGER,
      thinking_mode TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      raw_response TEXT,
      status TEXT DEFAULT 'completed',
      error_message TEXT,
      thinking_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    );
  `);
}

async function testMainToolsWithoutReportGoesToToolExec() {
  const cm = makeCm();
  const conv = { id: 1, conversation_type: 'main', phase: 'active', max_iterations: 20 };
  const state = cm._computeMainNextState(conv, TOOLS_WITHOUT_REPORT, runCommandMessage());
  assert.strictEqual(state.processingState, 'tool_exec', 'main tools_without_report should be tool_exec');
  assert.strictEqual(state.phase, 'active', 'main should stay active');
  assert.strictEqual(state.hasToolCalls, true, 'main should have tools');
}

async function testMainInvestigateWaitsForFocus() {
  const cm = makeCm();
  const conv = { id: 1, conversation_type: 'main', phase: 'active', max_iterations: 20 };
  const state = cm._computeMainNextState(conv, TOOLS_WITHOUT_REPORT, investigateMessage());
  assert.strictEqual(state.phase, 'waiting_focus', 'investigate should wait for focus');
  assert.strictEqual(state.processingState, 'idle', 'investigate should be idle while focus runs');
}

async function testFocusFinalizingToolsWithoutReportGoesToToolExec() {
  const cm = makeCm();
  const conv = { id: 2, conversation_type: 'focus', phase: 'finalizing', max_iterations: 20 };
  const state = cm._computeFocusNextState(conv, TOOLS_WITHOUT_REPORT, runCommandMessage());
  assert.strictEqual(state.phase, 'finalizing_grace', 'focus finalizing should move to finalizing_grace');
  assert.strictEqual(state.processingState, 'tool_exec', 'focus finalizing tools should be tool_exec');
}

async function testProcessConversationSkipsAiWhenToolsPending() {
  const { DatabaseConnection } = require('../services/db/connection');
  const { DatabaseAPI } = require('../services/db/api');

  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);

    const project = db.createProject({ name: 'Tool Sync Test' });
    const conv = db.createConversation({ project_id: project.id, title: 'Main', conversation_type: 'main', max_iterations: 20 });
    db.updateProcessingState(conv.id, 'queued');
    db.createPendingToolMessage(conv.id, { id: 'call_run_1', function: { name: 'runCommand', arguments: '{}' } });

    const statuses = [];
    const cm = makeCm(db, { broadcastAIStatus(conversationId, state) { statuses.push(state); } });

    await cm.processConversation(db.getConversation(conv.id));

    const after = db.getConversation(conv.id);
    assert.strictEqual(after.processing_state, 'tool_exec', 'conversation should be moved to tool_exec');
    assert.strictEqual(after.max_iterations, 20, 'iterations must NOT be decremented (no AI call)');
    assert.ok(statuses.includes('tool_exec'), 'tool_exec ai-status must be broadcast');
    assert.ok(db.hasPendingToolsInConversation(conv.id), 'the pending tool message must still exist');
  } finally {
    connection.close();
  }
}

async function testProcessConversationSkipsAiWhenAlreadyToolExec() {
  const { DatabaseConnection } = require('../services/db/connection');
  const { DatabaseAPI } = require('../services/db/api');

  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);

    const project = db.createProject({ name: 'Tool Sync Test 2' });
    const conv = db.createConversation({ project_id: project.id, title: 'Main', conversation_type: 'main', max_iterations: 20 });
    db.updateProcessingState(conv.id, 'tool_exec');

    const cm = makeCm(db);

    await cm.processConversation(db.getConversation(conv.id));

    const after = db.getConversation(conv.id);
    assert.strictEqual(after.processing_state, 'tool_exec', 'conversation should remain tool_exec');
    assert.strictEqual(after.max_iterations, 20, 'iterations must NOT be decremented (no AI call)');
  } finally {
    connection.close();
  }
}

async function runTests() {
  console.log('Running toolResultSync tests...\n');
  const tests = [
    ['main tools_without_report → tool_exec', testMainToolsWithoutReportGoesToToolExec],
    ['main investigate → waiting_focus/idle', testMainInvestigateWaitsForFocus],
    ['focus finalizing tools_without_report → finalizing_grace/tool_exec', testFocusFinalizingToolsWithoutReportGoesToToolExec],
    ['processConversation skips AI when tools pending', testProcessConversationSkipsAiWhenToolsPending],
    ['processConversation skips AI when already tool_exec', testProcessConversationSkipsAiWhenAlreadyToolExec],
  ];

  for (const [name, fn] of tests) {
    await check(name, fn);
  }

  console.log(`\n${passed}/${tests.length} toolResultSync tests passed.`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
