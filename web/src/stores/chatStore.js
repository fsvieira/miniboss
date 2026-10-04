import { makeAutoObservable, observable, runInAction } from 'mobx';
import conversationService from '../services/conversationService';
import streamService from '../services/streamService';
import socketService from '../socketService';

function createConversationState() {
  return observable({
    messages: [],
    contextInfo: null,
    isLoading: false,
    streamingMessage: '',
    toolIndicators: [],
    aiStatus: 'idle',
    hasLoaded: false,
    isLoadingConversation: false,
    hasUnread: false,
  });
}

class ChatStore {
  conversationStates = observable.map();
  streamTokens = new Map();
  initialized = false;
  activeConversationId = null;

  // Focus view stack for breadcrumb navigation
  focusViewStack = []; // [{ id, type: 'main', title } | { id, type: 'focus', title, goal }]

  // Focus state per conversation
  focusStates = observable.map(); // { focusId: { status: 'running'|'completed'|'partial', report: null|object } }

  emptyState = {
    messages: [],
    contextInfo: null,
    isLoading: false,
    streamingMessage: '',
    toolIndicators: [],
    aiStatus: 'idle',
    hasLoaded: false,
    isLoadingConversation: false,
    hasUnread: false,
  };

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  initialize() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    socketService.connect();
    socketService.on('message', this.handleIncomingMessage);
    socketService.on('ai-status', this.handleAiStatus);
    socketService.on('context_info', this.handleContextInfo);
    socketService.on('focus_started', this.handleFocusStarted);
    socketService.on('focus_report', this.handleFocusReport);
    socketService.on('focus_status_change', this.handleFocusStatusChange);
    socketService.on('focus_closed', this.handleFocusClosed);
    socketService.on('stream_cancelled', this.handleStreamCancelled);
    socketService.on('conversation_state', this.handleConversationState);
  }

  ensureConversationState(conversationId) {
    if (!conversationId) {
      return this.emptyState;
    }

    if (!this.conversationStates.has(conversationId)) {
      this.conversationStates.set(conversationId, createConversationState());
    }

    return this.conversationStates.get(conversationId);
  }

  getConversationState(conversationId) {
    return this.ensureConversationState(conversationId);
  }

  get aiGeneratingConversationIds() {
    const ids = new Set();

    for (const [conversationId, state] of this.conversationStates.entries()) {
      if (state.isLoading || state.aiStatus === 'generating') {
        ids.add(conversationId);
      }
    }

    return ids;
  }

  get unreadConversationIds() {
    const ids = new Set();

    for (const [conversationId, state] of this.conversationStates.entries()) {
      if (state.hasUnread) {
        ids.add(conversationId);
      }
    }

    return ids;
  }

  get conversationStatusById() {
    const map = {};
    for (const [conversationId, state] of this.conversationStates.entries()) {
      if (state.conversationState?.status) {
        map[conversationId] = state.conversationState.status;
      }
    }
    return map;
  }

  setActiveConversation(conversationId) {
    this.activeConversationId = conversationId;

    // Marca como lida a conversa que acabou de ser aberta
    if (conversationId) {
      this._markAsRead(conversationId);
    }
  }

  _markAsRead(conversationId) {
    const state = this.ensureConversationState(conversationId);
    runInAction(() => {
      state.hasUnread = false;
    });
  }

  observeConversation(conversationId) {
    if (!conversationId) {
      return;
    }

    this.ensureConversationState(conversationId);
    socketService.joinConversation(conversationId);
  }

  observeConversations(conversations = []) {
    conversations.forEach((conversation) => {
      this.observeConversation(conversation.id);
    });
  }

  async loadConversation(conversationId) {
    if (!conversationId) {
      return;
    }

    const state = this.ensureConversationState(conversationId);

    runInAction(() => {
      state.isLoadingConversation = true;
    });

    const { messages, contextInfo } = await conversationService.loadMessages(conversationId);

    runInAction(() => {
      state.messages = messages;
      state.contextInfo = contextInfo;
      state.toolIndicators = [];
      state.hasLoaded = true;
      state.isLoadingConversation = false;
      // Mark as read when the user opens the conversation
      state.hasUnread = false;
    });
  }

  async reloadContextInfo(conversationId) {
    if (!conversationId) {
      return null;
    }

    const state = this.ensureConversationState(conversationId);
    const contextInfo = await conversationService.reloadContextInfo(conversationId);

    runInAction(() => {
      state.contextInfo = contextInfo;
    });

    return contextInfo;
  }

  updateContextInfo(conversationId, contextInfoData) {
    if (!conversationId || !contextInfoData) return;

    const state = this.ensureConversationState(conversationId);
    runInAction(() => {
      state.contextInfo = contextInfoData;
    });
  }

  /**
   * Find the index of the last tool message in the array.
   * Returns -1 if no tool messages exist.
   */
  _lastToolIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Find the correct insertion index for a message based on its timestamp.
   * Returns the index where the message should be inserted to maintain chronological order.
   */
  _getInsertIndexByTime(messages, message) {
    if (!message.created_at) {
      return -1; // Append to end if no timestamp
    }
    const messageTime = new Date(message.created_at).getTime();
    return messages.findIndex((m) => {
      if (!m.created_at) return false;
      return new Date(m.created_at).getTime() > messageTime;
    });
  }

  handleIncomingMessage(message) {
    const conversationId = message.conversation_id;
    if (!conversationId) {
      return;
    }

    const state = this.ensureConversationState(conversationId);
    const existingIndex = state.messages.findIndex((item) => item.id === message.id);

    runInAction(() => {
      if (existingIndex >= 0) {
        // Replace existing message (e.g., update metadata)
        state.messages[existingIndex] = message;
        return;
      }

      // Simple and robust: append and re-sort by created_at + id
      state.messages.push(message);
      state.messages.sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : Infinity;
        const tb = b.created_at ? new Date(b.created_at).getTime() : Infinity;
        if (ta !== tb) return ta - tb;

        // Tie-break by id, mirroring the ORDER BY created_at, id from the DB
        // so the live order matches the refresh.
        const na = Number(a.id);
        const nb = Number(b.id);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a.id ?? '').localeCompare(String(b.id ?? ''));
      });

      // Mark as unread: message came via socket and is not from the active conversation
      if (message.conversation_id !== this.activeConversationId) {
        state.hasUnread = true;
      }

      // When a tool message arrives with a final status (processed/error/completed),
      // remove any matching tool indicator that was used for live streaming UI.
      // This must run for ALL messages (new and updates): it's the status updates
      // (processing -> processed/error) that signal the end of the tool.
      if (message.role === 'tool' && message.tool_call_id) {
        const finalStates = ['processed', 'completed', 'error'];
        if (finalStates.includes(message.status)) {
          state.toolIndicators = state.toolIndicators.filter(
            t => t.toolCallId !== message.tool_call_id
          );
          state.isLoading = false;
          state.streamingMessage = '';
        }
      }
    });

    // Update AI thinking status from server signal (fonte de verdade)
    if (message.thinking_status) {
      runInAction(() => {
        const isThinking = message.thinking_status === 'thinking';
        state.aiStatus = isThinking ? 'generating' : 'idle';
        state.isLoading = isThinking;
      });
    }

    this.reloadContextInfo(conversationId);
  }

  handleAiStatus(status) {
    const conversationId = status?.conversationId;
    if (!conversationId) {
      return;
    }

    const state = this.ensureConversationState(conversationId);

    runInAction(() => {
      state.aiStatus = status.status || 'idle';
      if (status.conversationStatus) {
        state.conversationState = state.conversationState || {};
        state.conversationState.status = status.conversationStatus;
      }

      // Estados activos: mostrar "thinking" na UI.
      // 'cancelling' also keeps the UI blocked (it is the stop state).
      const activeStates = ['queued', 'sending', 'ai_processing', 'tool_exec', 'tool_results', 'cancelling'];
      if (activeStates.includes(state.aiStatus)) {
        state.isLoading = true;
      }

      // Estados terminais: limpar loading
      if (state.aiStatus === 'idle' || state.aiStatus === 'stopped' || state.aiStatus === 'error') {
        state.isLoading = false;
      }
    });
  }

  handleContextInfo = (data) => {
    if (!data) return;

    const conversationId = data.conversationId;
    if (!conversationId) {
      // Fallback: try to find any loaded conversation state and update it
      // (useful if conversationId is missing from payload)
      for (const [id, state] of this.conversationStates) {
        if (state.hasLoaded) {
          runInAction(() => {
            state.contextInfo = data;
          });
          return;
        }
      }
      return;
    }

    const state = this.ensureConversationState(conversationId);
    runInAction(() => {
      state.contextInfo = data;
    });
  };

  handleConversationState = (data) => {
    if (!data) return;
    const { conversationId, phase, command, retryAfterMs, retryable, reason, camada1, conversationType, status, processingState } = data;
    if (!conversationId) return;

    const state = this.ensureConversationState(conversationId);

    runInAction(() => {
      state.conversationState = state.conversationState || {};
      state.conversationState.phase = phase;
      state.conversationState.processingState = processingState || state.conversationState.processingState;
      state.conversationState.command = command;
      state.conversationState.retryAfterMs = retryAfterMs;
      state.conversationState.retryable = retryable;
      state.conversationState.reason = reason;
      state.conversationState.camada1 = camada1;
      state.conversationState.conversationType = conversationType;
      state.conversationState.updatedAt = new Date().toISOString();

      // Single authoritative state coming from the server (Phase E)
      if (status) {
        state.conversationState.status = status;
      } else if (!state.conversationState.status) {
        // Fallback defensivo para payloads antigos sem `status`
        const fallback = ['error', 'cancelled'].includes(phase) ? 'error'
          : ['completed', 'report_sent', 'stopped', 'idle'].includes(phase) ? 'completed'
          : 'running';
        state.conversationState.status = fallback;
      }

      const authoritativeStatus = state.conversationState.status || 'completed';
      if (authoritativeStatus === 'running' || authoritativeStatus === 'waiting') {
        state.aiStatus = 'generating';
        state.isLoading = true;
      } else {
        state.aiStatus = 'idle';
        state.isLoading = false;
      }
    });
  };

  // ===== FOCUS SYSTEM =====

  handleFocusStarted = (data) => {
    if (!data?.focusId) return;
    
    runInAction(() => {
      this.focusStates.set(data.focusId, {
        status: 'running',
        goal: data.goal,
        title: data.title,
        parentConversationId: data.parentConversationId,
        report: null
      });
    });
  };

  handleFocusReport = (data) => {
    if (!data?.focusId) return;
    
    runInAction(() => {
      let report = null;
      if (data.report) {
        try {
          report = typeof data.report === 'string' ? JSON.parse(data.report) : data.report;
        } catch {
          report = data.report;
        }
      }
      
      this.focusStates.set(data.focusId, {
        status: data.status || 'completed',
        goal: data.title || '',
        title: data.title || '',
        parentConversationId: data.parentConversationId,
        report
      });
    });
  };

  handleFocusStatusChange = (data) => {
    if (!data?.focusId) return;
    
    runInAction(() => {
      let report = null;
      if (data.report) {
        try {
          report = typeof data.report === 'string' ? JSON.parse(data.report) : data.report;
        } catch {
          report = data.report;
        }
      }
      
      this.focusStates.set(data.focusId, {
        status: data.status || 'completed',
        title: data.title || '',
        parentConversationId: data.parentConversationId,
        report
      });
    });
  };

  handleFocusClosed = (data) => {
    if (!data?.focusId) return;

    runInAction(() => {
      let report = null;
      if (data.report) {
        try {
          report = typeof data.report === 'string' ? JSON.parse(data.report) : data.report;
        } catch {
          report = data.report;
        }
      }

      const previous = this.focusStates.get(data.focusId) || {};
      this.focusStates.set(data.focusId, {
        ...previous,
        status: data.status || 'completed',
        title: data.title || previous.title || '',
        parentConversationId: data.parentConversationId || previous.parentConversationId,
        report
      });

      const currentView = this.currentFocusView;
      if (currentView?.id === data.focusId) {
        this.popFocusView();
      } else {
        const index = this.focusViewStack.findIndex(entry => entry.id === data.focusId);
        if (index !== -1) {
          this.focusViewStack.splice(index, 1);
          this.focusViewStack = [...this.focusViewStack];
        }
      }
    });
  };

  handleStreamCancelled = (data) => {
    if (!data?.conversationId) return;
    
    runInAction(() => {
      // Clear focus view if the cancelled conversation was in focus view
      if (this.isFocusView && this.currentFocusView?.parentConversationId === data.conversationId) {
        this.clearFocusView();
      }
      
      // Update AI status for the conversation
      const state = this.ensureConversationState(data.conversationId);
      state.aiStatus = 'idle';
      state.isLoading = false;
      state.streamingMessage = '';
      state.toolIndicators = [];
      
      // Mark any running focuses for this conversation as cancelled.
      // Also mark the focus itself cancelled when the cancelled conversation is the focus conversation.
      for (const [focusId, focusState] of this.focusStates) {
        if (focusState.status === 'running' && (focusState.parentConversationId === data.conversationId || focusId === data.conversationId)) {
          this.focusStates.set(focusId, {
            ...focusState,
            status: 'cancelled',
            report: { summary: 'Cancelled by user', completed: false }
          });
        }
      }
    });
  };

  getFocusState(focusId) {
    return this.focusStates.get(focusId) || null;
  }

  hasRunningFocus(conversationId) {
    if (!conversationId) return false;
    for (const [, state] of this.focusStates) {
      if (state.status === 'running' && state.parentConversationId === conversationId) {
        return true;
      }
    }
    return false;
  }

  // Focus view stack management
  pushFocusView(entry) {
    runInAction(() => {
      this.focusViewStack = [...this.focusViewStack, entry];
    });
  }

  popFocusView() {
    let popped = null;
    runInAction(() => {
      popped = this.focusViewStack.pop();
      this.focusViewStack = [...this.focusViewStack];
    });
    return popped;
  }

  get isFocusView() {
    return this.focusViewStack.length > 0;
  }

  get currentFocusView() {
    if (this.focusViewStack.length === 0) return null;
    return this.focusViewStack[this.focusViewStack.length - 1];
  }

  clearFocusView() {
    runInAction(() => {
      this.focusViewStack = [];
    });
  }

  /**
   * Remove o estado local de uma conversa (e de todos os seus focus descendentes),
   * used when the conversation is deleted.
   */
  cleanupConversationState(conversationId) {
    if (!conversationId) return;
    runInAction(() => {
      this.conversationStates.delete(conversationId);
      for (const [focusId, focusState] of this.focusStates) {
        if (focusId === conversationId || focusState.parentConversationId === conversationId) {
          this.focusStates.delete(focusId);
        }
      }
      this.focusViewStack = this.focusViewStack.filter(entry => entry.id !== conversationId);
    });
  }

  // ===== END FOCUS SYSTEM =====

  async streamConversationMessage(conversationId, message, callbacks = {}) {
    if (!conversationId) {
      return;
    }

    const state = this.ensureConversationState(conversationId);
    if (state.isLoading) {
      return;
    }

    const token = (this.streamTokens.get(conversationId) || 0) + 1;
    this.streamTokens.set(conversationId, token);

    this.observeConversation(conversationId);

    runInAction(() => {
      state.isLoading = true;
      state.streamingMessage = '';
      state.toolIndicators = [];
    });

    const isActiveToken = () => this.streamTokens.get(conversationId) === token;

    try {
      await streamService.streamMessage(conversationId, message, {
        onStart: () => {
          if (!isActiveToken()) {
            return;
          }

          runInAction(() => {
            state.isLoading = true;
          });

          callbacks.onStart?.();
        },
        onText: (text) => {
          if (!isActiveToken()) {
            return;
          }

          runInAction(() => {
            state.streamingMessage += text;
          });

          callbacks.onText?.(text);
        },
        onCheckpoint: (data) => {
          if (!isActiveToken()) {
            return;
          }

          callbacks.onCheckpoint?.(data);
        },
        onCheckpointComplete: (data) => {
          if (!isActiveToken()) {
            return;
          }

          callbacks.onCheckpointComplete?.(data);
        },

        onContextInfo: (data) => {
          if (!isActiveToken()) {
            return;
          }
          runInAction(() => {
            state.contextInfo = data;
          });
        },
        onToolStart: (toolName, args, toolCallId) => {
          if (!isActiveToken()) {
            return;
          }

          console.log('Adding tool indicator', { toolName, toolCallId, conversationId });
           runInAction(() => {
             const id = `tool_${Date.now()}_${state.toolIndicators.length}`;
             state.toolIndicators.push({
               id,
               name: toolName,
               args,
               result: 'Running...',
               toolCallId,
               conversationId
             });
           });

          callbacks.onToolStart?.(toolName, args, toolCallId);
        },
        onToolEnd: (toolName, result) => {
          if (!isActiveToken()) {
            return;
          }

          runInAction(() => {
            const lastTool = [...state.toolIndicators]
              .reverse()
              .find((tool) => tool.name === toolName && tool.result === 'Running...');

            if (lastTool) {
              lastTool.result = result;
              // For investigate, capture focusId so the UI can render a FocusCard while running
              if (toolName === 'investigate' && result) {
                try {
                  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
                  if (parsed.focusId) {
                    lastTool.focusId = parsed.focusId;
                  }
                } catch (_) {}
              }
              return;
            }

            const id = `tool_${Date.now()}_${state.toolIndicators.length}`;
            state.toolIndicators.push({ id, name: toolName, args: null, result });
          });

          callbacks.onToolEnd?.(toolName, result);
        },
        onFinish: (finishData) => {
          if (!isActiveToken()) {
            return;
          }

          runInAction(() => {
            state.isLoading = false;
            state.streamingMessage = '';

            // Tool indicators are NOT converted to messages here.
            // The server broadcasts tool messages via socket (handleIncomingMessage)
            // which handles replace in-place by message ID.
            // Tool indicators are only for in-flight UI feedback during streaming.

            // Safety net: descartar indicators já terminados que tenham ficado por limpar
            // (ex: broadcast perdido). Os tool indicators são só feedback in-flight;
            // as mensagens reais chegan via socket (message role='tool').
            state.toolIndicators = [];

            // Create a message from finish events (content_filter, empty_content, etc.)
            const finishMessage = finishData?.content || '';
            if (finishMessage) {
              state.messages.push({
                id: `finish-${Date.now()}`,
                role: 'assistant',
                content: finishMessage,
                isFinish: true,
                finishReason: finishData?.reason,
                created_at: new Date().toISOString()
              });
            }
          });

          callbacks.onFinish?.(finishData);
          callbacks.onDone?.();
        },
        onDone: () => {
          if (!isActiveToken()) {
            return;
          }

          runInAction(() => {
            state.isLoading = false;
            state.streamingMessage = '';

            // Safety net idêntico ao de onFinish: nunca deixar indicators de tools
            // já terminadas na base da lista de mensagens.
            state.toolIndicators = [];
          });

          callbacks.onDone?.();
        },
        onError: (error) => {
          if (!isActiveToken()) {
            return;
          }

          runInAction(() => {
            state.isLoading = false;
            state.streamingMessage = '';

            // Add error message to the messages array so it appears in the UI
            const errorMessage = typeof error === 'string'
              ? error
              : (error?.message || 'An error occurred');

            // Create a synthetic error message entry
            state.messages.push({
              id: `error-${Date.now()}`,
              role: 'error',
              content: errorMessage,
              error_message: typeof error === 'object' ? JSON.stringify(error) : error,
              created_at: new Date().toISOString(),
              isError: true
            });
          });

          callbacks.onError?.(error);
        }
      });
    } catch (error) {
      if (isActiveToken()) {
        runInAction(() => {
          state.isLoading = false;
          state.streamingMessage = '';
        });
      }

      callbacks.onError?.(error);
    }
  }

  clearConversationTools(conversationId) {
    if (!conversationId) {
      return;
    }

    const state = this.ensureConversationState(conversationId);
    runInAction(() => {
      state.toolIndicators = [];
    });
  }

  cancelConversationStream(conversationId) {
    if (!conversationId) {
      return;
    }

    streamService.cancelStream(conversationId);
    this.streamTokens.set(conversationId, (this.streamTokens.get(conversationId) || 0) + 1);

    const state = this.ensureConversationState(conversationId);
    runInAction(() => {
      // DO NOT unlock here: we keep 'cancelling' until the server
      // confirms the full stop of the loop (stream_cancelled/done). We only clear
      // the incremental text/tools that are no longer reliable.
      state.aiStatus = 'cancelling';
      state.isLoading = true;
      state.streamingMessage = '';
      state.toolIndicators = [];
    });
  }
}

const chatStore = new ChatStore();

export default chatStore;
