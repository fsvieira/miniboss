const { PROCESSING_STATES, MESSAGE_STATES } = require("../constants/processingStates.js");
const { computeConversationStatus } = require("./conversationStatus");

/**
 * Events that stateChange classifies from the message.
 */
const EVENTS = {
  USER_MESSAGE: 'user_message',
  AI_CALLED: 'ai_called',
  TOOLS_WITHOUT_REPORT: 'tools_without_report',
  TOOLS_WITH_REPORT: 'tools_with_report',
  TEXT_ONLY: 'text_only',
  ITERATION_EXHAUSTED: 'iteration_exhausted',
  ERROR: 'error',
  AUTO_REPORT: 'auto_report',
  TOOLS_COMPLETED: 'tools_completed',
};

/**
 * Transition table for FOCUS.
 *
 * finalizing_grace: When iterations run out, the AI gets ONE more chance
 * to submit a report (submitFindings). If it uses non-report tools or
 * returns text, it transitions to completed and an auto-report is generated.
 */
const FOCUS_TRANSITIONS = {
  'initial:ai_called':              { phase: 'active',     processing: 'queued',     hasTools: false },
  'initial:tools_without_report':   { phase: 'active',     processing: 'tool_exec',  hasTools: true },
  'initial:tools_with_report':      { phase: 'report_sent', processing: 'idle',      hasTools: true },
  'initial:text_only':              { phase: 'active',     processing: 'queued',     hasTools: false },
  'initial:iteration_exhausted':    { phase: 'finalizing', processing: 'queued',     hasTools: false },
  'initial:user_message':           { phase: 'active',     processing: 'queued',     hasTools: false },
  'initial:tools_completed':        { phase: 'active',     processing: 'queued',     hasTools: false },

  'idle:tools_without_report':      { phase: 'active',     processing: 'tool_exec',  hasTools: true },
  'idle:tools_with_report':         { phase: 'report_sent', processing: 'idle',      hasTools: true },
  'idle:ai_called':                 { phase: 'active',     processing: 'queued',     hasTools: false },
  'idle:text_only':                 { phase: 'finalizing', processing: 'queued',     hasTools: false },
  'idle:iteration_exhausted':       { phase: 'finalizing', processing: 'queued',     hasTools: false },
  'idle:error':                     { phase: 'finalizing', processing: 'queued',     hasTools: false },
  'idle:tools_completed':           { phase: 'active',     processing: 'queued',     hasTools: false },

  'active:tools_without_report':    { phase: 'active',     processing: 'tool_exec',  hasTools: true },
  'active:tools_with_report':       { phase: 'report_sent', processing: 'idle',      hasTools: true },
  'active:text_only':               { phase: 'active',     processing: 'queued',     hasTools: false },
  'active:iteration_exhausted':     { phase: 'finalizing', processing: 'queued',     hasTools: false },
  'active:error':                   { phase: 'finalizing', processing: 'queued',     hasTools: false },
  'active:tools_completed':         { phase: 'active',     processing: 'queued',     hasTools: false },

  // finalizing -> finalizing_grace: give AI ONE LAST chance to send report
  'finalizing:tools_with_report':   { phase: 'report_sent', processing: 'idle',      hasTools: true },
  'finalizing:text_only':           { phase: 'finalizing_grace', processing: 'queued', hasTools: false },
  'finalizing:tools_without_report':{ phase: 'finalizing_grace', processing: 'queued', hasTools: true },
  'finalizing:iteration_exhausted': { phase: 'finalizing_grace', processing: 'queued', hasTools: false },
  'finalizing:error':               { phase: 'finalizing_grace', processing: 'queued', hasTools: false },

  // finalizing_grace: AI's last chance. If it sends report -> report_sent.
  // If it does anything else -> completed (auto-report will be generated).
  'finalizing_grace:tools_with_report':   { phase: 'report_sent', processing: 'idle',      hasTools: true },
  'finalizing_grace:tools_without_report':{ phase: 'completed',   processing: 'idle',      hasTools: false },
  'finalizing_grace:text_only':           { phase: 'completed',   processing: 'idle',      hasTools: false },
  'finalizing_grace:ai_called':           { phase: 'completed',   processing: 'idle',      hasTools: false },
  'finalizing_grace:error':               { phase: 'completed',   processing: 'idle',      hasTools: false },
  'finalizing_grace:iteration_exhausted': { phase: 'completed',   processing: 'idle',      hasTools: false },
  'finalizing_grace:tools_completed':     { phase: 'finalizing_grace', processing: 'queued', hasTools: false },

  'report_sent:text_only':          { phase: 'completed',   processing: 'idle',      hasTools: false },
  'report_sent:tools_without_report':{ phase: 'completed',  processing: 'idle',      hasTools: false },
  'report_sent:user_message':       { phase: 'completed',   processing: 'idle',      hasTools: false },
  'report_sent:tools_completed':    { phase: 'completed',   processing: 'idle',      hasTools: false },
  'report_sent:tools_with_report':  { phase: 'completed',   processing: 'idle',      hasTools: false },

  'completed:user_message':         { phase: 'completed',   processing: 'idle',      hasTools: false },
  'completed:tools_with_report':    { phase: 'completed',   processing: 'idle',      hasTools: false },
};

class ConversationManager {
    constructor(db, socketService, toolProcessor, aiController = null) {
        this.db = db;
        this.socketService = socketService;
        this.toolProcessor = toolProcessor;
        this.aiController = aiController;
        this.toolProcessor.setConversationManager(this);
        this.running = false;
        this._scheduledTurnCount = 0;
        this._nudgeCounts = new Map();
    }

    getConversation(conversationId) {
        if (!conversationId) {
            throw new Error('No conversation id provided');
        }
        const conv = this.db.getConversation(conversationId);
        if (!conv) {
            throw new Error('Conversation not found');
        }
        return conv;
    }

    /**
     * Authoritative conversation state (Phase E): running | waiting | completed | error.
     * @param {Object} conv
     * @returns {string}
     */
    computeConversationStatus(conv) {
        return computeConversationStatus(conv, this.db);
    }

    /**
     * Creates pending tool messages for each tool call.
     */
    createTools(conversation, toolCalls) {
        const toolMessages = [];
        for (const toolCall of toolCalls) {
            const pendingMsg = this.db.createPendingToolMessage(conversation.id, toolCall);
            this.socketService.broadcastToConversation(conversation.id, 'message', pendingMsg);
            toolMessages.push(pendingMsg);
        }
        return toolMessages;
    }

    // =========================================================================
    // HANDLE TOOL RESULT (called by ToolProcessor)
    // =========================================================================

    /**
     * Emits a progress heartbeat for focus conversations and their parent.
     * Provides visibility (non-functional) to MAIN/UI about focus progress.
     */
    _emitFocusHeartbeat(conv, extra = {}) {
        if (!conv || conv.conversation_type !== 'focus') return;
        const payload = {
            focusId: conv.id,
            parentId: conv.parent_id || null,
            phase: conv.phase || 'active',
            maxIterations: conv.max_iterations,
            timestamp: new Date().toISOString(),
            ...extra,
        };
        this.socketService.broadcastFocusHeartbeat(conv.id, payload);
        if (conv.parent_id) {
            this.socketService.broadcastFocusHeartbeat(conv.parent_id, payload);
        }
    }

    /**
     * Receives the result of an executed tool, updates the DB, and broadcasts.
     *
     * 1. Updates the tool message in the DB (status + result)
     * 2. Broadcasts the updated message
     * 3. Checks if there are more pending tools in the conversation
     *    - YES: keeps 'tool_exec' (UI shows "processing tools")
     *    - NO: calls stateChange with TOOLS_COMPLETED to transition
     */
    handleToolResult(conversationId, toolMessageId, result, toolError = null) {
        const status = toolError ? 'error' : 'processed';
        const resultStr = toolError
            ? JSON.stringify({ error: toolError.message || String(toolError) })
            : (result ? JSON.stringify(result) : '{}');

        // 1. Update message in DB
        this.db.updateMessage(toolMessageId, {
            status,
            tool_result: resultStr,
            processed_at: new Date().toISOString()
        });

        // 2. Broadcast the updated message
        const updatedMsg = this.db.getMessage(toolMessageId);
        if (updatedMsg) {
            this.socketService.broadcastToConversation(conversationId, 'message', updatedMsg);
        }

        // 2.1 Emit progress heartbeat for focuses (parent visibility)
        try {
            const conv = this.db.getConversation(conversationId);
            if (conv && conv.conversation_type === 'focus') {
                this._emitFocusHeartbeat(conv, {
                    lastTool: updatedMsg?.tool_name || null,
                    status: status,
                });
            }
        } catch (_) {}

        // 3. Check if there are more pending tools
        const hasPending = this.db.hasPendingToolsInConversation(conversationId);
        if (hasPending) {
            // Still tools to process — UI keeps tool_exec
            this.socketService.broadcastAIStatus(conversationId, 'tool_exec');
            return;
        }

        // All tools complete — transition via stateChange
        try {
            const conv = this.getConversation(conversationId);

            // Cancellation: NEVER re-queue to 'queued' (the loop would stop without relaunching AI). Finalize terminal.
            if (conv.processing_state === PROCESSING_STATES.CANCELLING
                || conv.phase === 'error'
                || conv.phase === 'cancelled') {
                console.log(`[ConversationManager] Conversation ${conversationId} cancelled; skipping tool completion.`);
                this._finalizeCancel(conv);
                return;
            }

            this.stateChange(conv, {
                conversation_id: conversationId,
                type: 'tools_completed',
                role: 'tool',
                content: '',
                status: 'completed',
                _toolsCompleted: true
            });
        } catch (err) {
            console.error(`[ConversationManager] Error in stateChange after tools completed for ${conversationId}:`, err);
        }
    }

    // =========================================================================
    // FINALIZE CANCEL — "second level" of stop
    // =========================================================================

    /**
     * Finalizes a conversation in 'cancelling' as terminal (processing the loop).
     *
     * This is the guard that prevents the loop (queued/tool_exec/tool_results)
     * from relaunching requests to OpenAI after the user clicked "stop".
     * It is idempotent: can be called from cancelOperation (aiController),
     * from the catch of AbortError in processConversation, from handleToolResult
     * and from _executeTurn without producing duplicate messages.
     */
    _finalizeCancel(conv) {
        const conversationId = conv.id;
        try {
            // 1. Mark 'pending' tool messages as cancelled (they are not executed)
            const pendingTools = this.db.connection.prepare(`
                SELECT id FROM messages
                WHERE conversation_id = ? AND role = 'tool' AND status = 'pending'
            `).all(conversationId);
            for (const tool of pendingTools) {
                this.db.connection.prepare(`
                    UPDATE messages SET status = 'error', tool_result = ?, processed_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(JSON.stringify({ error: 'cancelled by user' }), tool.id);
                const updatedMsg = this.db.getMessage(tool.id);
                if (updatedMsg) {
                    this.socketService.broadcastToConversation(conversationId, 'message', updatedMsg);
                }
            }

            // 2. Current state (may have changed since the original call)
            const current = this.db.getConversation(conversationId);
            if (!current) return;

            // 2.1 Focus: direct terminal (the cancellation report is already handled by aiController)
            if (current.conversation_type === 'focus') {
                this.db.updateConversationState(conversationId, {
                    processing_state: 'idle',
                    phase: 'completed',
                });
                this.socketService.broadcastStreamDone(conversationId);
                this.socketService.broadcastStreamCancelled(conversationId);
                return;
            }

            const isTerminal = current.processing_state === 'idle'
                || current.processing_state === 'stopped'
                || current.phase === 'error'
                || current.phase === 'cancelled'
                || current.phase === 'completed';

            if (isTerminal) {
                // Already terminal: just ensure the events that unlock the UI.
                this.socketService.broadcastStreamDone(conversationId);
                this.socketService.broadcastStreamCancelled(conversationId);
                return;
            }

            // 3. Create the terminal message "(Interrupted)" only once.
            //    stateChange classifies finish_reason 'cancelled' as EVENTS.ERROR
            //    → terminal state (idle/error) + broadcast conversation_state + done.
            const lastAssistant = this.db.connection.prepare(`
                SELECT content FROM messages
                WHERE conversation_id = ? AND role = 'assistant'
                ORDER BY id DESC LIMIT 1
            `).get(conversationId);

            const alreadyCancelled = lastAssistant && lastAssistant.content === '(Interrupted by user)';
            if (!alreadyCancelled) {
                this.stateChange(current, {
                    conversation_id: conversationId,
                    role: 'assistant',
                    content: '(Interrupted by user)',
                    status: 'completed',
                    raw_response: JSON.stringify({ finish_reason: 'cancelled' }),
                });
            } else {
                this.db.updateConversationState(conversationId, {
                    processing_state: 'idle',
                    phase: 'error',
                });
                this.socketService.broadcastStreamDone(conversationId);
            }

            this.socketService.broadcastStreamCancelled(conversationId);
        } catch (err) {
            console.error(`[ConversationManager] Error finalizing cancelled conversation ${conversationId}:`, err);
        }
    }

    /**
     * Public API for aiController to finalize the loop of a cancelled conversation (called from cancelOperation).
     */
    finalizeCancelledConversation(conversationId) {
        const conv = this.db.getConversation(conversationId);
        if (!conv) return;
        this._finalizeCancel(conv);
    }

    // =========================================================================
    // STATECHANGE — Unique point of state writing in the DB
    // =========================================================================

    stateChange(conversation, message) {
        const {
            conversation_type: conversationType,
            max_iterations: maxIterations,
            processing_state: currentProcessingState,
            phase: currentPhase,
            id: conversationId
        } = conversation;

        // 1. Classify event
        const event = this._classifyEvent(message, conversation);

        // 2. Calculate next state
        const next = this._computeNextState(conversation, event, message);

        if (!next) {
            console.log(`[ConversationManager] Ignored event ${event} for conversation ${conversationId} (phase=${currentPhase}, state=${currentProcessingState})`);
            return null;
        }

        // 3. Create the message in the DB (except tools_completed which was already updated)
        let createdMessage = null;
        if (!message._toolsCompleted) {
            createdMessage = this.db.createMessage(message);
            if (createdMessage) {
                this.socketService.broadcastToConversation(conversationId, 'message', createdMessage);
            }
        }

        // 4. If there are tool_calls, create pending tool messages
        //    But only if the next state allows tools (hasTools===true).
        //    If hasTools===false, tools are ignored (ex: finalizing_grace
        //    where AI responded with non-report tools → completed).
        const toolCalls = this._parseToolCalls(message);
        if (toolCalls.length > 0 && next.hasToolCalls) {
            let filteredToolCalls = toolCalls;
            if (conversation.conversation_type === 'focus') {
                const reportTool = toolCalls.find(tc => (tc.function?.name || tc.name) === 'submitFindings');
                if (reportTool) {
                    filteredToolCalls = [reportTool];
                }
            }
            this.createTools(conversation, filteredToolCalls);
            this.toolProcessor.trigger();
        }

        // 5. Update conversation state (ONLY state write)
        const stateUpdate = {
            processing_state: next.processingState,
            phase: next.phase,
            max_iterations: next.maxIterations,
        };
        if (next.focusReport !== undefined) {
            stateUpdate.focus_report = next.focusReport;
        }
        this.db.updateConversationState(conversationId, stateUpdate);

        // 6. Broadcast state to UI
        const status = this.computeConversationStatus({ ...conversation, phase: next.phase, processing_state: next.processingState });
        this.socketService.broadcastAIStatus(conversationId, next.processingState, status);

        this.socketService.broadcastToConversation(conversationId, 'conversation_state', {
            conversationId,
            phase: next.phase,
            processingState: next.processingState,
            status,
            event,
        });

        if (next.processingState === PROCESSING_STATES.IDLE) {
            this.socketService.broadcastStreamDone(conversationId);
        }

        // 7. Trigger runTurn to process next cycle
        this.runTurn();

        return createdMessage || { id: null, conversation_id: conversationId, status: 'completed' };
    }

    // =========================================================================
    // EVENT CLASSIFICATION
    // =========================================================================

    _classifyEvent(message, conversation) {
        // Tools completed (coming from handleToolResult)
        if (message._toolsCompleted) {
            return EVENTS.TOOLS_COMPLETED;
        }

        if (message._focusReport) {
            return EVENTS.TOOLS_WITH_REPORT;
        }

        // Auto-report: system-generated message
        if (message.__autoReport) {
            return EVENTS.AUTO_REPORT;
        }

        // User message
        if (message.role === 'user') {
            return EVENTS.USER_MESSAGE;
        }

        // Assistant message
        if (message.role === 'assistant') {
            if (message.raw_response) {
                try {
                    const raw = JSON.parse(message.raw_response);
                    if (raw.error || raw.finish_reason === 'error') {
                        return EVENTS.ERROR;
                    }
                    if (raw.finish_reason === 'cancelled') {
                        return EVENTS.ERROR;
                    }
                } catch (_) {}
            }

            const toolCalls = this._parseToolCalls(message);

            if (toolCalls.length > 0) {
                const hasReport = toolCalls.some(
                    tc => (tc.function?.name || tc.name) === 'submitFindings'
                );
                return hasReport ? EVENTS.TOOLS_WITH_REPORT : EVENTS.TOOLS_WITHOUT_REPORT;
            }

            if (!conversation.phase || conversation.phase === 'initial') {
                return EVENTS.AI_CALLED;
            }

            if (conversation.max_iterations <= 0) {
                return EVENTS.ITERATION_EXHAUSTED;
            }

            return EVENTS.TEXT_ONLY;
        }

        return null;
    }

    _parseToolCalls(message) {
        if (!message.tool_calls) return [];
        try {
            if (typeof message.tool_calls === 'string') {
                return JSON.parse(message.tool_calls);
            }
            if (Array.isArray(message.tool_calls)) {
                return message.tool_calls;
            }
        } catch (_) {}
        return [];
    }

    // =========================================================================
    // NEXT STATE CALCULATION
    // =========================================================================

    _computeNextState(conversation, event, message) {
        const { conversation_type, phase, max_iterations, id } = conversation;

        if (event === EVENTS.AUTO_REPORT) {
            const reportJson = message.__autoReportJson || '{}';
            return this._makeState('completed', 'idle', 200, false, reportJson);
        }

        if (conversation_type === 'focus') {
            return this._computeFocusNextState(conversation, event, message);
        }

        if (conversation_type === 'main') {
            return this._computeMainNextState(conversation, event, message);
        }

        if (conversation_type === 'chat') {
            return this._computeChatNextState(conversation, event, message);
        }

        // Project Memory: same simple flow as chat (AI responds and continues)
        if (conversation_type === 'project') {
            return this._computeChatNextState(conversation, event, message);
        }

        return this._makeState(phase || 'idle', 'idle', max_iterations ?? 200, false);
    }

    _computeFocusNextState(conversation, event, message) {
        const { phase, max_iterations } = conversation;
        const currentPhase = phase || 'initial';
        // Log if phase is an unexpected value (e.g. 'idle', which is a processing_state, not a phase)
        const VALID_PHASES = ['initial', 'active', 'finalizing', 'finalizing_grace', 'report_sent', 'completed'];
        if (currentPhase && !VALID_PHASES.includes(currentPhase)) {
            console.log(`[ConversationManager] Focus conversation ${conversation.id} has unexpected phase="${currentPhase}" (normalized to "initial")`);
        }

        if (event === EVENTS.USER_MESSAGE) {
            if (currentPhase === 'completed' || currentPhase === 'report_sent') {
                return null;
            }
            // User messages don't decrement iterations (no AI call costs)
            return this._makeState(currentPhase, 'queued', max_iterations ?? 200, false);
        }

        if (event === EVENTS.ERROR) {
            // Break infinite loop: if the focus is already in finalizing/finalizing_grace,
            // a persistent error MUST NOT re-queue another AI call. Transitions
            // directly to completed (the auto-report will be generated).
            if (currentPhase === 'finalizing' || currentPhase === 'finalizing_grace') {
                return this._makeState('completed', 'idle', max_iterations ?? 200, false);
            }
            return this._makeState('finalizing', 'queued', max_iterations ?? 200, false);
        }

        const key = `${currentPhase}:${event}`;
        const transition = FOCUS_TRANSITIONS[key];

        if (!transition) {
            console.log(`[ConversationManager] No transition for focus: ${key}`);
            return this._makeState(currentPhase, 'idle', max_iterations ?? 200, false);
        }

        // Iterations are decremented in processConversation before calling the AI.
        // State transitions preserve the current max_iterations value.
        const hasTools = transition.hasTools || false;

        if (transition.phase === 'completed' && !message.__autoReport && event !== EVENTS.AUTO_REPORT) {
            return this._makeState(transition.phase, transition.processing, max_iterations ?? 200, hasTools);
        }

        if (transition.phase === 'report_sent' && hasTools) {
            return this._makeState(transition.phase, transition.processing, max_iterations ?? 200, hasTools);
        }

        return this._makeState(transition.phase, transition.processing, max_iterations ?? 200, hasTools);
    }

    _computeMainNextState(conversation, event, message) {
        const { phase, max_iterations } = conversation;
        const currentPhase = phase || 'idle';

        if (event === EVENTS.USER_MESSAGE) {
            // User messages don't decrement iterations
            return this._makeState('active', 'queued', max_iterations || 200, false);
        }

        if (event === EVENTS.TOOLS_WITHOUT_REPORT || event === EVENTS.TOOLS_WITH_REPORT) {
            const toolCalls = this._parseToolCalls(message);
            const hasInvestigate = toolCalls.some(tc => (tc.function?.name || tc.name) === 'investigate');
            if (hasInvestigate) {
                return this._makeState('waiting_focus', 'idle', max_iterations ?? 200, true);
            }
            return this._makeState('active', 'queued', max_iterations ?? 200, true);
        }

        if (event === EVENTS.TEXT_ONLY || event === EVENTS.AI_CALLED) {
            return this._makeState('stopped', 'idle', max_iterations ?? 200, false);
        }

        if (event === EVENTS.ERROR) {
            return this._makeState('error', 'idle', max_iterations ?? 200, false);
        }

        if (event === EVENTS.TOOLS_COMPLETED) {
            if (currentPhase === 'waiting_focus') {
                return this._makeState('waiting_focus', 'idle', max_iterations ?? 200, false);
            }
            return this._makeState('active', 'queued', max_iterations ?? 200, false);
        }

        return this._makeState(currentPhase, 'idle', max_iterations ?? 200, false);
    }

    _computeChatNextState(conversation, event, message) {
        const { phase, max_iterations } = conversation;
        const currentPhase = phase || 'idle';

        if (event === EVENTS.USER_MESSAGE) {
            if (currentPhase === 'active') {
                return null;
            }
            // User messages don't decrement iterations
            return this._makeState('active', 'queued', max_iterations || 200, false);
        }

        if (event === EVENTS.TOOLS_WITHOUT_REPORT) {
            return this._makeState('active', 'tool_exec', max_iterations ?? 200, true);
        }

        if (event === EVENTS.TEXT_ONLY || event === EVENTS.AI_CALLED) {
            return this._makeState('stopped', 'idle', max_iterations ?? 200, false);
        }

        if (event === EVENTS.ERROR) {
            return this._makeState('error', 'idle', max_iterations ?? 200, false);
        }

        // TOOLS_COMPLETED: voltar a queued para continuar processamento
        if (event === EVENTS.TOOLS_COMPLETED) {
            return this._makeState('active', 'queued', max_iterations ?? 200, false);
        }

        return this._makeState(currentPhase, 'idle', max_iterations ?? 200, false);
    }

    _makeState(phase, processingState, maxIterations, hasToolCalls = false, focusReport = undefined) {
        const state = {
            phase,
            processingState,
            maxIterations,
            hasToolCalls,
        };
        if (focusReport !== undefined) {
            state.focusReport = focusReport;
        }
        return state;
    }

    _decrementIterations(maxIterations) {
        if (maxIterations === null || maxIterations === undefined) return 199;
        return Math.max(0, maxIterations - 1);
    }

    _isAbortError(err) {
        if (!err) return false;
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.status === 499) return true;
        if (err?.code === 'ECONNABORTED') return true;
        // SDK OpenAI v6: APIUserAbortError (subclasse de APIError com status undefined)
        if (err?.constructor?.name === 'APIUserAbortError') return true;
        if (err?.status === undefined && err instanceof Error) {
            const msg = String(err?.message || '');
            return /abort/i.test(msg);
        }
        return false;
    }

    _isNonRetryableError(err) {
        if (!err) return false;
        const status = err.status;
        if (typeof status === 'number') return status >= 400 && status < 500 && status !== 429;
        return err?.code === 'BadRequestError' || err?.name === 'BadRequestError';
    }

    // =========================================================================
    // HANDLE USER MESSAGE
    // =========================================================================

    handleUserMessage(message, conversationId, model) {
        const conv = this.getConversation(conversationId);
        if (conv.model && model && conv.model !== model) {
            console.warn(`[ConversationManager] Blocked user message for conversation ${conversationId}: conversation model is "${conv.model}" but message model is "${model}".`);
            return;
        }

        // While the conversation is cancelling, ignore new user messages
        // (the UI already blocks input; this covers duplicate nudge/submit).
        if (conv.processing_state === PROCESSING_STATES.CANCELLING) {
            console.warn(`[ConversationManager] Ignored user message for conversation ${conversationId}: cancelling in progress.`);
            return;
        }

        this.stateChange(conv, {
            conversation_id: parseInt(conversationId),
            role: 'user',
            content: message.content,
            status: 'completed'
        });
    }

    // =========================================================================
    // RUN TURN
    // =========================================================================

    runTurn() {
        this._scheduledTurnCount++;
        setImmediate(() => this._executeTurn());
    }

    async _executeTurn() {
        if (this.running) {
            return;
        }

        const turnsToProcess = this._scheduledTurnCount;
        this._scheduledTurnCount = 0;
        this.running = true;

        try {
            this._nudgeCounts.clear();
            const queuedConvs = this.db.getConversationsByProcessingState('queued');
            for (const conv of queuedConvs) {
                if (conv.processing_state === 'tool_exec') continue;

                if (conv.conversation_type === 'focus' && conv.focus_report) continue;

                if (conv.active_focus_id) {
                    const activeFocus = this.db.getConversation(conv.active_focus_id);
                    if (activeFocus && !activeFocus.focus_report) continue;
                }

                await this.processConversation(conv);
            }

            // Conversations in 'cancelling' that no longer have active operation
            // (ex: cancelled while they were 'queued', or with already finalized tools).
            // _finalizeCancel is idempotent and finalizes the loop without launching AI.
            const cancellingConvs = this.db.getConversationsByProcessingState(PROCESSING_STATES.CANCELLING);
            for (const conv of cancellingConvs) {
                this._finalizeCancel(conv);
            }

            // Only generate auto-reports for conversations in 'completed' phase
            // without focus_report. 'finalizing'/'finalizing_grace' are still processing.
            const stalledStates = ['idle', 'stopped'];
            const stalledConvs = this.db.getConversationsByPhaseAndState('completed', stalledStates);
            for (const conv of stalledConvs) {
                if (conv.focus_report) continue;
                if (conv.conversation_type !== 'focus') continue;
                await this.generateAutoReport(conv);
            }
        } finally {
            this.running = false;
        }

        if (this._scheduledTurnCount > 0) {
            const remaining = this._scheduledTurnCount;
            this._scheduledTurnCount = 0;
            setImmediate(() => this._executeTurn());
        }
    }

    async processConversation(conv) {
        const currentConv = this.db.getConversation(conv.id);
        if (!currentConv) {
            console.warn(`[ConversationManager] Conversation ${conv.id} no longer exists, skipping.`);
            return;
        }

        if (currentConv.conversation_type === 'focus' && currentConv.focus_report) {
            console.log(`[ConversationManager] Focus ${conv.id} already has a report, skipping AI call.`);
            return;
        }

        // --- Stop the loop (level 2): pending cancellation → NEVER launch AI ---
        // We re-consult the DB because `conv` may be a "queued" snapshot taken
        // before the user clicked stop.
        if (currentConv.processing_state === PROCESSING_STATES.CANCELLING) {
            console.log(`[ConversationManager] Conversation ${conv.id} is cancelling; finalizing terminal state.`);
            this._finalizeCancel(currentConv);
            return;
        }

        let provider = conv.provider_id ? this.db.getProvider(conv.provider_id) : null;
        if (!provider) {
            const activeProviders = this.db.getActiveProviders();
            if (!activeProviders.length) {
                return;
            }
            provider = activeProviders[0];
        }

        const targetModel = conv.model || this.db.getSetting('default_model') || 'gpt-3.5-turbo';

        const { sendToAI } = require('../controllers/systemPromptBuilder');

        const messages = this.db.getMessagesByConversation(conv.id, { limit: 1000 });
        const phase = conv.phase || 'initial';
        const isFinalizing = conv.conversation_type === 'focus' && phase === 'finalizing';

        const remainingIterations = this._decrementIterations(conv.max_iterations);
        this.db.updateConversation(conv.id, { max_iterations: remainingIterations });

        // Emit progress heartbeat (parent visibility for focuses)
        this._emitFocusHeartbeat(conv, { iterationsLeft: remainingIterations });

        const controller = this.aiController
            ? this.aiController.startOperation(conv.id, 'processing')
            : new AbortController();

        let result;
        try {
            result = await sendToAI({
                targetProvider: provider,
                targetModel,
                sourceMessages: messages,
                workingDir: conv.worktree_path || conv.repo_root,
                maxIterations: remainingIterations,
                conversationId: conv.id,
                conversation: conv,
                db: this.db,
                isFinalizing,
                signal: controller.signal,
            });
        } catch (err) {
            console.error(`[ConversationManager] Error calling AI for conversation ${conv.id}:`, err);

            if (this._isAbortError(err)) {
                console.log(`[ConversationManager] Abort error for ${conv.id}, marking as terminal.`);
                this._finalizeCancel(conv);
                return;
            }

            if (this._isNonRetryableError(err)) {
                console.log(`[ConversationManager] Non-retryable error for ${conv.id}, marking terminal.`);
                this.db.updateConversationState(conv.id, {
                    processing_state: 'idle',
                    phase: conv.conversation_type === 'focus' ? 'completed' : 'error',
                });
                this.socketService.broadcastStreamDone(conv.id);
                return;
            }

            this.stateChange(conv, {
                conversation_id: conv.id,
                role: 'assistant',
                content: `Error: ${err.message}`,
                raw_response: JSON.stringify({ error: true, finish_reason: 'error', message: err.message }),
                status: 'completed',
            });
            return;
        } finally {
            if (this.aiController) {
                this.aiController.finishOperation(conv.id, controller);
            }
        }

        if (!this.db.getConversation(conv.id)) {
            console.warn(`[ConversationManager] Conversation ${conv.id} disappeared during AI call, skipping.`);
            return;
        }

        // Cancellation occurred while generating: discard the response and finalize,
        // so the returned tool_calls/text do not re-queue the conversation.
        const convAfterAi = this.db.getConversation(conv.id);
        if (convAfterAi && (
            convAfterAi.processing_state === PROCESSING_STATES.CANCELLING
            || convAfterAi.phase === 'error'
            || convAfterAi.phase === 'cancelled'
        )) {
            console.log(`[ConversationManager] Conversation ${conv.id} cancelled during generation; discarding response.`);
            this._finalizeCancel(convAfterAi);
            return;
        }

        // Persist token usage (Phase D) — survives truncation/cleanup
        try {
            const usage = result && result.usage;
            if (usage && (usage.promptTokens != null || usage.completionTokens != null)) {
                const promptTokens = Number(usage.promptTokens) || 0;
                const completionTokens = Number(usage.completionTokens) || 0;
                let costUsd = null;
                try {
                    const { getModelPricing, computeCostUsd } = require('./ai/pricing');
                    const pricing = getModelPricing(targetModel);
                    costUsd = computeCostUsd(promptTokens, completionTokens, pricing);
                } catch (_) {}
                this.db.recordTokenUsage({
                    conversation_id: conv.id,
                    model: targetModel,
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    cost_usd: costUsd,
                });
            }
        } catch (usageErr) {
            console.error(`[ConversationManager] Failed to record token usage for ${conv.id}:`, usageErr);
        }

        const responseContent = (result.content || '').trim();
        const responseToolCalls = result.toolCalls || [];
        const hasContent = responseContent.length > 0;
        const hasTools = responseToolCalls.length > 0;

        if (!hasContent && !hasTools) {
            if (controller.signal.aborted) {
                console.log(`[ConversationManager] Aborted ${conv.id}, skipping nudge.`);
                return;
            }

            const nudgeCount = this._nudgeCounts.get(conv.id) || 0;

            if (nudgeCount >= 3) {
                console.log(`[ConversationManager] Max nudges (3) reached for ${conv.id}, marking as error.`);
                this.stateChange(conv, {
                    conversation_id: conv.id,
                    role: 'assistant',
                    content: 'Error: The system received too many empty responses. Please try again.',
                    status: 'completed',
                    raw_response: JSON.stringify({ error: true, finish_reason: 'error', message: 'max_nudges_exceeded' }),
                });
                this._nudgeCounts.delete(conv.id);
                return;
            }

            this._nudgeCounts.set(conv.id, nudgeCount + 1);
            console.log(`[ConversationManager] AI returned empty response for conversation ${conv.id} (iterations left: ${remainingIterations}, nudge ${nudgeCount + 1}/3). Sending nudge.`);

            let nudgeMessage;
            if (conv.conversation_type === 'focus') {
                const isFinalizingPhase = conv.phase === 'finalizing' || conv.phase === 'finalizing_grace';
                if (isFinalizingPhase) {
                    nudgeMessage = 'The system received an empty response. You are in the finalization phase. You MUST call `submitFindings` now with your report, even if incomplete.';
                } else {
                    nudgeMessage = 'The system received an empty response. If you have completed the investigation goal, please call `submitFindings` with your findings. If not, please continue with the investigation.';
                }
            } else {
                nudgeMessage = 'The system received an empty response. Please continue with the task.';
            }

            this.handleUserMessage(
                { content: nudgeMessage },
                conv.id,
                null
            );
            return;
        }

        this._nudgeCounts.delete(conv.id);

        const assistantMessage = this.stateChange(conv, {
            conversation_id: conv.id,
            role: 'assistant',
            content: responseContent || '...',
            raw_response: JSON.stringify(result.rawResponse),
            tool_calls: hasTools ? JSON.stringify(responseToolCalls) : null,
            status: 'completed'
        });

        if (assistantMessage && assistantMessage.id) {
            this.db.updateLastSentAiMessage(conv.id, assistantMessage.id);
        }
    }

    async generateAutoReport(conv) {
        const { buildPartialReport, sendReportToParent } = require('../tools/focusTools');

        const messages = this.db.getMessagesByConversation(conv.id);
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');

        const report = buildPartialReport(this.db, conv.id, lastAssistant);

        try {
            await sendReportToParent({
                conversationId: conv.id,
                report: report.markdown,
                sections: report.sections,
                completed: false,
                autogenerated: true,
                db: this.db,
                warnings: report.warnings || [],
            });
        } catch (err) {
            console.error(`[ConversationManager] Error sending auto-report for focus ${conv.id}:`, err);
        }

        this.stateChange(conv, {
            conversation_id: conv.id,
            role: 'assistant',
            content: report.markdown,
            status: 'completed',
            __autoReport: true,
            __autoReportJson: JSON.stringify(report),
        });
    }

    /**
     * Recovery: reset tools stuck in 'processing' and conversations stuck in 'sending'.
     * Should be called on server startup.
     */
    recoverStuckStates() {
        try {
            const now = Date.now();
            const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

            // Find tools stuck in 'processing' for too long
            const stuckTools = this.db.connection.prepare(`
                SELECT id, conversation_id, tool_name, created_at
                FROM messages
                WHERE role = 'tool' AND status = 'processing'
            `).all();

            for (const tool of stuckTools) {
                const createdAt = new Date(tool.created_at).getTime();
                if (now - createdAt > STUCK_THRESHOLD_MS) {
                    // Mark as error with timeout message
                    const errorResult = JSON.stringify({
                        error: `Command timed out (stuck in processing for >${STUCK_THRESHOLD_MS / 1000}s, recovered at startup)`
                    });
                    this.db.connection.prepare(`
                        UPDATE messages SET status = 'error', tool_result = ?, processed_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(errorResult, tool.id);

                    console.log(`[Recovery] Marked tool ${tool.id} (${tool.tool_name}) as error: stuck in processing`);
                    
                    // Trigger conversation state update to unblock it
                    try {
                        const conv = this.db.getConversation(tool.conversation_id);
                        if (conv) {
                            // Check if there are other pending/processing tools
                            const hasPending = this.db.hasPendingToolsInConversation(tool.conversation_id);
                            if (!hasPending) {
                                this.stateChange(conv, {
                                    conversation_id: tool.conversation_id,
                                    type: 'tools_completed',
                                    role: 'tool',
                                    content: '',
                                    status: 'completed',
                                    _toolsCompleted: true
                                });
                            } else {
                                this.socketService.broadcastAIStatus(tool.conversation_id, 'tool_exec');
                            }
                        }
                    } catch (e) {
                        console.error(`[Recovery] Error updating conversation ${tool.conversation_id}:`, e);
                    }
                }
            }

            // Reset remaining tools stuck in 'processing' → 'pending' (recent ones that may still be valid)
            const toolResult = this.db.connection.prepare(`
                UPDATE messages SET status = 'pending'
                WHERE role = 'tool' AND status = 'processing'
            `).run();
            if (toolResult.changes > 0) {
                console.log(`[Recovery] Reset ${toolResult.changes} tools from 'processing' to 'pending'`);
            }

            // Reset conversations stuck em 'sending' → 'queued'
            const convResult = this.db.connection.prepare(`
                UPDATE conversations SET processing_state = 'queued', updated_at = CURRENT_TIMESTAMP
                WHERE processing_state = 'sending'
            `).run();
            if (convResult.changes > 0) {
                console.log(`[Recovery] Reset ${convResult.changes} conversations from 'sending' to 'queued'`);
            }

            // Reset conversations cancelled mid-stop (the process died between stop and finalization) → terminal 'cancelled'
            const cancelledResult = this.db.connection.prepare(`
                UPDATE conversations SET processing_state = 'idle', phase = 'cancelled', updated_at = CURRENT_TIMESTAMP
                WHERE processing_state = 'cancelling'
            `).run();
            if (cancelledResult.changes > 0) {
                console.log(`[Recovery] Finalized ${cancelledResult.changes} conversations stuck in 'cancelling'`);
            }

            // Reset provider busy states
            this.db.connection.prepare(`UPDATE providers SET busy_conversation_id = NULL`).run();

            // Disparar processamento
            this.toolProcessor.trigger();
            this.runTurn();
        } catch (err) {
            console.error('[Recovery] Error during recovery:', err);
        }
    }
}

module.exports = ConversationManager;