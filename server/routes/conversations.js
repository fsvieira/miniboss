const express = require('express');
const router = express.Router();
const { DatabaseAPI, DatabaseConnection } = require('../services/db');
const { countMessageTokens, getTokenLimit } = require('../controllers/tokenController');
const { AiClient } = require('../services/ai');
const { filterMessagesForLLM, normalizeMessagesForLLM } = require('../utils/messageFilter');
const aiController = require('../controllers/aiControllerSingleton');
const gitService = require('../services/gitService');
const serviceFactory = require('../services/serviceFactory');
const { getMaxIterations } = require('../utils/maxIterations');
const { generateConversationDeletionReport, deliverDeletionReportToProjectMemory } = require('../services/conversationReport');

// Database API instance
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

function setIO(socketIO) {
  // AI controller now uses messageController for WebSocket communication
  // No need to set IO directly
}


// GET single conversation
router.get('/:id', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conversation);
});

// PUT update conversation
router.put('/:id', (req, res) => {
  const { title } = req.body;
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  if (title === undefined || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const updatedConversation = db.updateConversation(req.params.id, { title: String(title).trim() });
  res.json(updatedConversation);
});

// PUT update conversation model
router.put('/:id/model', (req, res) => {
  const { providerId, model, thinkingMode } = req.body;
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  if (!model || !String(model).trim()) {
    return res.status(400).json({ error: 'Model is required' });
  }

  let provider_id = null;
  if (providerId !== undefined && providerId !== null && providerId !== '') {
    const provider = db.getProvider(providerId);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    provider_id = Number(providerId);
  }

  const data = { model: String(model).trim() };
  if (provider_id !== null) data.provider_id = provider_id;
  if (thinkingMode !== undefined) data.thinking_mode = thinkingMode ? serializeThinkingMode(thinkingMode) : null;

  const updatedConversation = db.updateConversation(req.params.id, data);
  res.json(updatedConversation);
});

// GET conversation context info
router.get('/:id/context', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const conversation = db.getConversation(req.params.id);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
  
      // Get messages (full objects for pack builder, stripped only for raw token count)
      const fullMessages = db.getMessagesByConversation(req.params.id);
      const messages = fullMessages.map(m => ({ role: m.role, content: m.content }));
  
      // Get provider and model info (similar to aiController logic)
      let targetProvider = null;
      let targetModel = null;
  
      if (conversation.provider_id) {
        targetProvider = db.getProvider(conversation.provider_id);
      }
      if (conversation.model) {
        targetModel = conversation.model;
      }
  
      // Fallback to active provider if not conversation-specific
      if (!targetProvider) {
        const activeProviders = db.getActiveProviders();
        targetProvider = activeProviders.length > 0 ? activeProviders[0] : null;
      }
  
      // Get default model from settings if not provided
      if (!targetModel) {
        const setting = db.getSetting('default_model');
        targetModel = setting || 'gpt-3.5-turbo';
      }

      // Effective thinking mode: the conversation's, otherwise the global default (settings)
      const thinkingMode = conversation.thinking_mode
        || db.getSetting('default_thinking_mode')
        || null;
  
      // Calculate token info (raw)
      const input_tokens = countMessageTokens(messages);
      let tokenLimit = getTokenLimit(targetModel);

      // Try to get real context length from the provider
      if (targetProvider) {
        try {
          const aiClient = new AiClient({
            apiKey: targetProvider.api_key || 'dummy',
            baseUrl: targetProvider.base_url,
          });
          const fetched = await aiClient.getModelContextLength(targetModel);
          if (fetched && fetched > 0) {
            tokenLimit = fetched;
          }
          aiClient.close();
        } catch (_) {
          tokenLimit = getTokenLimit(targetModel);
        }
      }

      // Ensure minimum
      if (!tokenLimit || tokenLimit < 4096) tokenLimit = 32768;

      // Compute compressed token count: filtered + normalized messages only
      // (same logic as the LLM receives, minus light state for simplicity)
      let compressed_tokens = null;
      try {
        const filtered = filterMessagesForLLM(fullMessages, { lastNResponses: 100, minAssistantLength: 150, excludeSystem: conversation.conversation_type === 'focus' });
        const normalized = normalizeMessagesForLLM(filtered);
        compressed_tokens = countMessageTokens([
          { role: 'system', content: 'MiniBoss reasoning engine.' },
          ...normalized,
        ]);
      } catch (e) {
        // fall back to raw if estimation fails
        compressed_tokens = null;
      }

      const effectiveTokens = (compressed_tokens != null && compressed_tokens < input_tokens)
        ? compressed_tokens
        : input_tokens;

      const percentage = Math.round((effectiveTokens / tokenLimit) * 100);
      const message_count = messages.length;

      // Metrics (Phase D): total token usage of conversation + descendants
      const usage = db.getConversationTokenUsage(req.params.id);
      const subtreeIds = db.getConversationSubtreeIds(req.params.id);
      let question_count = 0;
      try {
        const qStmt = db.connection.prepare(`
          SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND role = 'user'
        `);
        question_count = Number(qStmt.get(req.params.id)?.c) || 0;
      } catch (_) {}

      // Focus depth (conversation depth level)
      let focus_level = 0;
      let ancestor = db.getConversation(req.params.id);
      while (ancestor && ancestor.parent_id) {
        focus_level++;
        ancestor = db.getConversation(ancestor.parent_id);
      }

      res.json({
        message_count,
        input_tokens,
        compressed_tokens,
        token_limit: tokenLimit,
        percentage: Math.min(percentage, 100),
        model: targetModel,
        provider_name: targetProvider ? targetProvider.name : null,
        thinking_mode: thinkingMode,
        total_tokens: usage.total_tokens,
        total_cost: usage.total_cost_usd,
        models: usage.models,
        question_count,
        subbot_count: Math.max(0, subtreeIds.length - 1),
        focus_level,
      });
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

router.get('/:id/git', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const gitState = await gitService.getConversationGitState(req.params.id);
      res.json(gitState);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

router.get('/:id/git/diff', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const gitDiff = await gitService.getConversationGitDiff(req.params.id);
      res.json(gitDiff);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

router.post('/:id/git/commit', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const gitState = await gitService.commitConversationChanges(req.params.id, req.body?.message);
      res.json(gitState);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

router.post('/:id/git/merge', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const gitState = await gitService.mergeConversationBranch(req.params.id);
      res.json(gitState);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

router.post('/:id/git/reset', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const gitState = await gitService.resetConversationWorktree(req.params.id);
      res.json(gitState);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

// POST open folder for conversation
router.post('/:id/open-folder', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const conversation = db.getConversation(req.params.id);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const gitState = await gitService.getConversationGitState(req.params.id);
      const folderPath = gitState.folderPath || gitState.repoRoot;

      if (!folderPath) {
        res.status(400).json({ error: 'Conversation folder path is not available' });
        return;
      }

      try {
        const { execFile } = require('child_process');
        const platform = process.platform;

        if (platform === 'darwin') {
          execFile('open', [folderPath]);
        } else if (platform === 'win32') {
          execFile('explorer', [folderPath]);
        } else {
          execFile('xdg-open', [folderPath]);
        }

        res.json({ opened: true, path: folderPath });
      } catch (error) {
        res.status(400).json({ error: error.message || 'Failed to open folder' });
      }
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

// POST cancel active AI operation for conversation
router.post('/:id/cancel', (req, res) => aiController.cancelConversationOperation(req, res));

// POST clear conversation messages
router.post('/:id/clear', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  Promise.resolve().then(async () => {
    try {
      await aiController.cancelOperation(req.params.id);

      const toolProcessor = serviceFactory.getToolProcessor();
      toolProcessor.cleanupConversation(req.params.id);
      aiController.cleanupConversation(req.params.id);

      db.deleteAllFocusConversations(req.params.id);

      db.deleteMessagesByConversation(req.params.id);

      db.updateConversationTimestamp(req.params.id);

      db.updateConversationState(req.params.id, {
        processing_state: 'idle',
        phase: 'idle',
      });

      try {
        db.connection.prepare(
          'UPDATE conversations SET active_focus_id = NULL WHERE id = ?'
        ).run(req.params.id);
      } catch (_) {}

      res.json({ success: true });
    } catch (error) {
      console.error('Error clearing conversation messages:', error);
      res.status(500).json({ error: 'Failed to clear conversation messages' });
    }
  });
});

// GET focus conversations for a parent conversation (MAIN or FOCUS)
router.get('/:id/focus-conversations', (req, res) => {
  const parent = db.getConversation(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Conversation not found' });

  const focusConversations = db.getFocusConversations(req.params.id);
  res.json(focusConversations);
});

// GET focus tree (recursive) for a conversation
router.get('/:id/focus-tree', (req, res) => {
  const parent = db.getConversation(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Conversation not found' });

  const focusTree = db.getFocusTree(req.params.id);
  res.json(focusTree);
});

// GET parent conversation (for navigation back)
router.get('/:id/parent', (req, res) => {
  const child = db.getConversation(req.params.id);
  if (!child) return res.status(404).json({ error: 'Conversation not found' });

  if (!child.parent_id) return res.json(null);
  const parent = db.getConversation(child.parent_id);
  res.json(parent);
});

// GET sub-conversations by parent id
router.get('/:id/sub-conversations', (req, res) => {
  const parent = db.getConversation(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Conversation not found' });

  const subConversations = db.getSubConversations(req.params.id);
  res.json(subConversations);
});

// DELETE conversation
router.delete('/:id', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  // The project global conversation is persistent (if deleted, it is recreated lazily)
  if (conversation.conversation_type === 'project') {
    return res.status(400).json({ error: 'The Project Memory conversation cannot be deleted' });
  }

  Promise.resolve()
    .then(async () => {
      await aiController.cancelOperation(req.params.id);

      const toolProcessor = serviceFactory.getToolProcessor();
      toolProcessor.cleanupConversation(req.params.id);
      aiController.cleanupConversation(req.params.id);

      let deletionReport = null;
      try {
        const reportResult = await generateConversationDeletionReport({
          conversationId: req.params.id,
          db,
        });
        deletionReport = reportResult.report || null;
      } catch (reportError) {
        console.error('[delete] Failed to generate conversation deletion report:', reportError && reportError.message ? reportError.message : reportError);
        deletionReport = null;
      }

      if (!conversation.parent_id) {
        await gitService.deleteConversationWorktree(req.params.id);
      }
      db.deleteConversation(req.params.id);

      // Notify the Project Memory conversation of the deletion: inject a user
      // message with the report. If the conversation was already merged with the
      // original branch the report is robust; otherwise, only indicate it was
      // deleted. The Project Memory AI is the project's persistent memory and
      // should be aware of the event.
      await deliverDeletionReportToProjectMemory({
        conversation,
        deletionReport,
        db,
      });

      res.status(204).send();
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

// POST /:id/execute-plan — Executar o plano da conversa global do projeto
router.post('/:id/execute-plan', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const conv = db.getConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });

      if (conv.conversation_type !== 'project') {
        return res.status(400).json({ error: 'execute-plan is only available for the Project Memory conversation' });
      }

      const plan = (conv.plan || '').trim();
      if (!plan) {
        return res.status(400).json({ error: 'No plan to execute' });
      }

      const project = db.getProject(conv.project_id);
      if (!project || !project.folder_path) {
        return res.status(400).json({ error: 'Project has no folder_path set' });
      }

      const repoRoot = await gitService.validateProjectRepository(project.folder_path);

      const title = deriveExecutionTitle(plan, project.name);
      const execution = db.createConversation({
        project_id: conv.project_id,
        title,
        conversation_type: 'main',
        max_iterations: getMaxIterations()
      });

      db.updateProjectTimestamp(conv.project_id);

      await gitService.ensureConversationWorktree(execution.id);
      await gitService.copyExtraFilesToWorktree(execution.id);

      db.updatePlan(execution.id, plan);
      db.setConversationMode(execution.id, 'exec');

      db.createPlanExecution({
        project_id: conv.project_id,
        global_conversation_id: conv.id,
        execution_conversation_id: execution.id,
        plan,
        status: 'executing',
      });

      serviceFactory.getConversationManager().handleUserMessage(
        { content: 'Execute the current plan. Use getPlan to load it and start with the first task.' },
        execution.id,
        null
      );

      res.status(201).json({ executionConversationId: execution.id });
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

// ── Embeddings / Indexing routes ────────────────────────────────────────────

const indexer = require('../indexer');

// POST /:id/index — Index this conversation's project + worktree (SSE)
router.post('/:id/index', (req, res) => {
  const conversationId = req.params.id;
  console.log(`[SEMANTIC SEARCH API] SSE index request for conversation ${conversationId}`);
  const conversation = db.getConversationWithProject(conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  if (!conversation.folder_path) {
    return res.status(400).json({ error: 'Project has no folder_path set' });
  }

  const workingDir = conversation.worktree_path;

  if (!indexer.isEmbeddingsConfigured()) {
    console.log('[SEMANTIC SEARCH API] Embeddings not configured');
    return res.status(400).json({ error: 'Embeddings not configured' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) { /* ignore */ }
  };

  Promise.resolve()
    .then(async () => {
      // Index project
      const projectResult = await indexer.indexProject(
        conversation.project_id,
        conversation.folder_path,
        (file, _null, totalFiles, totalChunks, chunksIndexed) => {
          sendEvent({
            type: 'progress',
            source: 'project',
            file,
            totalFiles,  
            totalChunks,
            chunksIndexed,
          });
        }
      );

      sendEvent({
        type: 'progress',
        source: 'project',
        file: null,
        indexableCount: projectResult.totalFiles,
        totalChunks: projectResult.totalChunks,
        chunksIndexed: projectResult.totalChunks,
        done: true,
      });

      // Index worktree
      if (workingDir) {
        const worktreeResult = await indexer.indexConversation(
          req.params.id,
          workingDir,
          (file, _null, totalFiles, totalChunks, chunksIndexed) => {
            sendEvent({
              type: 'progress',
              source: 'worktree',
              file,
              totalFiles,
              totalChunks,
              chunksIndexed,
            });
          }
        );

        sendEvent({
          type: 'progress',
          source: 'worktree',
          file: null,
          totalFiles: worktreeResult.totalFiles,
          totalChunks: worktreeResult.totalChunks,
          chunksIndexed: worktreeResult.totalChunks,
          done: true,
        });
      }

      const status = indexer.getIndexStatus(req.params.id);
      console.log(`[SEMANTIC SEARCH API] SSE index completed for conversation ${req.params.id}: ${status.chunkCount} chunks`);
      sendEvent({ type: 'done', chunkCount: status.chunkCount });
    })
    .catch((error) => {
      console.error(`[SEMANTIC SEARCH API] SSE index failed for conversation ${req.params.id}: ${error.message}`);
      sendEvent({ type: 'error', error: error.message });
    })
    .finally(() => {
      try { res.end(); } catch (_) { /* ignore */ }
    });
});

// POST /:id/reindex — Re-index changed files only
router.post('/:id/reindex', (req, res) => {
  const conversationId = req.params.id;
  console.log(`[SEMANTIC SEARCH API] Re-index request for conversation ${conversationId}`);
  const conversation = db.getConversation(conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  if (!indexer.isEmbeddingsConfigured()) {
    console.log('[SEMANTIC SEARCH API] Embeddings not configured');
    return res.status(400).json({ error: 'Embeddings not configured' });
  }

  Promise.resolve()
    .then(async () => {
      const result = await indexer.reindexChangedFiles(conversationId, conversation.worktree_path);
      const status = indexer.getIndexStatus(conversationId);
      console.log(`[SEMANTIC SEARCH API] Re-index completed for conversation ${conversationId}: ${result.reindexed} files reindexed`);
      res.json({ reindexed: result.reindexed, ...status });
    })
    .catch((error) => {
      console.error(`[SEMANTIC SEARCH API] Re-index failed for conversation ${conversationId}: ${error.message}`);
      res.status(400).json({ error: error.message });
    });
});

// GET /:id/index-status — Get indexing status
router.get('/:id/index-status', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const status = indexer.getIndexStatus(req.params.id);
  const modelChanged = indexer.isModelChanged(req.params.id);

  res.json({
    ...status,
    modelChanged,
    embeddingsConfigured: indexer.isEmbeddingsConfigured(),
  });
});

// GET /:id/tasks — Get task tree for conversation
router.get('/:id/tasks', (req, res) => {
  const conversationId = req.params.id;
  const conversation = db.getConversation(conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const tasks = db.getTaskTree(conversationId);
  res.json(tasks);
});

// GET /:id/plan — Get current plan (Plan Mode)
router.get('/:id/plan', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ plan: conversation.plan || null });
});

// PUT /:id/plan — Update current plan (Plan Mode)
router.put('/:id/plan', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const plan = req.body?.plan;
  const updated = db.updatePlan(req.params.id, plan);
  res.json({ plan: updated ? updated.plan : null });
});

// PUT /:id/mode — Set Plan Mode ('plan' read-only | 'exec')
router.put('/:id/mode', (req, res) => {
  const conversation = db.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const mode = req.body?.mode;
  if (mode !== 'plan' && mode !== 'exec') {
    return res.status(400).json({ error: 'mode must be "plan" or "exec"' });
  }

  const updated = db.setConversationMode(req.params.id, mode);
  res.json(updated);
});

/**
 * Serializa o thinking_mode para armazenamento na coluna TEXT.
 *
 * Aceita:
 *   - string: "high" | "none" -> guardado como string simples
 *   - objeto: { effort: "high" } | { enabled: true, maxTokens: 8000 } -> JSON.stringify
 *   - null/undefined/vazio -> null
 *
 * @param {string|Object|null|undefined} thinkingMode
 * @returns {string|null}
 */
function serializeThinkingMode(thinkingMode) {
  if (!thinkingMode) return null;

  // Se for objeto, serializar como JSON
  if (typeof thinkingMode === 'object') {
    return JSON.stringify(thinkingMode);
  }

  // Se for string, tentar parsear como JSON (se parecer JSON) para validar;
  // otherwise store as simple string
  const trimmed = String(thinkingMode).trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      // Validate that it is valid JSON; re-serialize normalized
      return JSON.stringify(JSON.parse(trimmed));
    } catch (_) {
      // Not valid JSON, store as simple string
      return trimmed;
    }
  }

  return trimmed;
}

/**
 * Derives the execution conversation title from the plan
 * (first useful line, without markdown, truncated to 60 chars).
 * Fallback: "Execution — <projectName>".
 */
function deriveExecutionTitle(plan, projectName) {
  const lines = String(plan || '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cleaned = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim();
    if (cleaned && /[a-z0-9\u00C0-\uFFFF]/i.test(cleaned)) {
      return cleaned.slice(0, 60).trim() || `Execution — ${projectName}`;
    }
  }
  return `Execution — ${projectName}`;
}

module.exports = { router, setIO };
