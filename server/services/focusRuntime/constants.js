const FOCUS_RUNTIME_PHASES = Object.freeze({
  CREATED: 'created',
  QUEUED_FOR_AI: 'queued_for_ai',
  CALLING_AI: 'calling_ai',
  EXECUTING_TOOLS: 'executing_tools',
  AWAITING_CHILD: 'awaiting_child',
  AWAITING_REPORT: 'awaiting_report',
  DELIVERING_REPORT: 'delivering_report',
  AUTO_REPORTING: 'auto_reporting',
  COMPLETED: 'completed',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  RECOVERY_NEEDED: 'recovery_needed',
});

const FOCUS_RUNTIME_EVENTS = Object.freeze({
  CREATED: 'created',
  QUEUED_AI_TURN: 'queued_ai_turn',
  AI_TURN_STARTED: 'ai_turn_started',
  AI_TURN_COMPLETED: 'ai_turn_completed',
  TOOLS_REQUESTED: 'tools_requested',
  TOOLS_COMPLETED: 'tools_completed',
  CHILD_STARTED: 'child_started',
  CHILD_REPORTED: 'child_reported',
  REPORT_REQUESTED: 'report_requested',
  REPORT_DELIVERING: 'report_delivering',
  REPORT_DELIVERED: 'report_delivered',
  AUTO_REPORT_STARTED: 'auto_report_started',
  CANCEL_REQUESTED: 'cancel_requested',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  RECOVERY_NEEDED: 'recovery_needed',
});

const FOCUS_RUNTIME_OWNERS = Object.freeze({
  LEGACY: 'legacy',
  SHADOW: 'shadow',
  RUNTIME: 'runtime',
});

const FOCUS_REPORT_STATUS = Object.freeze({
  NONE: 'none',
  REQUESTED: 'requested',
  DELIVERING: 'delivering',
  DELIVERED: 'delivered',
  PARTIAL: 'partial',
  FAILED: 'failed',
});

const FOCUS_TOOL_MODES = Object.freeze({
  MAIN_CREATE_FOCUS_ONLY: 'main_create_focus_only',
  FOCUS_ACTIVE_TOOLS: 'focus_active_tools',
  REPORT_ONLY: 'report_only',
  NONE: 'none',
});

const FOCUS_RUNTIME_FEATURE_MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  GATE: 'gate',
  TOOLS: 'tools',
  LIFECYCLE: 'lifecycle',
  FULL: 'full',
});

const TERMINAL_FOCUS_RUNTIME_PHASES = Object.freeze(new Set([
  FOCUS_RUNTIME_PHASES.COMPLETED,
  FOCUS_RUNTIME_PHASES.CANCELLED,
  FOCUS_RUNTIME_PHASES.FAILED,
]));

module.exports = {
  FOCUS_RUNTIME_PHASES,
  FOCUS_RUNTIME_EVENTS,
  FOCUS_RUNTIME_OWNERS,
  FOCUS_REPORT_STATUS,
  FOCUS_TOOL_MODES,
  FOCUS_RUNTIME_FEATURE_MODES,
  TERMINAL_FOCUS_RUNTIME_PHASES,
};
