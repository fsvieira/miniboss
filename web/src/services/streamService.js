import socketService from '../socketService';

class StreamService {
  constructor() {
    this.activeStreams = new Map();
  }

  async streamMessage(conversationId, message, callbacks = {}) {
    const streamId = `${conversationId}-${Date.now()}`;

    // Cancel any existing stream for this conversation
    this.cancelStream(conversationId);

    const abortController = new AbortController();
    this.activeStreams.set(conversationId, { streamId, abortController });

    let cleaned = false;
    let abortTimer = null;
    const eventHandlers = {};

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (abortTimer) {
        clearTimeout(abortTimer);
        abortTimer = null;
      }
      Object.keys(eventHandlers).forEach(event => {
        socketService.off(event, eventHandlers[event]);
      });
    };

    try {
      console.log(`[STREAM] Sending user message via WebSocket (conv=${conversationId}, role=${message?.role})`);

      // Ensure we're joined to the conversation room
      socketService.joinConversation(conversationId);

      // Set up WebSocket event listeners
      const matchesConversation = (data) => {
        if (!data || data.conversationId === undefined || data.conversationId === null) {
          return true;
        }
        return String(data.conversationId) === String(conversationId);
      };

      eventHandlers.text = (data) => {
        if (abortController.signal.aborted || !matchesConversation(data)) return;
        callbacks.onText?.(data.content);
      };

      eventHandlers.tool_start = (data) => {
        if (abortController.signal.aborted || !matchesConversation(data)) return;
        callbacks.onToolStart?.(data.tool, data.args, data.approval_pending, data.tool_call_id);
      };

      eventHandlers.tool_end = (data) => {
        if (abortController.signal.aborted || !matchesConversation(data)) return;
        callbacks.onToolEnd?.(data.tool, data.result);
      };

      eventHandlers.checkpoint = (data) => {
        if (abortController.signal.aborted || !matchesConversation(data)) return;
        callbacks.onCheckpoint?.(data);
      };

      eventHandlers.checkpoint_complete = (data) => {
        if (abortController.signal.aborted || !matchesConversation(data)) return;
        callbacks.onCheckpointComplete?.(data);
      };

      eventHandlers.message = (data) => {
        if (abortController.signal.aborted || !matchesConversation(data)) return;
        callbacks.onMessage?.(data);
      };

      eventHandlers.command_approval_required = (data) => {
        if (abortController.signal.aborted || !matchesConversation(data)) return;
        callbacks.onCommandApprovalRequired?.(data);
      };

      // Terminal events. Even after abort, we continue listening to them: the UI only
      // desbloqueia quando o servidor confirma que o loop parou por completo.
      eventHandlers.done = (data) => {
        if (!matchesConversation(data)) return;
        if (abortTimer) clearTimeout(abortTimer);
        this.activeStreams.delete(conversationId);
        cleanup();
        callbacks.onDone?.(data);
      };

      eventHandlers.finish = (data) => {
        if (!matchesConversation(data)) return;
        if (abortTimer) clearTimeout(abortTimer);
        this.activeStreams.delete(conversationId);
        cleanup();
        callbacks.onFinish?.(data);
      };

      eventHandlers.error = (data) => {
        if (!matchesConversation(data)) return;
        if (abortTimer) clearTimeout(abortTimer);
        this.activeStreams.delete(conversationId);
        cleanup();
        if (abortController.signal.aborted) {
          // Error after cancellation → we treat it as normal completion.
          callbacks.onDone?.(data);
        } else {
          callbacks.onError?.(data.error || data.message);
        }
      };

      // Register event listeners
      Object.keys(eventHandlers).forEach(event => {
        socketService.on(event, eventHandlers[event]);
      });

      // Start streaming by sending message via WebSocket
      callbacks.onStart?.();

      socketService.emitToServer('send_message', {
        conversationId,
        message
      });

      // Handle abort signal
      abortController.signal.addEventListener('abort', () => {
        console.log(`[STREAM] Aborting stream for conversation ${conversationId}`);
        socketService.emitToServer('cancel_stream', { conversationId });
        this.activeStreams.delete(conversationId);

        // We remove ONLY the incremental event listeners. We keep
        // done/finish/error para que a UI desbloqueie quando o servidor
        // confirmar que o loop parou por completo (stream_cancelled/done).
        ['text', 'tool_start', 'tool_end', 'checkpoint', 'checkpoint_complete', 'message', 'command_approval_required'].forEach(event => {
          socketService.off(event, eventHandlers[event]);
        });

        // Safety timeout: if the server never confirms the stop,
        // we force cleanup to not leave the UI blocked forever.
        abortTimer = setTimeout(() => {
          console.log(`[STREAM] Safety timeout after cancel for conversation ${conversationId}; forcing cleanup.`);
          this.activeStreams.delete(conversationId);
          cleanup();
          callbacks.onDone?.();
        }, 15000);
      });

      // Return a promise that never resolves (streaming continues until done/error/finish)
      return new Promise(() => {}); // This will be resolved by the event handlers

    } catch (error) {
      this.activeStreams.delete(conversationId);
      cleanup();
      callbacks.onError?.(error);
    }
  }

  cancelStream(conversationId) {
    const stream = this.activeStreams.get(conversationId);
    if (stream) {
      stream.abortController.abort();
      this.activeStreams.delete(conversationId);
    }
  }

  cancelAllStreams() {
    for (const [conversationId, stream] of this.activeStreams) {
      stream.abortController.abort();
    }
    this.activeStreams.clear();
  }
}

export default new StreamService();
