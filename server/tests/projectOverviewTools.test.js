const assert = require('assert');

const { DatabaseConnection } = require('../services/db/connection');
const { DatabaseAPI } = require('../services/db/api');
const { createProjectTools } = require('../tools/projectTools');
const { generateConversationReport } = require('../services/conversationReport');

function createSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      folder_path TEXT,
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
      thinking_status TEXT,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT NOT NULL,
      is_active BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      global_conversation_id INTEGER NOT NULL,
      execution_conversation_id INTEGER NOT NULL UNIQUE,
      plan TEXT,
      status TEXT NOT NULL DEFAULT 'executing',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function makeStubClient(content, calls) {
  return {
    chatCompletion: async (params) => {
      if (calls) calls.push(params);
      return { content };
    }
  };
}

async function testListProjectConversationsMap() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);

    const project = db.createProject({ name: 'Overview' });
    const global = db.createConversation({ project_id: project.id, title: 'Project Memory', conversation_type: 'project' });
    const rootMain = db.createConversation({ project_id: project.id, title: 'Root Main', conversation_type: 'main' });
    const untrackedRoot = db.createConversation({ project_id: project.id, title: 'Untracked Root', conversation_type: 'main' });
    const childFocus = db.createConversation({
      project_id: project.id,
      title: 'Child Focus',
      conversation_type: 'focus',
      parent_id: rootMain.id,
    });

    db.createPlanExecution({
      project_id: project.id,
      global_conversation_id: global.id,
      execution_conversation_id: rootMain.id,
      status: 'executing',
    });

    const tools = createProjectTools(global.id, { db });

    const rootsOnly = await tools.listProjectConversations.handler({});
    assert.strictEqual(rootsOnly.conversations.length, 3, 'roots-only returns global + 2 roots');
    assert.strictEqual(rootsOnly.conversations[0].isProjectMemory, true, 'global conversation comes first');
    assert.strictEqual(rootsOnly.conversations[0].id, global.id, 'global id first');

    const linkedRow = rootsOnly.conversations.find(row => row.id === rootMain.id);
    assert(linkedRow, 'root main present');
    assert.strictEqual(linkedRow.linkedToExecution, true, 'root main is linked to execution');
    assert.strictEqual(linkedRow.executionStatus, 'executing', 'execution status surfaced');

    assert.strictEqual(rootsOnly.untracked.count, 1, 'only the untracked root counts');
    assert.deepStrictEqual(rootsOnly.untracked.conversationIds, [untrackedRoot.id], 'untracked root id listed');
    assert.strictEqual(rootsOnly.truncated, false, 'not truncated by default');

    const withChildren = await tools.listProjectConversations.handler({ includeChildren: true });
    const childRow = withChildren.conversations.find(row => row.id === childFocus.id);
    assert(childRow, 'child focus included with includeChildren');
    assert.strictEqual(childRow.parentId, rootMain.id, 'child parentId set');
    assert.strictEqual(childRow.conversationType, 'focus', 'child type preserved');

    const typed = await tools.listProjectConversations.handler({ types: ['main'] });
    assert(typed.conversations.every(row => row.conversationType === 'main'), 'types filter keeps only main');
    assert.strictEqual(typed.conversations.length, 2, 'two main roots remain');
    assert.strictEqual(typed.untracked.count, 1, 'untracked still computed over all roots');

    const limited = await tools.listProjectConversations.handler({ limit: 1 });
    assert.strictEqual(limited.conversations.length, 1, 'limit truncates rows');
    assert.strictEqual(limited.total, 3, 'total reflects untruncated count');
    assert.strictEqual(limited.truncated, true, 'truncated flag set');
  } finally {
    connection.close();
  }
}

async function testListProjectConversationsGuard() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const tools = createProjectTools(9999, { db });
    await assert.rejects(
      () => tools.listProjectConversations.handler({}),
      /Project Memory conversation/,
      'non-project conversation must be rejected'
    );
  } finally {
    connection.close();
  }
}

async function testRequestReportRejectsOtherProject() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const projectA = db.createProject({ name: 'A' });
    const projectB = db.createProject({ name: 'B' });
    const globalA = db.createConversation({ project_id: projectA.id, title: 'Memory A', conversation_type: 'project' });
    const targetB = db.createConversation({ project_id: projectB.id, title: 'Other project', conversation_type: 'main' });

    let factoryCalled = false;
    const tools = createProjectTools(globalA.id, {
      db,
      reportOptions: {
        aiClientFactory: () => {
          factoryCalled = true;
          return makeStubClient('should not run');
        }
      }
    });

    const res = await tools.requestConversationReport.handler({ conversationId: targetB.id });
    assert.strictEqual(res.report, null, 'no report for foreign conversation');
    assert.match(res.error, /does not belong to this project/, 'project guard error');
    assert.strictEqual(factoryCalled, false, 'AI factory must not be called');
  } finally {
    connection.close();
  }
}

async function testRequestReportFocusShortcut() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const project = db.createProject({ name: 'Focus shortcut' });
    const global = db.createConversation({ project_id: project.id, title: 'Memory', conversation_type: 'project' });
    const focus = db.createConversation({ project_id: project.id, title: 'Focus', conversation_type: 'focus' });
    db.updateConversation(focus.id, { focus_report: '# Stored focus report' });

    let factoryCalled = false;
    const tools = createProjectTools(global.id, {
      db,
      reportOptions: {
        aiClientFactory: () => {
          factoryCalled = true;
          return makeStubClient('fresh');
        }
      }
    });

    const res = await tools.requestConversationReport.handler({ conversationId: focus.id });
    assert.strictEqual(res.report, '# Stored focus report', 'stored report returned directly');
    assert.strictEqual(factoryCalled, false, 'no AI call for stored focus report');
    assert(res.meta && res.meta.conversationId === focus.id, 'meta still returned');
  } finally {
    connection.close();
  }
}

async function testRequestReportNoHistory() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const project = db.createProject({ name: 'No history' });
    const global = db.createConversation({ project_id: project.id, title: 'Memory', conversation_type: 'project' });
    const target = db.createConversation({ project_id: project.id, title: 'Empty', conversation_type: 'main' });
    db.createProvider({ name: 'P', api_key: 'k', base_url: 'http://localhost:1', is_active: 1 });

    let factoryCalled = false;
    const tools = createProjectTools(global.id, {
      db,
      reportOptions: {
        aiClientFactory: () => {
          factoryCalled = true;
          return makeStubClient('fresh');
        }
      }
    });

    const res = await tools.requestConversationReport.handler({ conversationId: target.id });
    assert.strictEqual(res.report, null, 'no report without history');
    assert.match(res.error, /no history/i, 'no-history error');
    assert.strictEqual(factoryCalled, false, 'no AI call without history');
    assert(res.meta, 'meta returned');
  } finally {
    connection.close();
  }
}

async function testRequestReportWithHistory() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const project = db.createProject({ name: 'With history' });
    const global = db.createConversation({ project_id: project.id, title: 'Memory', conversation_type: 'project' });
    const provider = db.createProvider({ name: 'P', api_key: 'k', base_url: 'http://localhost:1', is_active: 1 });
    const target = db.createConversation({
      project_id: project.id,
      title: 'Target',
      conversation_type: 'main',
      provider_id: provider.id,
      model: 'model-x',
    });
    db.createPlanExecution({
      project_id: project.id,
      global_conversation_id: global.id,
      execution_conversation_id: target.id,
      status: 'executing',
    });

    db.createMessage({ conversation_id: target.id, role: 'user', content: 'Implement feature X please' });
    db.createMessage({
      conversation_id: target.id,
      role: 'assistant',
      content: 'I implemented feature X and ran the tests, they all pass now. '.repeat(4),
    });

    const calls = [];
    const invokeParams = [];
    const tools = createProjectTools(global.id, {
      db,
      reportOptions: {
        aiClientFactory: (p, m) => {
          calls.push({ provider: p, model: m });
          return makeStubClient('# Generated report', invokeParams);
        }
      }
    });

    // Spy on writes to verify the target is never mutated.
    let createMessageCalls = 0;
    let updateConversationCalls = 0;
    const origCreateMessage = db.createMessage.bind(db);
    const origUpdateConversation = db.updateConversation.bind(db);
    db.createMessage = (...args) => { createMessageCalls++; return origCreateMessage(...args); };
    db.updateConversation = (...args) => { updateConversationCalls++; return origUpdateConversation(...args); };

    const res = await tools.requestConversationReport.handler({ conversationId: target.id });

    assert.strictEqual(res.report, '# Generated report', 'report content returned');
    assert.strictEqual(calls.length, 1, 'exactly one AI call');
    assert.strictEqual(calls[0].model, 'model-x', 'target model used');
    assert.strictEqual(calls[0].provider.id, provider.id, 'target provider used');
    assert.strictEqual(invokeParams.length, 1, 'chatCompletion invoked once');
    assert.strictEqual(invokeParams[0].maxTokens, 2000, 'default maxTokens forwarded');
    assert(invokeParams[0].messages.length >= 2, 'system instruction plus history sent');
    assert.strictEqual(createMessageCalls, 0, 'no message written to target');
    assert.strictEqual(updateConversationCalls, 0, 'no conversation update written');
    assert(res.meta.linkedToExecution === true, 'meta flags execution linkage');
    assert.strictEqual(res.meta.executionStatus, 'executing', 'meta carries execution status');
  } finally {
    connection.close();
  }
}

async function testRequestReportProviderModelFallback() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const project = db.createProject({ name: 'Fallback' });
    const global = db.createConversation({ project_id: project.id, title: 'Memory', conversation_type: 'project' });
    const provider = db.createProvider({ name: 'Active', api_key: 'k', base_url: 'http://localhost:2', is_active: 1 });
    db.setSetting('default_model', 'setting-model');
    const target = db.createConversation({ project_id: project.id, title: 'Target', conversation_type: 'main' });
    db.createMessage({ conversation_id: target.id, role: 'user', content: 'Do something' });

    const calls = [];
    const tools = createProjectTools(global.id, {
      db,
      reportOptions: {
        aiClientFactory: (p, m) => {
          calls.push({ provider: p, model: m });
          return makeStubClient('# Report');
        }
      }
    });

    const res = await tools.requestConversationReport.handler({ conversationId: target.id });
    assert.strictEqual(res.report, '# Report', 'report generated');
    assert.strictEqual(calls.length, 1, 'AI called once');
    assert.strictEqual(calls[0].provider.id, provider.id, 'active provider fallback');
    assert.strictEqual(calls[0].model, 'setting-model', 'default_model fallback');
  } finally {
    connection.close();
  }
}

async function testRequestReportAiFailure() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const project = db.createProject({ name: 'Failure' });
    const global = db.createConversation({ project_id: project.id, title: 'Memory', conversation_type: 'project' });
    db.createProvider({ name: 'P', api_key: 'k', base_url: 'http://localhost:3', is_active: 1 });
    const target = db.createConversation({ project_id: project.id, title: 'Target', conversation_type: 'main' });
    db.createMessage({ conversation_id: target.id, role: 'user', content: 'Do something' });

    const tools = createProjectTools(global.id, {
      db,
      reportOptions: {
        aiClientFactory: () => ({
          chatCompletion: async () => { throw new Error('boom'); }
        })
      }
    });

    const res = await tools.requestConversationReport.handler({ conversationId: target.id });
    assert.strictEqual(res.report, null, 'no report on AI failure');
    assert.match(res.error, /Could not generate report/, 'friendly error message');
    assert(res.meta && res.meta.conversationId === target.id, 'meta still returned on failure');
  } finally {
    connection.close();
  }
}

async function testRequestReportNoProvider() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const project = db.createProject({ name: 'No provider' });
    const global = db.createConversation({ project_id: project.id, title: 'Memory', conversation_type: 'project' });
    const target = db.createConversation({ project_id: project.id, title: 'Target', conversation_type: 'main' });
    db.createMessage({ conversation_id: target.id, role: 'user', content: 'Do something' });

    let factoryCalled = false;
    const tools = createProjectTools(global.id, {
      db,
      reportOptions: {
        aiClientFactory: () => {
          factoryCalled = true;
          return makeStubClient('fresh');
        }
      }
    });

    const res = await tools.requestConversationReport.handler({ conversationId: target.id });
    assert.strictEqual(res.report, null, 'no report without provider');
    assert.match(res.error, /No AI provider/i, 'provider error');
    assert.strictEqual(factoryCalled, false, 'no AI call without provider');
    assert(res.meta, 'meta-only response');
  } finally {
    connection.close();
  }
}

async function testGenerateConversationReportMissingTarget() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);
  try {
    createSchema(connection);
    const project = db.createProject({ name: 'Missing' });
    const global = db.createConversation({ project_id: project.id, title: 'Memory', conversation_type: 'project' });

    const res = await generateConversationReport({
      targetConversationId: 424242,
      projectConversationId: global.id,
      db,
    });
    assert.strictEqual(res.report, null, 'missing target yields no report');
    assert.match(res.error, /not found/i, 'missing target error');
    assert.strictEqual(res.meta, null, 'no meta for missing target');
  } finally {
    connection.close();
  }
}

async function runTests() {
  const tests = [
    ['listProjectConversationsMap', testListProjectConversationsMap],
    ['listProjectConversationsGuard', testListProjectConversationsGuard],
    ['requestReportRejectsOtherProject', testRequestReportRejectsOtherProject],
    ['requestReportFocusShortcut', testRequestReportFocusShortcut],
    ['requestReportNoHistory', testRequestReportNoHistory],
    ['requestReportWithHistory', testRequestReportWithHistory],
    ['requestReportProviderModelFallback', testRequestReportProviderModelFallback],
    ['requestReportAiFailure', testRequestReportAiFailure],
    ['requestReportNoProvider', testRequestReportNoProvider],
    ['generateConversationReportMissingTarget', testGenerateConversationReportMissingTarget],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error) {
      console.error(`❌ ${name}:`, error.message);
      console.error(error.stack);
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed.`);
  if (passed !== tests.length) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
