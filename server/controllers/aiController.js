const OpenAI = require('openai');
const { execSync } = require('child_process');
const { createTools, executeTool } = require('../tools');
const { countMessageTokens, getTokenLimit } = require('./tokenController');
const db = require('../database');
const gitService = require('../services/gitService');
const { ProgressTracker } = require('../services/progressService');
const { buildStructuredError, getRetryAfter, isRateLimitError, sleep } = require('./errorUtils');
const { safeSerializeToolResult, truncateToolResult, isAbortError, getToolNames, MAX_TOOL_RESULT_LENGTH } = require('./toolUtils');

const { AiClient } = require('../services/ai');



/**
 * Call the LLM with retry logic for rate limit (429) errors.
 * Returns { response, error } where exactly one is non-null.
 */
class AIController {
    constructor() {
      this.activeOperations = new Map();
      this.pendingApprovals = new Map();
      this.pendingApprovalHandlers = new Map();
      this.approvalTimeoutMs = 600000; // 10 minutes timeout (auto-deny)
    }

  /**
   * Handle a command approval response from the WebSocket.
   * Resolves the pending promise so the loop can continue.
   */
   handleCommandApproval(toolCallId, approved, meta = {}) {
     // New flow: resolve handler
     const handler = this.pendingApprovalHandlers.get(toolCallId);
     if (handler) {
       handler({ approved, ...meta });
       this.pendingApprovalHandlers.delete(toolCallId);
       return true;
     }
     // Legacy
     const pending = this.pendingApprovals.get(toolCallId);
     if (!pending) {
       console.log(`[AI] No pending approval for toolCallId=${toolCallId}`);
       return false;
     }
     clearTimeout(pending.timeout);
     pending.resolve({ approved, ...meta });
     this.pendingApprovals.delete(toolCallId);
     return true;
   }

   async requestApproval(toolCallId, approvalData) {
     // approvalData already created in DB by caller if needed
     return new Promise((resolve) => {
       this.pendingApprovalHandlers.set(toolCallId, (resolution) => {
         resolve(resolution);
       });
     });
   }

  setConversationStatus(conversationId, status) {
    if (!conversationId) {
      return;
    }

    const messageController = require('./messageController');
    messageController.emitToConversation(conversationId, 'ai-status', {
      conversationId,
      status
    });
  }

  startOperation(conversationId, type) {
    const existingOperation = this.activeOperations.get(conversationId);
    if (existingOperation) {
      existingOperation.controller.abort();
    }

    const controller = new AbortController();
    this.activeOperations.set(conversationId, { controller, type });
    this.setConversationStatus(conversationId, 'generating');

    return controller;
  }

  finishOperation(conversationId, controller) {
    const activeOperation = this.activeOperations.get(conversationId);
    if (activeOperation && activeOperation.controller === controller) {
      this.activeOperations.delete(conversationId);
      this.setConversationStatus(conversationId, 'idle');
    }
  }

  /**
   * Cancel a single conversation operation.
   *
   * Marca a conversa como 'cancelling' na BD (persistente) para que o loop
   *  (queued/tool_exec/tool_results) does NOT relaunch new requests to OpenAI,
   * and aborts the in-flight operation AbortController if it exists.
   *
   * @returns {boolean} True if there was an active operation and it was aborted.
   */
  _cancelSingleOperation(conversationId, reason = 'cancelled_by_user', db = null) {
    const activeOperation = this.activeOperations.get(conversationId);
    if (activeOperation) {
      activeOperation.controller.abort();
    }

    this.setConversationStatus(conversationId, 'cancelling');

    // Persistir o marcador 'cancelling' para que o loop non volva a lanzar AI.
    if (db) {
      try {
        const conv = db.getConversation(conversationId);
        if (conv) {
          const BUSY_STATES = ['queued', 'sending', 'ai_processing', 'tool_exec', 'tool_results', 'cancelling'];
          if (BUSY_STATES.includes(conv.processing_state)) {
            db.updateProcessingState(conversationId, 'cancelling');
            this.setConversationStatus(conversationId, 'cancelling');
          }
        }
      } catch (_) {}
    }

    return Boolean(activeOperation);
  }

  /**
   * Mark a focus conversation as cancelled and notify its parent.
   * This handles the zombie case where a focus leaf is cancelled directly
   * (without going through its parent) — the leaf itself was never marked
   * as terminal, blocking the parent forever.
   */
  async _markFocusCancelled(db, focus, reason) {
    console.log(`[AI Controller] Marking focus ${focus.id} as cancelled: ${reason}`);

    db.updateFocusReport(focus.id, JSON.stringify({
      summary: 'Cancelled by user',
      completed: false,
      cancelledAt: new Date().toISOString(),
      reason: reason || 'Cancelled'
    }));

    db.clearActiveFocus(focus.parent_id);

    let ancestorId = focus.parent_id;
    while (ancestorId) {
      const ancestor = db.getConversation(ancestorId);
      if (!ancestor) break;
      if (ancestor.active_focus_id === focus.id || ancestor.active_focus_id == focus.id) {
        db.clearActiveFocus(ancestor.id);
      }
      ancestorId = ancestor.parent_id;
    }

    try {
      const socketService = require('../services/socketService');
      socketService.broadcastToConversation(focus.parent_id, 'focus_report', {
        focusId: focus.id,
        parentConversationId: focus.parent_id,
        title: focus.title,
        report: JSON.stringify({
          summary: 'Cancelled by user',
          completed: false,
          reason: reason || 'Cancelled'
        }),
        status: 'cancelled'
      });
      socketService.broadcastToConversation(focus.id, 'focus_report', {
        focusId: focus.id,
        parentConversationId: focus.parent_id,
        title: focus.title,
        report: JSON.stringify({
          summary: 'Cancelled by user',
          completed: false,
          reason: reason || 'Cancelled'
        }),
        status: 'cancelled'
      });
    } catch (_) {}

    try {
      const cm = require('../services/serviceFactory').getConversationManager();
      cm.handleUserMessage(
        { content: `Focus "${focus.title}" was cancelled. Report: Cancelled by user.` },
        focus.parent_id,
        null
      );
    } catch (_) {}
  }

  /**
   * Cancel operation for a conversation AND recursively cancel all active focus descendants.
   * Also marks orphaned focus conversations as cancelled/interrupted.
   */
  async cancelOperation(conversationId, providedDb = null) {
    let ownDb = false;
    let db = providedDb;
    try {
      if (!db) {
        const { DatabaseAPI, DatabaseConnection } = require('../services/db');
        const connection = new DatabaseConnection();
        db = new DatabaseAPI(connection);
        ownDb = true;
      }

      // 1. Cancel the conversation itself (abort in-flight + mark 'cancelling' in DB)
      this._cancelSingleOperation(conversationId, 'cancelled_by_user', db);

      // 2. Recursively cancel all focus children
      await this._cancelFocusChain(db, conversationId, 'Parent conversation was cancelled');

      // 3. If the cancelled conversation IS a focus without a report, mark it terminal
      const conv = db.getConversation(conversationId);
      if (conv && conv.conversation_type === 'focus' && !conv.focus_report) {
        await this._markFocusCancelled(db, conv, 'Focus cancelled by user');
      }

      // 3.5 Finalize o loop da conversa: transita a estado terminal, emite
      //     'stream_cancelled' + 'done'. Idempotent — will be re-called by
      //     guards of ConversationManager if the abort propagates after.
      try {
        const cm = require('../services/serviceFactory').getConversationManager();
        if (cm) {
          cm.finalizeCancelledConversation(conversationId);
        }
      } catch (_) {}

      // 4. Clean up any pending approval handlers for this conversation
      for (const [toolCallId, handler] of this.pendingApprovalHandlers) {
        try {
          const pending = db.getPendingApprovalByToolCallId(toolCallId);
          if (pending && pending.conversation_id == conversationId) {
            handler({ approved: false, reason: 'cancelled' });
            this.pendingApprovalHandlers.delete(toolCallId);
          }
        } catch (_) {}
      }

      return true;
    } catch (error) {
      console.error('[AI Controller] Error during cancelOperation:', error);
      return false;
    } finally {
      if (ownDb && db && db.connection && typeof db.connection.close === 'function') {
        try { db.connection.close(); } catch (_) {}
      }
    }
  }

  /**
   * Recursively cancel all focus conversations in the chain.
   */
  async _cancelFocusChain(db, parentId, reason) {
    const foci = db.getFocusConversations(parentId);
    for (const focus of foci) {
      this._cancelSingleOperation(focus.id, reason);

      if (!focus.focus_report) {
        await this._markFocusCancelled(db, focus, reason || 'Parent conversation was cancelled');
      }

      await this._cancelFocusChain(db, focus.id, reason);
    }
  }

  hasActiveOperation(conversationId) {
    return this.activeOperations.has(conversationId);
  }

  cleanupConversation(conversationId) {
    this._cancelSingleOperation(conversationId, 'cleanup');

    for (const [toolCallId, handler] of this.pendingApprovalHandlers) {
      this.pendingApprovalHandlers.delete(toolCallId);
    }

    for (const [toolCallId, pending] of this.pendingApprovals) {
      if (pending.conversationId == conversationId) {
        clearTimeout(pending.timeout);
        this.pendingApprovals.delete(toolCallId);
      }
    }

    this.activeOperations.delete(conversationId);
  }

  /**
   * Log AI activity with structured prefix for easy filtering.
   */
  logAI(conversationId, message, data = {}) {
    const timestamp = new Date().toISOString();
    const prefix = `[AI:${conversationId}]`;
    const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    console.log(`${prefix} ${message}${dataStr}`);
  }

  async fetchModels(req, res) {
    try {
      const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.providerId);
      if (!provider) {
        return res.status(404).json({ error: 'Provider not found' });
      }

      const aiClient = new AiClient({
        apiKey: provider.api_key || 'dummy',
        baseUrl: provider.base_url,
      });

      const models = await aiClient.listModels();
      aiClient.close();

      // Pricing cache (Phase D) for cost calculation
      try {
        const { cacheModelPricing } = require('../services/ai/pricing');
        cacheModelPricing(models);
      } catch (_) {}

      res.json(models);
    } catch (error) {
      console.error('Error fetching models:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch models' });
    }
  }

  async cancelConversationOperation(req, res) {
    const { id: conversationId } = req.params;
    const cancelled = await this.cancelOperation(conversationId);

    if (cancelled) {
      return res.json({ success: true, status: 'cancelling' });
    }

    return res.json({ success: true, status: 'idle' });
  }
}

module.exports = AIController;