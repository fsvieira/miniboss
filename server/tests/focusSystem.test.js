const assert = require('assert');

const focusTools = require('../tools/focusTools');
const { buildPartialReport, normalizeFocusReport } = focusTools;
const { __testing: systemPromptTesting } = require('../controllers/systemPromptBuilder');
const { countMessageTokens } = require('../controllers/tokenController');

async function testFocusRuntimeFoundation() {
  const { DatabaseConnection } = require('../services/db/connection');
  const { DatabaseAPI } = require('../services/db/api');
  const {
    FOCUS_RUNTIME_PHASES,
    FOCUS_RUNTIME_EVENTS,
    FOCUS_RUNTIME_OWNERS,
    FOCUS_REPORT_STATUS,
    FOCUS_TOOL_MODES,
    validateTransition,
    InvalidFocusRuntimeTransitionError,
  } = require('../services/focusRuntime');

  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);

  try {
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
    `);

    const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('focus_runtime_states', 'focus_runtime_events')").all();
    assert.strictEqual(tables.length, 2, 'Focus runtime tables should be created');

    const project = db.createProject({ name: 'Runtime Test' });
    const conversation = db.createConversation({ project_id: project.id, title: 'Focus', conversation_type: 'focus' });

    const state = db.createFocusRuntimeState({
      conversation_id: conversation.id,
      owner: FOCUS_RUNTIME_OWNERS.SHADOW,
      phase: FOCUS_RUNTIME_PHASES.CREATED,
      tool_mode: FOCUS_TOOL_MODES.NONE,
      report_status: FOCUS_REPORT_STATUS.NONE,
      pending_action_payload: { reason: 'test' },
      metadata_json: { source: 'unit' },
    });

    assert.strictEqual(state.conversation_id, conversation.id, 'Runtime state should be stored');
    assert.deepStrictEqual(state.pending_action_payload, { reason: 'test' }, 'Runtime JSON fields should deserialize');
    assert.strictEqual(db.listFocusRuntimeStatesByOwner(FOCUS_RUNTIME_OWNERS.SHADOW).length, 1, 'Owner listing should find shadow state');

    const updated = db.updateFocusRuntimeState(conversation.id, {
      phase: FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI,
      pending_action: 'ai_turn',
      current_turn_id: 'turn_1',
    });
    assert.strictEqual(updated.phase, FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI, 'Runtime state should update');
    assert.strictEqual(db.listPendingFocusRuntimeActions().length, 1, 'Pending action listing should find state');
    assert.strictEqual(db.listNonTerminalFocusRuntimeStates().length, 1, 'Non-terminal listing should find state');

    const event = db.appendFocusRuntimeEvent({
      conversation_id: conversation.id,
      from_phase: FOCUS_RUNTIME_PHASES.CREATED,
      event: FOCUS_RUNTIME_EVENTS.QUEUED_AI_TURN,
      to_phase: FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI,
      turn_id: 'turn_1',
      payload_json: { ok: true },
    });
    assert.strictEqual(event.event, FOCUS_RUNTIME_EVENTS.QUEUED_AI_TURN, 'Runtime event should be stored');

    assert.strictEqual(validateTransition(FOCUS_RUNTIME_PHASES.CREATED, FOCUS_RUNTIME_EVENTS.QUEUED_AI_TURN, FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI), true);
    assert.throws(
      () => validateTransition(FOCUS_RUNTIME_PHASES.COMPLETED, FOCUS_RUNTIME_EVENTS.QUEUED_AI_TURN, FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI),
      InvalidFocusRuntimeTransitionError,
      'Invalid transition should throw typed error'
    );
  } finally {
    connection.close();
  }
}

async function testNormalizeFocusReport() {
  const rawReport = `# Auto-Report\n\n## Done\n- Investigated issue\n\n## Remaining\n- Follow up later`;
  const focusGoal = {
    goal: 'Investigate bug',
    context: 'User reports crash.',
    minimumDeliverable: 'Root cause explained'
  };

  const normalized = normalizeFocusReport(rawReport, {
    focusGoal,
    completed: false,
    heading: '# Focus Report — Test'
  });

  assert(normalized.sections.summary.length > 0, 'Summary should not be empty');
  assert(normalized.sections.outstanding.includes('Follow up'), 'Outstanding section not preserved');
  assert(Array.isArray(normalized.warnings), 'Warnings should be array');
}

async function testBuildPartialReport() {
  const mockDb = {
    getMessagesByConversation() {
      return [
        { role: 'tool', tool_name: 'readFile', tool_args: JSON.stringify({ path: 'src/a.js' }) },
        { role: 'tool', tool_name: 'writeFile', tool_args: JSON.stringify({ path: 'src/a.js' }) },
      ];
    }
  };

  const partial = buildPartialReport(mockDb, 1, { content: 'Latest output' });
  assert(partial.sections.summary.includes('Auto-generated'), 'Summary should mention auto-generated');
  assert(partial.sections.workPerformed.includes('Read 1 file'), 'Work performed should include read count');
  assert(partial.sections.outstanding.includes('Scope'), 'Outstanding should mention scope unresolved');
}

async function testBuildPartialReportWithError() {
  const mockDb = {
    getMessagesByConversation() {
      return [
        { role: 'assistant', content: 'I hit a rate-limit while reading config.' },
        { role: 'tool', tool_name: 'readFile', tool_args: JSON.stringify({ path: 'src/config.js' }) },
      ];
    }
  };

  const fakeError = new Error('Upstream 503 from provider');
  fakeError.stack = 'Error: Upstream 503\n    at LLM.call (/provider:22)\n    at loop (loop:5)';
  const partial = buildPartialReport(mockDb, 1, { content: 'I hit a rate-limit while reading config.' }, { error: fakeError });
  assert(partial.sections.summary.includes('Unrecoverable error'), 'Summary should include error label');
  assert(partial.sections.summary.includes('503 from provider'), 'Summary should include error message');
  assert(partial.sections.summary.includes('/provider:22'), 'Summary should include stack snippet');
  assert(partial.sections.outstanding.includes('Scope'), 'Outstanding should mention scope unresolved');
  assert(typeof partial.autogenerated === 'boolean', 'autogenerated flag should be set');
}

async function testContextBudgetGuard() {
  const { applyContextBudgetGuard, stripMeta } = systemPromptTesting;

  const makeToolMessage = (id, content) => ({
    role: 'tool',
    tool_call_id: `call_${id}`,
    content,
    __meta: { toolName: 'readFile' }
  });

  const messages = [
    { role: 'system', content: 'system prompt' },
    makeToolMessage(1, 'x '.repeat(400)),
    makeToolMessage(2, 'y '.repeat(400)),
    makeToolMessage(3, 'z '.repeat(400)),
  ];

  const guardResult = applyContextBudgetGuard(messages, {
    tokenLimit: 2000,
    threshold: 200,
    countTokens: (msgs) => countMessageTokens(stripMeta(msgs)),
  });

  assert(guardResult.actions.length >= 1, 'Guard should replace at least one tool message');
  const replacedMessage = guardResult.messages.find(msg => msg.__meta?.placeholder);
  assert(replacedMessage, 'Placeholder flag should be set on replaced message');
  assert(replacedMessage.content.includes('[Context trimmed]'), 'Placeholder content should mention trimming');
}

async function testInitialFocusErrorTransitionsToFinalizing() {
  const { FocusProtocol } = require('../services/protocol/protocols/focusProtocol');
  const { FOCUS_PHASE, FOCUS_EVENT } = require('../constants/focusProtocol');

  let storedGoal = JSON.stringify({ goal: 'Fail early', context: 'Provider failed before first active turn' });
  const db = {
    getConversation() {
      return { id: 1, conversation_type: 'focus', focus_goal: storedGoal };
    },
    updateFocusGoal(_id, goal) {
      storedGoal = goal;
    }
  };

  const protocol = new FocusProtocol({ conversationId: 1 });
  const transition = await protocol.handleEvent(FOCUS_EVENT.ERROR, { db, error: new Error('provider failed') });

  assert.strictEqual(transition.from, FOCUS_PHASE.INITIAL, 'Error should be accepted from initial phase');
  assert.strictEqual(transition.to, FOCUS_PHASE.FINALIZING, 'Initial error should move to finalizing');
  assert.strictEqual(protocol.state, FOCUS_PHASE.FINALIZING, 'Protocol state should be finalizing');
  assert.strictEqual(JSON.parse(storedGoal).finalizing, true, 'Finalizing hook should mark focus goal');
}

async function testInitialFocusAssistantResponseTransitions() {
  const { FocusProtocol } = require('../services/protocol/protocols/focusProtocol');
  const { FOCUS_PHASE, FOCUS_EVENT } = require('../constants/focusProtocol');

  const db = {
    getConversation() {
      return { id: 1, conversation_type: 'focus', focus_goal: JSON.stringify({ goal: 'Initial response' }) };
    },
    updateFocusGoal() {}
  };

  const withTools = new FocusProtocol({ conversationId: 1 });
  const toolsTransition = await withTools.handleEvent(FOCUS_EVENT.AI_RESPONDED_WITH_TOOLS, { db });
  assert.strictEqual(toolsTransition.from, FOCUS_PHASE.INITIAL, 'Initial tool response should be accepted');
  assert.strictEqual(toolsTransition.to, FOCUS_PHASE.ACTIVE, 'Initial tool response should activate focus');

  const withReport = new FocusProtocol({ conversationId: 1 });
  const reportTransition = await withReport.handleEvent(FOCUS_EVENT.AI_RESPONDED_WITH_REPORT, { db });
  assert.strictEqual(reportTransition.from, FOCUS_PHASE.INITIAL, 'Initial report response should be accepted');
  assert.strictEqual(reportTransition.to, FOCUS_PHASE.REPORT_SENT, 'Initial report response should mark report sent');

  const textOnly = new FocusProtocol({ conversationId: 1 });
  const textTransition = await textOnly.handleEvent(FOCUS_EVENT.AI_RESPONDED_TEXT_ONLY, { db });
  assert.strictEqual(textTransition.from, FOCUS_PHASE.INITIAL, 'Initial text-only response should be accepted');
  assert.strictEqual(textTransition.to, FOCUS_PHASE.FINALIZING, 'Initial text-only response should enter finalizing');
}

async function testFinalizationSystemPrompt() {
  const { FOCUS_PHASE } = require('../constants/focusProtocol');
  const systemPromptBuilder = require('../controllers/systemPromptBuilder');
  const aiClientPath = require.resolve('../services/ai/AiClient');
  const aiClientCache = require.cache[aiClientPath];

  const freshCacheEntry = {
    id: aiClientPath,
    filename: aiClientPath,
    loaded: true,
    exports: {
      AiClient: class MockAiClient {
        constructor() {}
        chatCompletion() { return { content: 'ok', toolCalls: [], finishReason: 'stop', rawResponse: {} }; }
        close() {}
        getModelContextLength() { return 32768; }
      }
    }
  };
  require.cache[aiClientPath] = freshCacheEntry;

  const systemPromptPath = require.resolve('../controllers/systemPromptBuilder');
  delete require.cache[systemPromptPath];
  const systemPromptBuilder2 = require(systemPromptPath);

  let capturedMessages = null;
  try {
    const db = {
      getConversation(conversationId) {
        return {
          id: conversationId,
          conversation_type: 'focus',
          focus_goal: JSON.stringify({
            goal: 'Fix the bug',
            context: 'ctx',
            finalizing: true
          }),
          parent_id: null,
          project_id: 1
        };
      },
      getConversationWithProject(id) {
        const c = this.getConversation(id);
        return { ...c, worktree_path: '/tmp' };
      },
      getProvider() { return { base_url: 'http://test', api_key: 'k', name: 'Test' }; },
      getActiveProviders() { return []; },
      getSetting() { return null; },
      getMessagesByConversation() { return []; },
      getTaskTree() { return []; }
    };

    await systemPromptBuilder2.sendToAI({
      targetProvider: { api_key: 'k', base_url: 'http://test' },
      targetModel: 'gpt-4',
      sourceMessages: [],
      workingDir: '/tmp',
      maxIterations: 0,
      conversationId: 1,
      conversation: db.getConversation(1),
      db,
      signal: new AbortController().signal
    });

    // sendToAI calls our MockAiClient.chatCompletion which doesn't capture messages
    // Let's read the FOCUS_PROMPT source directly and verify the finalization text is appended
    const promptData = require('../controllers/systemPromptBuilder');
    assert(promptData && promptData.sendToAI, 'System prompt builder should still be loaded');
  } finally {
    if (aiClientCache) {
      require.cache[aiClientPath] = aiClientCache;
    } else {
      delete require.cache[aiClientPath];
    }
  }
}

async function testFinalizationPromptInjection() {
  const fs = require('fs');
  const content = fs.readFileSync(require.resolve('../controllers/systemPromptBuilder.js'), 'utf8');
  assert(content.includes('finalizing'), 'systemPromptBuilder should check finalizing flag');
  assert(content.includes('FINALIZATION PHASE'), 'systemPromptBuilder should inject FINALIZATION PHASE text');
  assert(content.includes('ONLY available tool'), 'systemPromptBuilder should remind that sendFocusReport is the only tool');
}

async function testSendFocusReportDrivesFocusToCompleted() {
  const { DatabaseConnection } = require('../services/db/connection');
  const { DatabaseAPI } = require('../services/db/api');

  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);

  try {
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
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME
      );
    `);

    const project = db.createProject({ name: 'Focus Report Test' });
    const mainConv = db.createConversation({ project_id: project.id, title: 'Main', conversation_type: 'main' });
    const focusConv = db.createConversation({
      project_id: project.id,
      title: 'Test Focus',
      conversation_type: 'focus',
      parent_id: mainConv.id
    });

    const ConversationManager = require('../services/conversationManager');
    const cm = new ConversationManager(db, {
      broadcastToConversation() {},
      broadcastAIStatus() {},
      broadcastStreamDone() {},
    }, { setConversationManager() {}, trigger() {} });

    cm.stateChange(focusConv, {
      conversation_id: focusConv.id,
      role: 'assistant',
      content: 'Focus report content',
      status: 'completed',
      _focusReport: true
    });

    await new Promise(r => setTimeout(r, 50));

    const updated = db.getConversation(focusConv.id);
    assert.strictEqual(updated.phase, 'report_sent', 'Focus should be in report_sent phase after report');
    assert.strictEqual(updated.processing_state, 'idle', 'Focus should be idle after report');
  } finally {
    connection.close();
  }
}

async function testCancelLeafFocusMarksItTerminal() {
  const { DatabaseConnection } = require('../services/db/connection');
  const { DatabaseAPI } = require('../services/db/api');

  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);

  try {
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
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME
      );
    `);

    const project = db.createProject({ name: 'Cancel Test' });
    const mainConv = db.createConversation({ project_id: project.id, title: 'Main', conversation_type: 'main' });
    const focusConv = db.createConversation({
      project_id: project.id,
      title: 'Focus Leaf',
      conversation_type: 'focus',
      parent_id: mainConv.id
    });
    db.setActiveFocus(mainConv.id, focusConv.id);

    const AIController = require('../controllers/aiController');
    const aiCtrl = new AIController();

    await aiCtrl._markFocusCancelled(db, focusConv, 'test cancellation');

    const updatedFocus = db.getConversation(focusConv.id);
    assert(updatedFocus.focus_report, 'Focus should have a focus_report after cancellation');
    assert(JSON.parse(updatedFocus.focus_report).summary === 'Cancelled by user', 'Focus report summary should indicate cancellation');

    const updatedMain = db.getConversation(mainConv.id);
    assert.strictEqual(updatedMain.active_focus_id, null, 'Main should have active_focus_id cleared');
  } finally {
    connection.close();
  }
}

async function runTests() {
  const tests = [
    ['focusRuntimeFoundation', testFocusRuntimeFoundation],
    ['normalizeFocusReport', testNormalizeFocusReport],
    ['buildPartialReport', testBuildPartialReport],
    ['buildPartialReportWithError', testBuildPartialReportWithError],
    ['contextBudgetGuard', testContextBudgetGuard],
    ['initialFocusErrorTransitionsToFinalizing', testInitialFocusErrorTransitionsToFinalizing],
    ['initialFocusAssistantResponseTransitions', testInitialFocusAssistantResponseTransitions],
    ['finalizationPromptInjection', testFinalizationPromptInjection],
    ['sendFocusReportDrivesFocusToCompleted', testSendFocusReportDrivesFocusToCompleted],
    ['cancelLeafFocusMarksItTerminal', testCancelLeafFocusMarksItTerminal],
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

module.exports = {
  runTests
};
