const { countMessageTokens } = require('../../controllers/tokenController');
const { filterMessagesForLLM, normalizeMessagesForLLM } = require('../../utils/messageFilter');
const { computeConversationStatus } = require('../conversationStatus');

const PROJECT_MEMORY_MAX_CONVERSATIONS = 12;
const PROJECT_MEMORY_TITLE_MAX = 60;

const STATIC_PROTOCOL_PROMPT = [
  'You are MiniBoss, an AI coding agent running on a git worktree.',
  'Your capabilities: assistant text responses and tool calls for file inspection, edits, shell commands, and task management.',
  'Keep responses concise and directly actionable.',
  'You operate within a git repository. All file operations affect the current worktree.',
  'Use investigate to delegate read-only analysis to isolated sub-agents. Wait for their reports.',
  'You are NOT a chat assistant — you are a development agent. Prefer tool calls over text explanations.',
  'Shell commands from runCommand execute in a sandboxed worktree. CWD = conversation worktree. Outside the worktree, only read access to selected system folders. /home is not accessible. Commands run via bubblewrap (bwrap).',
].join('\n');

function truncateText(value, maxLength) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function safeJsonParse(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function classifyEvent(message) {
  if (!message) return 'unknown';
  if (message.role === 'user') return 'user_message';
  if (message.role === 'tool') return 'tool_result';
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return 'assistant_tool_request';
  }
  if (message.role === 'assistant') return 'assistant_message';
  if (String(message.role || '').startsWith('approval_')) return 'approval_event';
  return 'unknown';
}

function detectIntentCategory(sourceText, eventType) {
  const text = String(sourceText || '').toLowerCase();

  if (eventType === 'tool_result' && /(error|failed|enoent|exception|traceback|denied)/.test(text)) {
    return 'recover_from_tool_error';
  }
  if (/(bug|erro|error|fix|corrig|falha|broken|quebrad)/.test(text)) {
    return 'debug_or_fix';
  }
  if (/(implement|criar|cria|add|feature|suport|support|constru|build)/.test(text)) {
    return 'implement_change';
  }
  if (/(refactor|cleanup|limpa|organiza|simplif)/.test(text)) {
    return 'refactor_or_cleanup';
  }
  if (/(test|tests|teste|validat|verify|verifica)/.test(text)) {
    return 'test_or_validate';
  }
  if (/(explain|explica|porque|por que|why|how|como)/.test(text)) {
    return 'explain_or_analyze';
  }
  if (/(plan|arquitet|architecture|design|estrat|approach)/.test(text)) {
    return 'plan_or_design';
  }
  return 'general_coding_assistance';
}

function inferIntent(messages, triggeringEvent) {
  const userMessages = messages.filter(message => message.role === 'user');
  const latestUser = userMessages[userMessages.length - 1] || null;
  const sourceText = latestUser?.content || triggeringEvent?.content || '';
  const category = detectIntentCategory(sourceText, triggeringEvent?.kind);
  const objectives = [];

  if (latestUser?.content) {
    objectives.push(truncateText(latestUser.content, 240));
  }
  if (triggeringEvent?.kind === 'tool_result' && /(error|failed|denied)/i.test(triggeringEvent.content || '')) {
    objectives.push('Resolve the failing tool step before continuing.');
  }

  return {
    category,
    latestUserMessageId: latestUser?.id || null,
    confidence: latestUser?.content || triggeringEvent?.content ? 'medium' : 'low',
    objectives: objectives.slice(0, 3),
  };
}

function summarizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map(toolCall => ({
    id: toolCall.id || null,
    name: toolCall.function?.name || null,
    arguments: truncateText(toolCall.function?.arguments || '{}', 180),
  }));
}

function buildTriggeringEvent(message) {
  if (!message) {
    return {
      kind: 'unknown',
      summary: 'No triggering event available.',
      content: '',
    };
  }

  const kind = classifyEvent(message);
  return {
    id: message.id || null,
    role: message.role || null,
    kind,
    createdAt: message.created_at || null,
    status: message.status || null,
    summary: `${kind}#${message.id || 'n/a'}`,
    content: truncateText(
      message.role === 'tool' ? (message.tool_result || message.content) : message.content,
      480
    ),
    toolName: message.tool_name || null,
    toolCalls: summarizeToolCalls(message.tool_calls),
  };
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(Boolean)
    .filter(message => !['approval_request', 'approval_approved', 'approval_denied'].includes(message.role))
    .map(message => ({
      ...message,
      tool_calls: Array.isArray(message.tool_calls)
        ? message.tool_calls
        : safeJsonParse(message.tool_calls, null),
    }));
}

function flattenTaskTree(nodes, depth = 0, result = []) {
  if (!Array.isArray(nodes)) return result;
  for (const node of nodes) {
    result.push({
      id: node.id,
      parentId: node.parent_id || null,
      description: node.description,
      status: node.status,
      notes: node.notes || null,
      depth,
      updatedAt: node.updated_at || null,
    });
    flattenTaskTree(node.children, depth + 1, result);
  }
  return result;
}

function buildTaskState(db, conversationId) {
  if (!db || !conversationId) {
    return {
      total: 0,
      byStatus: { todo: 0, in_progress: 0, blocked: 0, done: 0 },
      openTasks: [],
      recentlyCompleted: [],
    };
  }

  const tree = db.getTaskTree(conversationId);
  const flat = flattenTaskTree(tree);

  const openTasks = flat.filter(task => task.status !== 'done').slice(0, 8);
  const completedTasks = flat.filter(task => task.status === 'done').slice(-4);

  return {
    total: flat.length,
    byStatus: {
      todo: flat.filter(task => task.status === 'todo').length,
      in_progress: flat.filter(task => task.status === 'in_progress').length,
      blocked: flat.filter(task => task.status === 'blocked').length,
      done: flat.filter(task => task.status === 'done').length,
    },
    openTasks: openTasks.map(task => ({
      id: task.id,
      description: truncateText(task.description, 160),
      status: task.status,
      depth: task.depth,
      notes: truncateText(task.notes || '', 120),
    })),
    recentlyCompleted: completedTasks.map(task => ({
      id: task.id,
      description: truncateText(task.description, 120),
      status: task.status,
    })),
  };
}

function buildSystemContext({
  conversation,
  provider,
  targetModel,
  workingDir,
  maxIterations,
  customInstructions,
  effectiveTools,
  rootObjective,
}) {
  return {
    conversation: {
      id: conversation?.id || null,
      title: conversation?.title || null,
      projectId: conversation?.project_id || null,
      projectName: conversation?.project_name || null,
      workingDir: workingDir || conversation?.worktree_path || null,
      projectFolder: conversation?.repo_root || null,
      gitBranch: conversation?.git_branch || null,
      baseBranch: conversation?.base_branch || null,
      rootObjective,
    },
    provider: {
      id: provider?.id || null,
      name: provider?.name || null,
      model: targetModel || conversation?.model || null,
    },
    execution: {
      remainingIterations: maxIterations,
      isFinalTurn: maxIterations === 0,
      availableTools: Array.isArray(effectiveTools)
        ? effectiveTools.map(tool => tool.function?.name).filter(Boolean)
        : [],
    },
    projectInstructions: customInstructions ? truncateText(customInstructions, 320) : '',
  };
}

function buildProjectMemory(db, conversation) {
  if (!db || !conversation || conversation.conversation_type !== 'project') {
    return null;
  }

  let notes = [];
  let executions = [];
  let conversations = [];
  try {
    notes = db.getProjectNotes(conversation.project_id, { status: 'active', limit: 25 }) || [];
  } catch (_) {}
  // NOTE: plan_executions.status is never updated by the application — we filter
  // only by 'executing' to maintain historical behavior. The state
  // "running now" is derived via computeConversationStatus (processing_state/phase).
  try {
    executions = db.getActivePlanExecutions(conversation.project_id) || [];
  } catch (_) {}
  try {
    conversations = db.getConversationsByProject(conversation.project_id) || [];
  } catch (_) {}

  // Mapa de linkage por execution_conversation_id (todos os status).
  const executionByConversation = new Map();
  try {
    const allExecutions = db.getPlanExecutionsByProject(conversation.project_id) || [];
    for (const exec of allExecutions) {
      executionByConversation.set(Number(exec.execution_conversation_id), exec);
    }
  } catch (_) {}

  const grouped = { idea: [], note: [], decision: [], discovery: [], open_question: [] };
  for (const note of notes) {
    const kind = grouped[String(note.kind)] ? String(note.kind) : 'note';
    grouped[kind].push({
      id: note.id,
      title: note.title || null,
      kind: note.kind,
      status: note.status,
      updatedAt: note.updated_at || null,
      content: truncateText(note.content, 240),
    });
  }

  const conversationRows = conversations.slice(0, PROJECT_MEMORY_MAX_CONVERSATIONS).map(row => ({
    id: row.id,
    title: row.title ? truncateText(row.title, PROJECT_MEMORY_TITLE_MAX) : null,
    conversationType: row.conversation_type || null,
    status: computeConversationStatus(row, db),
    linkedToExecution: executionByConversation.has(Number(row.id)),
    updatedAt: row.updated_at || null,
  }));

  // untracked = non-global roots without plan_execution (decision #2).
  const untrackedIds = conversations
    .filter(row => row.conversation_type !== 'project')
    .filter(row => !executionByConversation.has(Number(row.id)))
    .map(row => row.id);

  return {
    notes: grouped,
    executions: executions.map(exec => ({
      executionConversationId: exec.execution_conversation_id,
      title: exec.execution_title || null,
      status: exec.status,
      createdAt: exec.created_at || null,
    })),
    conversations: conversationRows,
    conversationsTruncated: conversations.length > PROJECT_MEMORY_MAX_CONVERSATIONS,
    untracked: { count: untrackedIds.length, conversationIds: untrackedIds },
  };
}

function buildLightState(args) {
  const normalized = normalizeMessages(args.messages || []);
  const latest = normalized[normalized.length - 1] || null;

  const event = buildTriggeringEvent(latest);
  const intent = inferIntent(normalized, event);
  const taskState = buildTaskState(args.db, args.conversation?.id);
  const rootObjective = buildRootObjective(args.db, args.conversation);
  const projectMemory = buildProjectMemory(args.db, args.conversation);
  const systemContext = buildSystemContext({
    conversation: args.conversation,
    provider: args.provider,
    targetModel: args.targetModel,
    workingDir: args.workingDir,
    maxIterations: args.maxIterations,
    customInstructions: args.customInstructions,
    effectiveTools: args.effectiveTools,
    rootObjective,
  });

  return {
    tasks: taskState,
    system: systemContext,
    current_objective: { event, intent },
    root_objective: rootObjective,
    projectMemory,
    generatedAt: new Date().toISOString(),
  };
}

function resolveRootConversation(db, conversation) {
  if (!db || !conversation) return null;

  let current = conversation;
  const visited = new Set();

  while (current?.parent_id) {
    if (visited.has(current.parent_id)) break;
    visited.add(current.parent_id);
    const parent = db.getConversation(current.parent_id);
    if (!parent) break;
    current = parent;
  }

  return current;
}

function buildRootObjective(db, conversation) {
  const rootConversation = resolveRootConversation(db, conversation);
  if (!rootConversation) return null;

  let firstUserMessage = null;
  try {
    const messages = db.getMessagesByConversation(rootConversation.id) || [];
    firstUserMessage = messages.find(msg => msg.role === 'user') || null;
  } catch (_) {
    firstUserMessage = null;
  }

  return {
    conversationId: rootConversation.id,
    title: rootConversation.title || null,
    firstMessagePreview: firstUserMessage?.content ? truncateText(firstUserMessage.content, 480) : null,
  };
}

module.exports = {
  STATIC_PROTOCOL_PROMPT,
  buildLightState,
  // Re-export the message filter functions for convenience
  filterMessagesForLLM,
  normalizeMessagesForLLM,
};
