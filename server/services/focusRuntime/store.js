const { FOCUS_RUNTIME_PHASES, FOCUS_RUNTIME_EVENTS } = require('./constants');
const { InvalidFocusRuntimeTransitionError } = require('./errors');

const ALLOWED_TRANSITIONS = Object.freeze({
  [FOCUS_RUNTIME_PHASES.CREATED]: new Set([FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI, FOCUS_RUNTIME_PHASES.CANCELLING, FOCUS_RUNTIME_PHASES.RECOVERY_NEEDED, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI]: new Set([FOCUS_RUNTIME_PHASES.CALLING_AI, FOCUS_RUNTIME_PHASES.CANCELLING, FOCUS_RUNTIME_PHASES.RECOVERY_NEEDED, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.CALLING_AI]: new Set([FOCUS_RUNTIME_PHASES.EXECUTING_TOOLS, FOCUS_RUNTIME_PHASES.AWAITING_REPORT, FOCUS_RUNTIME_PHASES.AUTO_REPORTING, FOCUS_RUNTIME_PHASES.COMPLETED, FOCUS_RUNTIME_PHASES.CANCELLING, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.EXECUTING_TOOLS]: new Set([FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI, FOCUS_RUNTIME_PHASES.AWAITING_CHILD, FOCUS_RUNTIME_PHASES.AWAITING_REPORT, FOCUS_RUNTIME_PHASES.AUTO_REPORTING, FOCUS_RUNTIME_PHASES.CANCELLING, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.AWAITING_CHILD]: new Set([FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI, FOCUS_RUNTIME_PHASES.AWAITING_REPORT, FOCUS_RUNTIME_PHASES.AUTO_REPORTING, FOCUS_RUNTIME_PHASES.CANCELLING, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.AWAITING_REPORT]: new Set([FOCUS_RUNTIME_PHASES.QUEUED_FOR_AI, FOCUS_RUNTIME_PHASES.DELIVERING_REPORT, FOCUS_RUNTIME_PHASES.AUTO_REPORTING, FOCUS_RUNTIME_PHASES.CANCELLING, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.DELIVERING_REPORT]: new Set([FOCUS_RUNTIME_PHASES.COMPLETED, FOCUS_RUNTIME_PHASES.AUTO_REPORTING, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.AUTO_REPORTING]: new Set([FOCUS_RUNTIME_PHASES.COMPLETED, FOCUS_RUNTIME_PHASES.FAILED]),
  [FOCUS_RUNTIME_PHASES.CANCELLING]: new Set([FOCUS_RUNTIME_PHASES.CANCELLED, FOCUS_RUNTIME_PHASES.FAILED]),
});

function serializeJson(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function deserializeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function validateTransition(fromPhase, event, toPhase) {
  if (fromPhase === toPhase) return true;
  const allowed = ALLOWED_TRANSITIONS[fromPhase];
  if (!allowed || !allowed.has(toPhase)) {
    throw new InvalidFocusRuntimeTransitionError(fromPhase, event, toPhase);
  }
  return true;
}

function serializeRuntimeState(data) {
  return {
    ...data,
    pending_action_payload: serializeJson(data.pending_action_payload),
    provider_state: serializeJson(data.provider_state),
    error_json: serializeJson(data.error_json),
    metadata_json: serializeJson(data.metadata_json),
  };
}

function deserializeRuntimeState(row) {
  if (!row) return null;
  return {
    ...row,
    pending_action_payload: deserializeJson(row.pending_action_payload),
    provider_state: deserializeJson(row.provider_state),
    error_json: deserializeJson(row.error_json),
    metadata_json: deserializeJson(row.metadata_json),
  };
}

function serializeRuntimeEvent(data) {
  return {
    ...data,
    event: data.event || FOCUS_RUNTIME_EVENTS.CREATED,
    payload_json: serializeJson(data.payload_json),
  };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  validateTransition,
  serializeRuntimeState,
  deserializeRuntimeState,
  serializeRuntimeEvent,
};
