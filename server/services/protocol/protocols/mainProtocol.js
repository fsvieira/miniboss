'use strict';

const { ProtocolInterface } = require('../interface');

/**
 * Main Protocol — Protocol for 'main' conversations (orchestrator).
 *
 * MAIN performs technical work and can create read-only investigations (investigate)
 * to resolve blocking uncertainties. It waits for reports from those sub-bots.
 *
 * Phases:
 *   idle    → waiting for user message or focus completion
 *   active  → MAIN is processing, can create investigations
 *   waiting_focus → MAIN created an investigation and is waiting for the report
 *   stopped → conversation completed
 *   error   → failed
 *
 * Transitions:
 *   idle ──(user_message)──► active
 *   active ──(investigate)──► waiting_focus
 *   active ──(no_tools)──► stopped
 *   waiting_focus ──(focus_report_received)──► active
 *   waiting_focus ──(focus_report_error)──► active (continues)
 *   active/waiting_focus ──(error)──► error
 */
class MainProtocol extends ProtocolInterface {
  constructor({ conversationId, initialState = 'idle' }) {
    super();
    this._conversationId = conversationId;
    this._state = initialState;
  }

  get name() { return 'main'; }
  get initialState() { return 'idle'; }
  get state() { return this._state; }
  get conversationId() { return this._conversationId; }

  /**
   * Tools available in each phase.
   * In MAIN, investigate is available during active (all other tools too).
   */
  getTools(phase) {
    switch (phase) {
      case 'active':
        return ['investigate'];
      case 'idle':
      case 'waiting_focus':
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
        return {
          setProcessingState: 'idle',
          nextPhase: 'idle',
          reason: `ignored_event_${event}_in_idle`,
        };
      }

      case 'active': {
        if (event === 'create_focus') {
          this._state = 'waiting_focus';
          return {
            setProcessingState: 'stopped', // MAIN para, foco executa
            nextPhase: 'waiting_focus',
            reason: 'create_focus_executed',
          };
        }

        if (event === 'no_tools') {
          this._state = 'stopped';
          return {
            setProcessingState: 'stopped',
            nextPhase: 'stopped',
            reason: 'ai_responded_without_tools',
          };
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

        return {
          setProcessingState: 'queued',
          nextPhase: 'active',
          reason: `unknown_event_${event}`,
        };
      }

      case 'waiting_focus': {
        if (event === 'focus_report_received') {
          this._state = 'active';
          return {
            setProcessingState: 'queued',
            nextPhase: 'active',
            reason: 'focus_report_received',
          };
        }

        if (event === 'focus_report_error') {
          this._state = 'active';
          return {
            setProcessingState: 'queued',
            nextPhase: 'active',
            reason: 'focus_report_error_continue',
          };
        }

        if (event === 'error') {
          this._state = 'error';
          return {
            setProcessingState: 'error',
            nextPhase: 'error',
            reason: `error_while_waiting_focus: ${context.error?.message || 'unknown'}`,
          };
        }

        // In waiting_focus, ignore other events (ex: user_message while focus is active)
        return {
          setProcessingState: 'stopped',
          nextPhase: 'waiting_focus',
          reason: `waiting_for_focus_report_ignored_${event}`,
        };
      }

      case 'stopped': {
        if (event === 'user_message') {
          this._state = 'active';
          return {
            setProcessingState: 'queued',
            nextPhase: 'active',
            reason: 'new_user_message',
          };
        }
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
      type: 'MainProtocol',
    };
  }

  static fromPersisted(persisted) {
    const validStates = ['idle', 'active', 'waiting_focus', 'stopped', 'error'];
    const state = validStates.includes(persisted?.state) ? persisted.state : 'idle';
    return new MainProtocol({
      conversationId: persisted.conversationId,
      initialState: state,
    });
  }
}

module.exports = { MainProtocol };