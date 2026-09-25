class FocusRuntimeError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

class InvalidFocusRuntimeTransitionError extends FocusRuntimeError {
  constructor(fromPhase, event, toPhase) {
    super(`Invalid Focus runtime transition: ${fromPhase} --${event}--> ${toPhase}`, 'FOCUS_RUNTIME_INVALID_TRANSITION', { fromPhase, event, toPhase });
  }
}

class MissingFocusRuntimeStateError extends FocusRuntimeError {
  constructor(conversationId) {
    super(`Missing Focus runtime state for conversation ${conversationId}`, 'FOCUS_RUNTIME_MISSING_STATE', { conversationId });
  }
}

class StaleFocusRuntimeTurnError extends FocusRuntimeError {
  constructor(expectedTurnId, receivedTurnId) {
    super(`Stale Focus runtime turn: expected ${expectedTurnId}, received ${receivedTurnId}`, 'FOCUS_RUNTIME_STALE_TURN', { expectedTurnId, receivedTurnId });
  }
}

module.exports = {
  FocusRuntimeError,
  InvalidFocusRuntimeTransitionError,
  MissingFocusRuntimeStateError,
  StaleFocusRuntimeTurnError,
};
