'use strict';

/**
 * Base class for state machines.
 *
 * Each protocol (Focus, Main, Chat) extends this class and defines:
 * - The initial state
 * - Valid transitions (from → event → to)
 * - Tool sets available per state
 * - onEnter / onExit hooks per state
 *
 * The state machine is deterministic:
 * - Given a current state + an event → produces ONE next state
 * - Invalid transitions throw ProtocolStateError
 *
 * @abstract
 */
class StateMachine {
   /**
    * @param {Object} options
    * @param {string} options.initialState - Initial state
    * @param {string} options.conversationId - Conversation ID
    */
  constructor({ initialState, conversationId }) {
    if (!initialState) throw new Error('StateMachine requires initialState');
    if (!conversationId) throw new Error('StateMachine requires conversationId');

    /** @type {string} Current state */
    this._state = initialState;
    /** @type {string} Conversation ID */
    this._conversationId = conversationId;
    /** @type {Map<string, string>} Transition map: "fromState:event" → "toState" */
    this._transitions = new Map();
    /** @type {Map<string, Function>} onEnter hooks */
    this._onEnter = new Map();
    /** @type {Map<string, Function>} onExit hooks */
    this._onExit = new Map();
    /** @type {Map<string, string[]>} Tools per state */
    this._toolSets = new Map();
    /** @type {Set<string>} Terminal states */
    this._terminalStates = new Set();
  }

  /** @returns {string} Current state */
  get state() { return this._state; }
  /** @returns {string} Conversation ID */
  get conversationId() { return this._conversationId; }
  /** @returns {boolean} true if the current state is terminal */
  get isTerminal() { return this._terminalStates.has(this._state); }

  // ========== CONFIGURATION ==========

  /**
   * Registers a valid transition.
   * @param {string|string[]} fromState - Source state(s) ('*' for any)
   * @param {string} event - Event that triggers the transition
   * @param {string} toState - Destination state
   */
  addTransition(fromState, event, toState) {
    const states = Array.isArray(fromState) ? fromState : [fromState];
    for (const from of states) {
      this._transitions.set(`${from}:${event}`, toState);
    }
  }

  /**
   * Registers a hook executed when entering a state.
   * @param {string} state
   * @param {Function} fn - async (context) => void
   */
  onEnter(state, fn) { this._onEnter.set(state, fn); }

  /**
   * Registers a hook executed when exiting a state.
   * @param {string} state
   * @param {Function} fn - async (context) => void
   */
  onExit(state, fn) { this._onExit.set(state, fn); }

  /**
   * Defines the tools available for a state.
   * @param {string} state
   * @param {string[]} toolNames
   */
  setToolSet(state, toolNames) { this._toolSets.set(state, [...toolNames]); }

  /**
   * Marks a state as terminal.
   * @param {string} state
   */
  markTerminal(state) { this._terminalStates.add(state); }

  // ========== QUERY ==========

  /**
   * Gets the names of tools available in the current state.
   * @returns {string[]}
   */
  getAvailableToolNames() {
    return this._toolSets.get(this._state) || [];
  }

  /**
   * Filters tool definitions to include only those available in the current state.
   * @param {Array<{function?: {name?: string}}>} allTools
   * @returns {Array}
   */
  filterTools(allTools) {
    const allowed = this.getAvailableToolNames();
    if (!Array.isArray(allTools)) return [];
    if (this.isTerminal || allowed.length === 0) return [];
    if (allowed.includes('*')) return allTools;
    return allTools.filter(tool => {
      const name = tool?.function?.name || tool?.name;
      return name && allowed.includes(name);
    });
  }

  // ========== EXECUTION ==========

  /**
   * Processes an event and performs a state transition.
   *
   * 1. Checks if the current state is terminal → error
   * 2. Checks if the transition exists → error if it doesn't
   * 3. Executes onExit of the current state
   * 4. Updates the state
   * 5. Executes onEnter of the new state
   *
   * @param {string} event - Event name
   * @param {Object} [context={}] - Optional context passed to hooks
   * @returns {Promise<{from: string, event: string, to: string}>}
   */
  async handleEvent(event, context = {}) {
    const from = this._state;
    const errModule = require('./errors');

    if (this.isTerminal) {
      throw new errModule.ProtocolStateError(
        this._conversationId,
        `Cannot transition from terminal state "${from}" with event "${event}"`,
        { from, event }
      );
    }

    const exactKey = `${from}:${event}`;
    const wildcardKey = `*:${event}`;
    const to = this._transitions.get(exactKey)
             || this._transitions.get(wildcardKey);

    if (!to) {
      throw new errModule.ProtocolStateError(
        this._conversationId,
        `No valid transition from "${from}" with event "${event}"`,
        { from, event, knownTransitions: Array.from(this._transitions.keys()) }
      );
    }

    // Hook onExit
    if (this._onExit.has(from)) {
      await this._onExit.get(from).call(this, { from, event, to, context });
    }

    this._state = to;

    // Hook onEnter
    if (this._onEnter.has(to)) {
      await this._onEnter.get(to).call(this, { from, event, to, context });
    }

    return { from, event, to };
  }

  /**
   * Forces a state definition (used for recovery).
   * @param {string} state
   */
  forceState(state) { this._state = state; }

  /**
   * Executes the onEnter hook for a state, if registered.
   * Used in recovery to ensure side-effects (ex: goal.finalizing) are applied.
   * @param {string} state
   * @param {Object} [context={}]
   */
  async enterState(state, context = {}) {
    if (this._onEnter.has(state)) {
      await this._onEnter.get(state).call(this, {
        from: state,
        event: 'recovery',
        to: state,
        context,
      });
    }
  }

  /**
   * Serializes the current state for persistence.
   * @returns {Object}
   */
  serialize() {
    return {
      conversationId: this._conversationId,
      state: this._state,
      type: this.constructor.name,
    };
  }
}

module.exports = { StateMachine };
