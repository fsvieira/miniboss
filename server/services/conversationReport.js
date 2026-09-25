const { DatabaseAPI } = require('./db/api');
const { AiClient } = require('./ai');
const { countMessageTokens } = require('../controllers/tokenController');
const { filterMessagesForLLM, normalizeMessagesForLLM } = require('../utils/messageFilter');
const { computeConversationStatus } = require('./conversationStatus');
const gitService = require('../services/gitService');

const DEFAULT_INPUT_TOKEN_BUDGET = 24000;
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MAX_MESSAGES = 100;

// normalizeMessagesForLLM truncates tool content to 12000 chars. The report is
// returned as { report, meta } serialized; keep markdown well below
// that limit to avoid cutting the report head/tail.
const MAX_REPORT_CHARS = 8000;

/**
 * Builds the project execution map keyed by execution conversation.
 * Uses getPlanExecutionsByProject (all statuses) — the status in
 * plan_executions is never updated by the app, so the "currently running"
 * value must come from computeConversationStatus, not here.
 * @param {Object} db - DatabaseAPI.
 * @param {number} projectId - Project ID.
 * @returns {Map<number, Object>} execution per execution_conversation_id.
 */
function buildLinkageMap(db, projectId) {
  const map = new Map();
  try {
    const executions = db.getPlanExecutionsByProject(projectId) || [];
    for (const exec of executions) {
      map.set(Number(exec.execution_conversation_id), exec);
    }
  } catch (_) {}
  return map;
}

/**
 * Resolve provider/model for the report (decision #1): target → active provider.
 * @param {Object} db - DatabaseAPI.
 * @param {Object} target - target conversation.
 * @returns {{ provider: Object|null, model: string }}
 */
function resolveTargetProviderModel(db, target) {
  let provider = null;
  if (target && target.provider_id) {
    try {
      provider = db.getProvider(target.provider_id);
    } catch (_) {
      provider = null;
    }
  }
  if (!provider) {
    try {
      const activeProviders = db.getActiveProviders() || [];
      provider = activeProviders.length > 0 ? activeProviders[0] : null;
    } catch (_) {
      provider = null;
    }
  }

  let model = (target && target.model) || null;
  if (!model) {
    try {
      model = db.getSetting('default_model') || null;
    } catch (_) {
      model = null;
    }
  }
  if (!model) model = 'gpt-3.5-turbo';

  return { provider, model };
}

function buildMeta(db, target, linkageMap) {
  const link = linkageMap.get(Number(target.id)) || null;
  const meta = {
    conversationId: target.id,
    status: computeConversationStatus(target, db),
    processingState: target.processing_state || null,
    phase: target.phase || null,
    mode: target.mode || null,
    updatedAt: target.updated_at || null,
    linkedToExecution: Boolean(link),
  };
  if (link) meta.executionStatus = link.status || null;
  return meta;
}

function truncateText(value, maxLength) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[truncated ${text.length - maxLength} chars]`;
}

function buildTargetContext(target) {
  const lines = [
    `- title: ${target.title || '(untitled)'}`,
    `- conversationType: ${target.conversation_type || 'unknown'}`,
    `- mode: ${target.mode || 'unknown'}`,
    `- updatedAt: ${target.updated_at || 'unknown'}`,
  ];

  if (target.plan) {
    lines.push(`- plan (excerpt): ${truncateText(target.plan, 600).replace(/\s+/g, ' ')}`);
  }

  if (target.focus_goal) {
    let goalText = target.focus_goal;
    try {
      const parsed = JSON.parse(target.focus_goal);
      goalText = parsed.goal || parsed.context || target.focus_goal;
    } catch (_) {
      // keep raw string
    }
    lines.push(`- focusGoal (excerpt): ${truncateText(goalText, 400).replace(/\s+/g, ' ')}`);
  }

  return lines.join('\n');
}

function buildSystemInstruction(target) {
  return [
    'You are producing a concise, factual, read-only status report about ONE conversation of a software project.',
    'You cannot modify anything and you must not invent facts: base every statement on the conversation history below.',
    '',
    'Target conversation:',
    buildTargetContext(target),
    '',
    'Write the report in markdown with these sections, in this order:',
    '1. **Objective** — what this conversation is trying to achieve.',
    '2. **Done** — concrete work already completed.',
    '3. **In Progress** — what is currently being worked on.',
    '4. **Blockers / Risks** — unresolved items, failures, uncertainties.',
    '5. **Next Steps** — the most likely next actions.',
    '',
    'Keep it under ~1500 words. If information is missing for a section, say so explicitly.'
  ].join('\n');
}

/**
 * Trims history from the start (keeping the most recent turns) to
 * fit the budget. The base instruction is never removed.
 */
function trimToBudget(baseMessage, history, tokenBudget) {
  const all = [baseMessage, ...history];
  if (countMessageTokens(all) <= tokenBudget) return all;

  let start = 0;
  while (start < history.length) {
    const candidate = [baseMessage, ...history.slice(start)];
    if (countMessageTokens(candidate) <= tokenBudget) return candidate;
    start++;
  }
  // Even the last block exceeds the budget: send only the instruction + last block.
  if (history.length > 0) {
    return [baseMessage, history[history.length - 1]];
  }
  return [baseMessage];
}

function truncateReport(report) {
  if (typeof report !== 'string') return report;
  if (report.length <= MAX_REPORT_CHARS) return report;
  return `${report.slice(0, MAX_REPORT_CHARS)}\n\n[REPORT TRUNCATED — original length ${report.length} chars. Request a narrower report if needed.]`;
}

function defaultAiClientFactory(provider, model) {
  return new AiClient({
    apiKey: provider.api_key || 'dummy',
    baseUrl: provider.base_url,
    model,
    timeout: 120000,
    maxRetries: 1,
  });
}

/**
 * Generates an AI read-only report about a project target conversation.
 *
 * Never throws to the caller: provider/AI failures return
 * { report: null, error, meta }. Nothing is written to the target conversation.
 *
 * @param {Object} params
 * @param {number} params.targetConversationId - conversation to summarize.
 * @param {number} params.projectConversationId - global ('project') conversation of the project.
 * @param {Object} [params.db] - DatabaseAPI (default: singleton).
 * @param {Object} [params.options] - { inputTokenBudget, maxTokens, maxMessages, aiClientFactory }.
 * @returns {Promise<{report: string|null, error?: string, meta: Object|null}>}
 */
async function generateConversationReport({ targetConversationId, projectConversationId, db, options = {} }) {
  const database = db || new DatabaseAPI(require('../database'));
  const opts = {
    inputTokenBudget: options.inputTokenBudget || DEFAULT_INPUT_TOKEN_BUDGET,
    maxTokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    maxMessages: options.maxMessages || DEFAULT_MAX_MESSAGES,
    aiClientFactory: options.aiClientFactory || defaultAiClientFactory,
  };

  let global = null;
  let target = null;
  try {
    global = database.getConversation(projectConversationId);
    target = targetConversationId != null ? database.getConversation(targetConversationId) : null;
  } catch (_) {
    global = null;
    target = null;
  }

  if (!global || !target) {
    return { report: null, error: 'Conversation not found', meta: null };
  }

  const linkageMap = buildLinkageMap(database, global.project_id);
  const meta = buildMeta(database, target, linkageMap);

  if (Number(target.project_id) !== Number(global.project_id)) {
    return { report: null, error: 'Conversation does not belong to this project', meta };
  }

  // Decision #6: focus already has a stored report — return without AI call.
  if (target.conversation_type === 'focus' && target.focus_report) {
    return { report: truncateReport(target.focus_report), meta };
  }

  let history = [];
  try {
    const messages = database.getMessagesByConversation(target.id, { limit: opts.maxMessages }) || [];
    const filtered = filterMessagesForLLM(messages, {
      lastNResponses: opts.maxMessages,
      minAssistantLength: 150,
      excludeSystem: true,
    });
    history = normalizeMessagesForLLM(filtered);
  } catch (_) {
    history = [];
  }

  if (history.length === 0) {
    return { report: null, error: 'Conversation has no history to report on', meta };
  }

  const { provider, model } = resolveTargetProviderModel(database, target);
  if (!provider || !provider.base_url) {
    return { report: null, error: 'No AI provider is configured for this report', meta };
  }

  const baseMessage = { role: 'system', content: buildSystemInstruction(target) };
  const requestMessages = trimToBudget(baseMessage, history, opts.inputTokenBudget);

  let result;
  try {
    const aiClient = opts.aiClientFactory(provider, model);
    result = await aiClient.chatCompletion({
      model,
      messages: requestMessages,
      maxTokens: opts.maxTokens,
    });
  } catch (error) {
    return {
      report: null,
      error: `Could not generate report: ${error && error.message ? error.message : 'unknown error'}`,
      meta,
    };
  }

  const content = result && result.content ? String(result.content) : null;
  if (!content) {
    const reason = (result && result.error && (result.error.message || result.error.error_message)) || 'empty response from provider';
    return {
      report: null,
      error: `Could not generate report: ${reason}`,
      meta,
    };
  }

  return { report: truncateReport(content), meta };
}

async function resolveConversationProject(db, conversationId) {
  const target = db.getConversation(conversationId);
  if (!target) return null;
  return db.getProject(target.project_id);
}

function buildDeletionReportPayload({ conversation, project, gitState, outcome }) {
  // A conversation is only considered "merged" (safe) when its tracked changes
  // were BOTH committed AND merged into the base branch. If the commit never
  // happened or there are uncommitted tracked changes, the local work is
  // considered discarded, so the report must not claim it survived. An unknown
  // git state is also treated as unsafe (nothing can be confirmed).
  const hasConfirmedMergedWork = Boolean(
    gitState &&
    !gitState.hasCommitsToMerge &&
    !gitState.hasUncommittedChanges
  );
  const mergeStatus = hasConfirmedMergedWork ? 'merged' : 'unmerged';
  const isSafe = hasConfirmedMergedWork;
  const summary = isSafe
    ? 'Conversation deleted after its tracked changes were committed and merged into the base branch.'
    : 'Conversation deleted with uncommitted or unmerged work; local branch/worktree changes were discarded.';
  const payload = {
    conversationId: conversation.id,
    title: conversation.title || '(untitled)',
    conversationType: conversation.conversation_type || null,
    projectId: project ? project.id : null,
    projectName: project ? project.name : null,
    mergeStatus,
    isSafe,
    repoRoot: conversation.repo_root || null,
    baseBranch: conversation.base_branch || null,
    gitBranch: conversation.git_branch || null,
    worktreePath: conversation.worktree_path || null,
    changedFiles: gitState?.changedFiles?.length || 0,
    ahead: gitState?.ahead || 0,
    behind: gitState?.behind || 0,
    hasUncommittedChanges: Boolean(gitState?.hasUncommittedChanges),
    hasCommitsToMerge: Boolean(gitState?.hasCommitsToMerge),
    deletedAt: new Date().toISOString(),
    outcome,
    summary,
  };
  return payload;
}

/**
 * Generates the deletion report for a conversation, for Project Memory.
 *
 * When the conversation is confirmed merged (tracked changes committed and
 * merged), it also tries to attach an AI-generated report of the conversation
 * (same engine as the requestConversationReport tool), so Project Memory gets a
 * real summary instead of raw fields. Any AI/provider failure falls back to the
 * static payload.
 *
 * @param {Object} params
 * @param {number} params.conversationId
 * @param {string} [params.outcome]
 * @param {Object} [params.db]
 * @param {boolean} [params.includeAiReportWhenMerged=true]
 * @param {Object} [params.aiReportOptions] - Options for generateConversationReport.
 * @returns {Promise<{report: Object|null, error?: string}>}
 */
async function generateConversationDeletionReport({ conversationId, outcome = 'deleted', db, includeAiReportWhenMerged = true, aiReportOptions }) {
  const database = db || new DatabaseAPI(require('../database'));
  try {
    const conversation = database.getConversation(conversationId);
    if (!conversation) {
      return { report: null, error: 'Conversation not found' };
    }

    const project = await resolveConversationProject(database, conversationId);
    let gitState = null;
    if (conversation.conversation_type !== 'project') {
      try {
        gitState = await gitService.getConversationGitState(conversationId);
      } catch (_) {
        gitState = null;
      }
    }

    const report = buildDeletionReportPayload({ conversation, project, gitState, outcome });

    if (includeAiReportWhenMerged && report.isSafe) {
      try {
        const projectConversation = database.getProjectConversation(conversation.project_id);
        const aiResult = await generateConversationReport({
          targetConversationId: conversationId,
          projectConversationId: projectConversation ? projectConversation.id : conversationId,
          db: database,
          options: aiReportOptions || {},
        });
        if (aiResult && aiResult.report) {
          report.aiReport = aiResult.report;
        } else if (aiResult && aiResult.error) {
          console.warn(`[delete] AI report for deleted conversation ${conversationId} unavailable: ${aiResult.error}`);
        }
      } catch (aiError) {
        console.error('[delete] Failed to generate AI report for the deleted conversation:', aiError && aiError.message ? aiError.message : aiError);
      }
    }

    return { report, error: null };
  } catch (error) {
    return {
      report: null,
      error: error && error.message ? error.message : 'Failed to generate deletion report',
    };
  }
}

/**
 * Formats the conversation deletion report as a user message for Project Memory.
 *
 * Follows the spec:
 * - If the conversation was confirmed merged (tracked changes committed and
 *   merged), a robust report is produced. When the AI report is available
 *   (report.aiReport), that generated summary is injected; otherwise the full
 *   static payload is used as fallback.
 * - If it was not merged (or the git state is unknown), a simple message is
 *   injected saying the conversation was discarded, since no work can be
 *   assumed to have survived.
 *
 * @param {Object} report - Payload generated by buildDeletionReportPayload().
 * @returns {string} Markdown ready to be injected as a message.
 */
function formatConversationDeletionReport(report) {
  const title = report.title || '(untitled)';

  // Shared context for all deletion reports.
  const header = `A new piece of work was completed in the deleted conversation «${title}».`;
  const mergeLine = report.isSafe
    ? `This work was merged into ${report.baseBranch || 'the base branch'}.`
    : 'This work was not merged and is considered discarded.';
  const metaLines = [
    `- conversationId: ${report.conversationId}`,
    `- mergeStatus: ${report.mergeStatus}`,
    `- baseBranch: ${report.baseBranch || null}`,
    `- gitBranch: ${report.gitBranch || null}`,
    `- deletedAt: ${report.deletedAt}`,
    `- summary: ${report.summary}`,
  ];

  // Not merged (or unknown git state): concise static report.
  if (!report.isSafe) {
    return [
      header,
      '',
      mergeLine,
      '',
      'Please review whether project notes should be updated.',
      'If relevant, create new notes to preserve useful context.',
      'Question whether any existing notes still make sense or need revision with the user.',
      '',
      ...metaLines,
    ].join('\n');
  }

  // Merged: concise static report with explicit review prompt.
  return [
    header,
    '',
    mergeLine,
    '',
    'Please review whether project notes should be updated.',
    'If relevant, create new notes to preserve useful context.',
    'Question whether any existing notes still make sense or need revision with the user.',
    '',
    ...metaLines,
  ].join('\n');
}

/**
 * Delivers a user message to the project's Project Memory conversation
 * informing it that a conversation was deleted.
 *
 * Primary path: ConversationManager.stateChange (persists the message, queues
 * the conversation and triggers the Project Memory AI turn). If the FSM drops
 * the event (e.g. the conversation is in phase 'active' and stateChange returns
 * null), it falls back to a direct DB insert so the report is not lost.
 *
 * @param {Object} params
 * @param {Object} params.conversation - Deleted conversation (no longer in the DB).
 * @param {Object|null} params.deletionReport - Deletion report (may be null).
 * @param {Object} params.db - DatabaseAPI.
 * @returns {Promise<boolean>} true if the message was persisted.
 */
async function deliverDeletionReportToProjectMemory({ conversation, deletionReport, db }) {
  try {
    const projectConversation = db.getOrCreateProjectConversation(conversation.project_id);
    if (!projectConversation) {
      console.error('[delete] No Project Memory conversation available for project', conversation.project_id);
      return false;
    }

    const content = deletionReport
      ? formatConversationDeletionReport(deletionReport)
      : `The conversation «${conversation.title || '(untitled)'}» was discarded.`;

    const reportMessage = {
      conversation_id: projectConversation.id,
      role: 'user',
      content,
      status: 'completed',
      created_at: new Date().toISOString(),
    };

    // Lazy require to avoid circular dependencies with the serviceFactory.
    const serviceFactory = require('./serviceFactory');
    const cm = serviceFactory.getConversationManager();

    // 1. Primary path: stateChange (persists the message, queues the
    //    conversation and triggers the AI turn). May return null if the FSM
    //    drops the event.
    let delivered = false;
    try {
      const created = await cm.stateChange(projectConversation, reportMessage);
      delivered = Boolean(created && created.id);
    } catch (stateError) {
      console.error('[delete] stateChange failed while delivering deletion report:', stateError && stateError.message ? stateError.message : stateError);
    }

    // 2. Fallback: persist the message directly so the report is not lost.
    if (!delivered) {
      // If stateChange already persisted the message before throwing (e.g. a
      // broadcast error), do not duplicate it.
      const alreadyStored = (() => {
        try {
          const msgs = db.getMessagesByConversation(projectConversation.id) || [];
          return msgs.some(m => m.role === 'user' && m.content === content);
        } catch (_) {
          return false;
        }
      })();

      if (!alreadyStored) {
        try {
          const createdMessage = db.createMessage(reportMessage);
          if (createdMessage) {
            console.log(`[delete] Deletion report persisted directly in Project Memory conversation ${projectConversation.id}`);
            delivered = true;
          }
        } catch (fallbackError) {
          console.error('[delete] Failed to persist deletion report in Project Memory (fallback):', fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
        }
      } else {
        delivered = true;
      }
    }

    if (delivered) {
      console.log(`[delete] Deletion report delivered to Project Memory conversation ${projectConversation.id}`);
    }

    return delivered;
  } catch (memoryError) {
    console.error('[delete] Failed to deliver deletion report to Project Memory:', memoryError && memoryError.message ? memoryError.message : memoryError);
    return false;
  }
}

module.exports = {
  generateConversationReport,
  generateConversationDeletionReport,
  buildDeletionReportPayload,
  formatConversationDeletionReport,
  deliverDeletionReportToProjectMemory,
  resolveTargetProviderModel,
  buildLinkageMap,
  MAX_REPORT_CHARS,
};
