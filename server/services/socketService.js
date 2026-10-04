const serviceRegistry = require('./serviceFactory');

class SocketService {
  constructor() {
    this.io = null;
    this.aiController = null;
  }

  initialize(io) {
    this.io = io;
    this.setupConnectionHandlers();
  }

  setAIController(controller) {
    this.aiController = controller;
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
  broadcastToolStart(conversationId, toolName, args, toolCallId) {
    this.broadcastToConversation(conversationId, 'tool_start', {
      conversationId,
      tool: toolName,
      args: args,
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
