'use strict';

const { StateMachine } = require('../stateMachine');
const { FOCUS_PHASE, FOCUS_EVENT, FOCUS_TOOL_SETS } = require('../../../constants/focusProtocol');
const logger = require('../../../utils/logger');
const { stateLogger } = logger;

/**
 * Focus Protocol — State machine for "focus" conversations.
 *
 * States:
 *   INITIAL   → Just created, before the first AI response.
 *   ACTIVE    → AI is working, all tools available.
 *   FINALIZING → AI stopped (text without tools, error, or iteration limit).
 *               Only submitFindings is available.
 *   REPORT_SENT → Report was sent to the parent. Focus complete.
 *   COMPLETED  → Terminal state. No tools available.
 *
 * Transitions:
 *   INITIAL ──► ACTIVE       (ai_called)
 *   ACTIVE  ──► ACTIVE       (ai_responded_with_tools — continues working)
 *   ACTIVE  ──► REPORT_SENT  (ai_responded_with_report — submitFindings called)
 *   ACTIVE  ──► FINALIZING   (ai_responded_text_only / iteration_exhausted / error)
 *   FINALIZING ► REPORT_SENT (ai_responded_with_report / error / cancelled)
 *   FINALIZING ► COMPLETED   (ai_responded_text_only — auto-report generated)
 *   REPORT_SENT ► COMPLETED  (transition_on_report_delivered)
 */
class FocusProtocol extends StateMachine {
  /**
   * @param {Object} options
   * @param {string} options.conversationId
   * @param {string} [options.initialState=FOCUS_PHASE.INITIAL]
   */
  constructor({ conversationId, initialState = FOCUS_PHASE.INITIAL }) {
    super({ initialState, conversationId });

    this._configureTransitions();
    this._configureToolSets();
    this._configureTerminalStates();
    this._configureHooks();
    if (this.state === FOCUS_PHASE.INITIAL) {
      stateLogger.stateTransition(FOCUS_PHASE.INITIAL, FOCUS_PHASE.INITIAL, { focusId: this._conversationId });
      stateLogger.focusCreated(this._conversationId);
    }
  }

  _configureHooks() {
    // On entering FINALIZING, mark focus_goal.finalizing = true (for systemPromptBuilder)
    this.onEnter(FOCUS_PHASE.FINALIZING, async ({ context }) => {
      stateLogger.focusFinalizing(this._conversationId);
      const { db } = context;
      if (!db) return;
      try {
        const conv = db.getConversation(this._conversationId);
        if (!conv) return;
        let goal = {};
        try { goal = JSON.parse(conv.focus_goal || '{}'); } catch (_) {}
        goal.finalizing = true;
        goal.finalizingAt = new Date().toISOString();
        db.updateFocusGoal(this._conversationId, JSON.stringify(goal));
      } catch (_) {}
    });

    // On entering REPORT_SENT, clear finalizing and mark finalizedAt
    this.onEnter(FOCUS_PHASE.REPORT_SENT, async ({ context }) => {
      stateLogger.stateTransition(FOCUS_PHASE.FINALIZING, FOCUS_PHASE.REPORT_SENT, { focusId: this._conversationId });
      const { db } = context;
      if (!db) return;
      try {
        const conv = db.getConversation(this._conversationId);
        if (!conv) return;
        let goal = {};
        try { goal = JSON.parse(conv.focus_goal || '{}'); } catch (_) {}
        goal.finalizing = false;
        goal.finalizedAt = new Date().toISOString();
        goal.completed = true;
        db.updateFocusGoal(this._conversationId, JSON.stringify(goal));
      } catch (_) {}
    });

    // On entering COMPLETED, clear active_focus_id on parent
    this.onEnter(FOCUS_PHASE.COMPLETED, async ({ context }) => {
      stateLogger.stateTransition(FOCUS_PHASE.REPORT_SENT, FOCUS_PHASE.COMPLETED, { focusId: this._conversationId });
      const { db } = context;
      if (!db) return;
      try {
        db.clearActiveFocus(this._conversationId);
      } catch (_) {}
    });
  }

  _configureTransitions() {
    // INITIAL → ACTIVE (first AI call)
    this.addTransition(FOCUS_PHASE.INITIAL, FOCUS_EVENT.AI_CALLED, FOCUS_PHASE.ACTIVE);

    // INITIAL/ACTIVE → ACTIVE (AI continues making tool calls, without submitFindings)
    this.addTransition(FOCUS_PHASE.INITIAL, FOCUS_EVENT.AI_RESPONDED_WITH_TOOLS, FOCUS_PHASE.ACTIVE);
    this.addTransition(FOCUS_PHASE.ACTIVE, FOCUS_EVENT.AI_RESPONDED_WITH_TOOLS, FOCUS_PHASE.ACTIVE);

    // INITIAL/ACTIVE → REPORT_SENT (AI called submitFindings)
    this.addTransition(FOCUS_PHASE.INITIAL, FOCUS_EVENT.AI_RESPONDED_WITH_REPORT, FOCUS_PHASE.REPORT_SENT);
    this.addTransition(FOCUS_PHASE.ACTIVE, FOCUS_EVENT.AI_RESPONDED_WITH_REPORT, FOCUS_PHASE.REPORT_SENT);

    // INITIAL/ACTIVE → FINALIZING (AI stopped, error, or iteration limit)
    this.addTransition(FOCUS_PHASE.INITIAL, FOCUS_EVENT.AI_RESPONDED_TEXT_ONLY, FOCUS_PHASE.FINALIZING);
    this.addTransition(FOCUS_PHASE.INITIAL, FOCUS_EVENT.ITERATION_EXHAUSTED, FOCUS_PHASE.FINALIZING);
    this.addTransition(FOCUS_PHASE.INITIAL, FOCUS_EVENT.ERROR, FOCUS_PHASE.FINALIZING);
    this.addTransition(FOCUS_PHASE.ACTIVE, FOCUS_EVENT.AI_RESPONDED_TEXT_ONLY, FOCUS_PHASE.FINALIZING);
    this.addTransition(FOCUS_PHASE.ACTIVE, FOCUS_EVENT.ITERATION_EXHAUSTED, FOCUS_PHASE.FINALIZING);
    this.addTransition(FOCUS_PHASE.ACTIVE, FOCUS_EVENT.ERROR, FOCUS_PHASE.FINALIZING);
    this.addTransition(FOCUS_PHASE.ACTIVE, FOCUS_EVENT.CANCELLED, FOCUS_PHASE.FINALIZING);

    // FINALIZING → REPORT_SENT
    this.addTransition(FOCUS_PHASE.FINALIZING, FOCUS_EVENT.AI_RESPONDED_WITH_REPORT, FOCUS_PHASE.REPORT_SENT);
    this.addTransition(FOCUS_PHASE.FINALIZING, FOCUS_EVENT.ERROR, FOCUS_PHASE.REPORT_SENT);
    this.addTransition(FOCUS_PHASE.FINALIZING, FOCUS_EVENT.CANCELLED, FOCUS_PHASE.REPORT_SENT);

    // FINALIZING → COMPLETED (auto-report generated without AI)
    this.addTransition(FOCUS_PHASE.FINALIZING, FOCUS_EVENT.AI_RESPONDED_TEXT_ONLY, FOCUS_PHASE.COMPLETED);
    // FINALIZING → COMPLETED when AI violates report-only restriction or iteration is exhausted
    this.addTransition(FOCUS_PHASE.FINALIZING, FOCUS_EVENT.AI_RESPONDED_WITH_TOOLS, FOCUS_PHASE.COMPLETED);
    this.addTransition(FOCUS_PHASE.FINALIZING, FOCUS_EVENT.ITERATION_EXHAUSTED, FOCUS_PHASE.COMPLETED);

    // REPORT_SENT → COMPLETED
    this.addTransition(FOCUS_PHASE.REPORT_SENT, FOCUS_EVENT.AI_RESPONDED_TEXT_ONLY, FOCUS_PHASE.COMPLETED);

    // Fallback: any state with error goes to FINALIZING (if no specific transition)
    // NOTE: we already have ACTIVE→ERROR. For INITIAL, we keep it as is (no transition)
  }

  _configureToolSets() {
    for (const [state, tools] of Object.entries(FOCUS_TOOL_SETS)) {
      this.setToolSet(state, tools);
    }
  }

  _configureTerminalStates() {
    this.markTerminal(FOCUS_PHASE.COMPLETED);
  }

  // ========== STATIC HELPERS ==========

  /**
   * Determines which event to generate based on the AI response.
   *
   * @param {Object} aiResponse - AI response (with toolCalls, finishReason, etc.)
   * @param {number} maxIterations - Remaining iterations
   * @returns {string} One of FOCUS_EVENT
   */
  static classifyAIResponse(aiResponse, maxIterations) {
    const toolCalls = aiResponse?.toolCalls || aiResponse?.tool_calls || [];
    const finishReason = aiResponse?.finishReason || aiResponse?.finish_reason || '';

    // If there was an error
    if (finishReason === 'error' || aiResponse?.error) {
      return FOCUS_EVENT.ERROR;
    }

    // If it was cancelled
    if (finishReason === 'cancelled') {
      return FOCUS_EVENT.CANCELLED;
    }

    // Has tool_calls?
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const hasReportTool = toolCalls.some(
        tc => (tc.function?.name || tc.name) === 'submitFindings'
      );
      return hasReportTool
        ? FOCUS_EVENT.AI_RESPONDED_WITH_REPORT
        : FOCUS_EVENT.AI_RESPONDED_WITH_TOOLS;
    }

    // If iterations are exhausted and there was no report, request finalization phase.
    if (maxIterations === 0) {
      return FOCUS_EVENT.ITERATION_EXHAUSTED;
    }

    // Text only
    return FOCUS_EVENT.AI_RESPONDED_TEXT_ONLY;
  }

  /**
   * Creates an instance from persisted state.
   * @param {Object} persisted - { conversationId, state }
   * @returns {FocusProtocol}
   */
  static fromPersisted(persisted) {
    stateLogger.stateTransition(persisted?.state || FOCUS_PHASE.INITIAL, 'recovered', { focusId: persisted?.conversationId });
    const validStates = Object.values(FOCUS_PHASE);
    const state = validStates.includes(persisted?.state)
      ? persisted.state
      : FOCUS_PHASE.INITIAL;
    return new FocusProtocol({
      conversationId: persisted.conversationId,
      initialState: state,
    });
  }
}

module.exports = { FocusProtocol };
