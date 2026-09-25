const serviceRegistry = require('./serviceFactory');
const {
  buildRuleFromTemplate,
  hashRule,
  parseSimpleCommand,
  resolvePathToken,
  validateTemplate
} = require('./commandApprovalService');

class SocketService {
  constructor() {
    this.io = null;
    this.aiController = null;
    this.approvalSweepTimer = null;
  }

  initialize(io) {
    this.io = io;
    this.setupConnectionHandlers();
  }

  setAIController(controller) {
    this.aiController = controller;
    this.startApprovalExpirySweep();
  }

  startApprovalExpirySweep() {
    if (this.approvalSweepTimer) {
      return;
    }

    this.approvalSweepTimer = setInterval(() => {
      try {
        const db = serviceRegistry.getDatabaseAPI();
        const expiredApprovals = db.expirePendingApprovals();

        expiredApprovals.forEach((approval) => {
          this.aiController?.handleCommandApproval(approval.tool_call_id, false, { reason: 'expired' });
          this.broadcastToConversation(approval.conversation_id, 'approval_expired', {
            conversationId: approval.conversation_id,
            tool_call_id: approval.tool_call_id,
            toolCallId: approval.tool_call_id,
            expiresAt: approval.expires_at
          });

          const toolProcessor = serviceRegistry.getToolProcessor();
          if (toolProcessor) {
            toolProcessor.resolveCommandApproval(approval.tool_call_id, false);
          }
        });
      } catch (error) {
        console.error('[SOCKET] Failed to expire pending approvals', error);
      }
    }, 5000);
  }

  stopApprovalExpirySweep() {
    if (this.approvalSweepTimer) {
      clearInterval(this.approvalSweepTimer);
      this.approvalSweepTimer = null;
    }
  }

  setupConnectionHandlers() {
    if (!this.io) {
      throw new Error('Socket.IO not initialized');
    }

    this.io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
      });

      // Allow clients to join conversation rooms
      socket.on('join-conversation', (conversationId) => {
        socket.join(`conversation-${conversationId}`);
        console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
      });

      // Hydrate newly connected clients with known focus states so the UI
      // can render completed/cancelled focuses correctly after restart.
      try {
        const db = serviceRegistry.getDatabaseAPI();
        const { computeConversationStatus } = require('./conversationStatus');
        const terminalFocuses = db.getTerminalFocusConversations();
        for (const focus of terminalFocuses) {
          const conversationId = focus.id;
          if (!conversationId) continue;
          if (focus.focus_report) {
            socket.emit('focus_report', {
              focusId: focus.id,
              report: JSON.parse(focus.focus_report),
              status: 'completed'
            });
          } else if (focus.phase && focus.phase !== 'active') {
            socket.emit('conversation_state', {
              conversationId,
              phase: focus.phase,
              processingState: focus.processing_state || 'idle',
              status: computeConversationStatus(focus, db),
              event: 'hydrate'
            });
            socket.emit('ai-status', focus.processing_state || 'idle');
          }
        }

        const activeFocuses = db.getActiveFocusConversations();
        for (const focus of activeFocuses) {
          const conversationId = focus.id;
          if (!conversationId) continue;

          if (focus.focus_report) {
            socket.emit('focus_report', {
              focusId: focus.id,
              report: JSON.parse(focus.focus_report),
              status: 'completed'
            });
            continue;
          }

          if (focus.phase === 'active') {
            socket.emit('conversation_state', {
              conversationId,
              phase: 'active',
              processingState: focus.processing_state || 'processing',
              status: computeConversationStatus(focus, db),
              event: 'hydrate'
            });
            socket.emit('ai-status', focus.processing_state || 'processing');
          } else if (focus.phase) {
            socket.emit('conversation_state', {
              conversationId,
              phase: focus.phase,
              processingState: focus.processing_state || 'idle',
              status: computeConversationStatus(focus, db),
              event: 'hydrate'
            });
            socket.emit('ai-status', focus.processing_state || 'idle');
          }
        }
      } catch (err) {
        console.error('[SOCKET] Failed to hydrate focus states:', err);
      }

      // Allow clients to leave conversation rooms
      socket.on('leave-conversation', (conversationId) => {
        socket.leave(`conversation-${conversationId}`);
        console.log(`Socket ${socket.id} left conversation ${conversationId}`);
      });

      // Handle command approval responses from the user
      socket.on('command_approval_response', (data) => {
        const { toolCallId, approved, conversationId } = data;
        console.log(`[SOCKET] Command approval response: toolCallId=${toolCallId}, approved=${approved}, conversationId=${conversationId}`);
        if (this.aiController) {
          try {
            const db = serviceRegistry.getDatabaseAPI();
            const pending = db.getPendingApprovalByToolCallId(toolCallId);
            if (!pending || pending.closed_at) {
              return;
            }

            db.closePendingApprovalByToolCallId(toolCallId, approved ? 'approved' : 'denied');
            this.aiController.handleCommandApproval(toolCallId, approved, {
              reason: approved ? 'approved' : 'denied'
            });
            this.broadcastToConversation(pending.conversation_id, 'approval_handled', {
              tool_call_id: toolCallId,
              toolCallId,
              approved,
              conversationId: pending.conversation_id,
              closeReason: approved ? 'approved' : 'denied'
            });

            // NOVO: Resolver a tool no ToolProcessor
            const toolProcessor = serviceRegistry.getToolProcessor();
            if (toolProcessor) {
              toolProcessor.resolveCommandApproval(toolCallId, approved);
            }
          } catch (e) { console.error('Failed to clean pending approval', e); }
        } else {
          console.error(`[SOCKET] No AI controller available for approval`);
        }
      });

      socket.on('command_auto_approve', (data) => {
        const { toolCallId, conversationId, template } = data || {};
        if (!toolCallId) {
          return;
        }

        try {
          const db = serviceRegistry.getDatabaseAPI();
          const pending = db.getPendingApprovalByToolCallId(toolCallId);
          if (!pending || pending.closed_at) {
            return;
          }

          const conversation = db.getConversationWithProject(pending.conversation_id);
          if (!conversation?.worktree_path) {
            socket.emit('error', { message: 'Conversation worktree not available for auto-approval.' });
            return;
          }

          const parsedCommand = parseSimpleCommand(
            pending.command,
            pending.cwd || conversation.worktree_path,
            conversation.worktree_path
          );
          const validation = validateTemplate(parsedCommand, template);
          if (!validation.ok) {
            socket.emit('error', { message: `Invalid auto-approval template: ${validation.reason}` });
            return;
          }

          const cwdValidation = resolvePathToken('.', parsedCommand.cwd, conversation.worktree_path);
          if (!cwdValidation.ok) {
            socket.emit('error', { message: 'Auto-approve only supports working directories inside the worktree.' });
            return;
          }

          for (const selectedPart of template.parts || []) {
            if (selectedPart.mode !== 'path') {
              continue;
            }
            const parsedPart = parsedCommand.parts.find((part) => part.index === selectedPart.index);
            const pathValidation = resolvePathToken(parsedPart?.value, parsedCommand.cwd, conversation.worktree_path);
            if (!pathValidation.ok) {
              socket.emit('error', { message: `Path token "${parsedPart?.value || ''}" is outside the worktree.` });
              return;
            }
          }

          const rule = buildRuleFromTemplate(parsedCommand, template);
          const savedRule = db.createAutoApprovalRule({
            command_name: parsedCommand.executable,
            rule_hash: hashRule(rule),
            rule_json: JSON.stringify(rule)
          });

          db.closePendingApprovalByToolCallId(toolCallId, 'auto_approved');
          this.aiController?.handleCommandApproval(toolCallId, true, {
            reason: 'auto_approved',
            autoApprovalRuleId: savedRule.id
          });

          this.broadcastToConversation(pending.conversation_id, 'approval_handled', {
            tool_call_id: toolCallId,
            toolCallId,
            approved: true,
            conversationId: pending.conversation_id,
            closeReason: 'auto_approved',
            autoApprovalRuleId: savedRule.id
          });
        } catch (error) {
          console.error('[SOCKET] Failed to auto-approve command', error);
          socket.emit('error', { message: `Failed to auto-approve command: ${error.message}` });
        }
      });

      // Handle AI chat messages via WebSocket
      socket.on('send_message', async (data) => {
        console.log('══════════════════════════════════════════════════════════');
        console.log('[SERVER] send_message received');
        console.log('  Socket ID     :', socket.id);
        console.log('  conversationId:', data?.conversationId);
        console.log('══════════════════════════════════════════════════════════');

        const { message, conversationId, model } = data;

        if (!conversationId || !message) {
          socket.emit('error', { message: 'Invalid message data' });
          return;
        }

        try {
          // handleUserMessage creates the message, broadcasts it,
          // marks conversation as queued, and starts processing
          serviceRegistry.getConversationManager().handleUserMessage(
            message, conversationId, model
          );
        } catch (error) {
          console.error(`[SOCKET] Error in send_message for conversation ${conversationId}:`, error);
          socket.emit('error', { message: 'Failed to process message', details: error.message });
        }
      });

      // Handle stream cancellation
      socket.on('cancel_stream', (data) => {
        const { conversationId } = data;
        console.log(`[SOCKET] Cancel stream request for conversation ${conversationId}, socket ${socket.id}`);

        if (this.aiController) {
          // cancelOperation aborts the in-flight request, marks the conversation as
          // 'cancelling' in the DB, and finalizes the loop. The terminal events
          // ('stream_cancelled' + 'done') are only emitted when everything is stopped
          // (via ConversationManager._finalizeCancel), so the UI does not
          // unlock prematurely.
          this.aiController.cancelOperation(conversationId);
        }
      });
    });
  }

  // Utility methods for broadcasting
  broadcastToConversation(conversationId, event, data) {
    if (this.io) {
      this.io.to(`conversation-${conversationId}`).emit(event, data);
    }
  }

  broadcastAIStatus(conversationId, status, conversationStatus = null) {
    this.broadcastToConversation(conversationId, 'ai-status', {
      conversationId,
      status,
      conversationStatus,
    });
  }

  // Focus system events
  broadcastFocusStarted(conversationId, data) {
    this.broadcastToConversation(conversationId, 'focus_started', {
      conversationId,
      ...data
    });
  }

  broadcastFocusHeartbeat(conversationId, data) {
    this.broadcastToConversation(conversationId, 'focus_heartbeat', {
      conversationId,
      ...data
    });
  }

  broadcastFocusReport(conversationId, data) {
    this.broadcastToConversation(conversationId, 'focus_report', {
      conversationId,
      ...data
    });
  }

  // Streaming AI events
  broadcastToolStart(conversationId, toolName, args, approvalPending, toolCallId) {
    this.broadcastToConversation(conversationId, 'tool_start', {
      conversationId,
      tool: toolName,
      args: args,
      approval_pending: approvalPending,
      tool_call_id: toolCallId
    });
  }

  broadcastToolEnd(conversationId, toolName, result) {
    this.broadcastToConversation(conversationId, 'tool_end', {
      conversationId,
      tool: toolName,
      result: result
    });
  }

  broadcastText(conversationId, content) {
    this.broadcastToConversation(conversationId, 'text', {
      conversationId,
      content: content
    });
  }

  broadcastCommandApprovalRequired(conversationId, data) {
    this.broadcastToConversation(conversationId, 'command_approval_required', {
      conversationId,
      ...data
    });
  }

  broadcastCheckpoint(conversationId, data) {
    this.broadcastToConversation(conversationId, 'checkpoint', { conversationId, ...data });
  }

  broadcastCheckpointComplete(conversationId, data) {
    this.broadcastToConversation(conversationId, 'checkpoint_complete', { conversationId, ...data });
  }

  broadcastContextCompressed(conversationId, data) {
    this.broadcastToConversation(conversationId, 'context_compressed', { conversationId, ...data });
  }

  broadcastStreamDone(conversationId) {
    this.broadcastToConversation(conversationId, 'done', { conversationId });
  }

  /**
   * Emits the terminal cancellation event. Should only be called after the
   * loop is completely stopped (ConversationManager._finalizeCancel),
   * so the UI unlocks only when everything has finished.
   */
  broadcastStreamCancelled(conversationId, reason = 'cancelled_by_user') {
    this.broadcastToConversation(conversationId, 'stream_cancelled', {
      conversationId,
      reason
    });
  }

  broadcastStreamError(conversationId, error) {
    this.broadcastToConversation(conversationId, 'error', {
      conversationId,
      error: error
    });
  }

  broadcastStreamFinish(conversationId, data) {
    this.broadcastToConversation(conversationId, 'finish', { conversationId, ...data });
  }

  /**
   * Sets the status of a conversation (ai-status event).
   * Equivalent to the old messageController.setConversationStatus.
   * @param {number} conversationId
   * @param {string} status
   */
  setConversationStatus(conversationId, status) {
    this.broadcastToConversation(conversationId, 'ai-status', {
      conversationId,
      status
    });
  }
}

module.exports = new SocketService();
