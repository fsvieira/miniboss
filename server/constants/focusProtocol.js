/**
 * Focus Protocol — Focus state machine states.
 *
 * Fluxo: INITIAL → ACTIVE → (FINALIZING → REPORT_SENT) → COMPLETED
 *
 *      ┌──────────────────────────────────────────────────────┐
 *      │                                                      │
 *   INITIAL ──► ACTIVE ──► FINALIZING ──► REPORT_SENT ──► COMPLETED
 *                │  ▲          │                              ▲
 *                │  │          │ (auto-generate on            │
 *                │  └──────────┘  error/iteration limit)      │
 *                │                                            │
 *                └─────── submitFindings ──────────────────┘
 */
const FOCUS_PHASE = Object.freeze({
  INITIAL: 'initial',
  ACTIVE: 'active',
  FINALIZING: 'finalizing',
  REPORT_SENT: 'report_sent',
  COMPLETED: 'completed',
});

/**
 * Events that trigger transitions in the Focus state machine.
 */
const FOCUS_EVENT = Object.freeze({
  /** A AI foi chamada pela primeira vez */
  AI_CALLED: 'ai_called',
  /** A AI respondeu com tool_calls (sem submitFindings) */
  AI_RESPONDED_WITH_TOOLS: 'ai_responded_with_tools',
  /** A AI respondeu com submitFindings */
  AI_RESPONDED_WITH_REPORT: 'ai_responded_with_report',
  /** A AI respondeu apenas com texto (sem tool_calls) */
  AI_RESPONDED_TEXT_ONLY: 'ai_responded_text_only',
  /** The iteration limit was reached */
  ITERATION_EXHAUSTED: 'iteration_exhausted',
  /** An unrecoverable error occurred */
  ERROR: 'error',
  /** O foco foi cancelado pelo utilizador */
  CANCELLED: 'cancelled',
});

/**
 * Set of tools available in each phase.
 * Used to filter tools visible to the AI.
 */
const FOCUS_TOOL_SETS = Object.freeze({
  /** Fase ativa: apenas ferramentas read-only + runCommand (sandbox read-only) + investigate + submitFindings */
  active: [
    'readFile', 'readFileChunk', 'readFileLines', 'readMultipleFiles',
    'listDirectory', 'getFileTree', 'searchFiles', 'searchInFiles',
    'grepInFile', 'semanticSearch', 'getFileInfo', 'copyFile',
    'runCommand', 'investigate', 'submitFindings',
    // Task tree tools
    'createTask', 'updateTask', 'deleteTask', 'reorderTasks',
  ],
  /** Finalization: only submitFindings */
  finalizing: ['submitFindings'],
  /** Report sent: only submitFindings (already delivered, should not be called again) — empty */
  report_sent: [],
  /** Completo: nenhuma ferramenta */
  completed: [],
  /** Inicial: ferramentas read-only + runCommand + investigate + submitFindings */
  initial: [
    'readFile', 'readFileChunk', 'readFileLines', 'readMultipleFiles',
    'listDirectory', 'getFileTree', 'searchFiles', 'searchInFiles',
    'grepInFile', 'semanticSearch', 'getFileInfo', 'copyFile',
    'runCommand', 'investigate', 'submitFindings',
    'createTask', 'updateTask', 'deleteTask', 'reorderTasks',
  ],
});

module.exports = {
  FOCUS_PHASE,
  FOCUS_EVENT,
  FOCUS_TOOL_SETS,
};
