'use strict';

const { ProtocolInterface } = require('../interface');

/**
 * Chat Protocol — Protocol for 'chat' conversations.
 *
 * Phases:
 *   idle    → waiting for user message
 *   active  → AI is processing, tools available
 *   stopped → cycle completed (no tools)
 *   error   → failed irrecoverably
 *
 * Transitions:
 *   idle ──(user_message)──► active
 *   active ──(tools_executed)──► active (continues)
 *   active ──(no_tools)──► stopped
 *   active ──(error)──► error
 *   error ──(retry)──► active
 */
class ChatProtocol extends ProtocolInterface {
  constructor({ conversationId, initialState = 'idle' }) {
    super();
    this._conversationId = conversationId;
    this._state = initialState;
  }

  get name() { return 'chat'; }
  get initialState() { return 'idle'; }
  get state() { return this._state; }
  get conversationId() { return this._conversationId; }

  /**
   * Tools available in each phase.
   * In chat, all tools are available during active.
   */
  getTools(phase) {
    switch (phase) {
      case 'active':
         // All execution tools
        return [
          'readFile', 'writeFile', 'editFile', 'listDirectory', 'getFileTree',
          'searchFiles', 'searchInFiles', 'grepInFile', 'semanticSearch',
          'readFileChunk', 'readFileLines', 'readMultipleFiles', 'getFileInfo',
          'copyFile', 'runCommand',
          'createTask', 'updateTask', 'deleteTask', 'reorderTasks',
        ];
      case 'idle':
      case 'stopped':
      case 'error':
      default:
        return [];
    }
  }

  async handleEvent(event, context = {}) {
    switch (this._state) {
      case 'idle': {
        if (event === 'user_message') {
          this._state = 'active';
          return {
            setProcessingState: 'queued',
            nextPhase: 'active',
            reason: 'user_message_received',
          };
        }
        // idle com outros eventos: ignorar
        return {
          setProcessingState: 'idle',
          nextPhase: 'idle',
          reason: `ignored_event_${event}_in_idle`,
        };
      }

      case 'active': {
        if (event === 'no_tools') {
          this._state = 'stopped';
          return {
            setProcessingState: 'stopped',
            nextPhase: 'stopped',
            reason: 'ai_responded_without_tools',
          };
        }

        if (event === 'tools_executed') {
          const maxIterations = context.maxIterations ?? 20;
          if (maxIterations > 0) {
            // Continuar ciclo
            return {
              setProcessingState: 'queued',
              nextPhase: 'active',
              reason: 'tools_executed_continue',
            };
          } else {
            // Iterations exhausted
            this._state = 'stopped';
            return {
              setProcessingState: 'stopped',
              nextPhase: 'stopped',
              reason: 'max_iterations_exhausted',
            };
          }
        }

        if (event === 'error') {
          this._state = 'error';
          const retryable = context.retryable !== false;
          if (retryable) {
            return {
              setProcessingState: 'queued',
              nextPhase: 'error',
              scheduleRetryMs: context.retryAfterMs || 30000,
              reason: `error_retry: ${context.error?.message || 'unknown'}`,
            };
          }
          return {
            setProcessingState: 'error',
            nextPhase: 'error',
            reason: `error_fatal: ${context.error?.message || 'unknown'}`,
          };
        }

        // Evento desconhecido em active
        return {
          setProcessingState: 'queued',
          nextPhase: 'active',
          reason: `unknown_event_${event}`,
        };
      }

      case 'stopped': {
        // Se receber uma nova user message, reativar
        if (event === 'user_message') {
          this._state = 'active';
          return {
            setProcessingState: 'queued',
            nextPhase: 'active',
            reason: 'new_user_message',
          };
        }
        // Otherwise, keep stopped
        return {
          setProcessingState: 'stopped',
          nextPhase: 'stopped',
          reason: 'already_stopped',
        };
      }

      case 'error': {
        if (event === 'user_message') {
          this._state = 'active';
          return {
            setProcessingState: 'queued',
            nextPhase: 'active',
            reason: 'retry_after_error',
          };
        }
        return {
          setProcessingState: 'error',
          nextPhase: 'error',
          reason: 'still_in_error',
        };
      }

      default:
        return {
          setProcessingState: 'error',
          nextPhase: 'error',
          reason: `unknown_state_${this._state}`,
        };
    }
  }

  serialize() {
    return {
      conversationId: this._conversationId,
      state: this._state,
      type: 'ChatProtocol',
    };
  }

  static fromPersisted(persisted) {
    const validStates = ['idle', 'active', 'stopped', 'error'];
    const state = validStates.includes(persisted?.state) ? persisted.state : 'idle';
    return new ChatProtocol({
      conversationId: persisted.conversationId,
      initialState: state,
    });
  }
}

module.exports = { ChatProtocol };