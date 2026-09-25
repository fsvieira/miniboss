'use strict';

const { FocusProtocol } = require('./protocols/focusProtocol');
const { ChatProtocol } = require('./protocols/chatProtocol');
const { MainProtocol } = require('./protocols/mainProtocol');
const { ProtocolNotFoundError } = require('./errors');
const { FOCUS_PHASE } = require('../../constants/focusProtocol');

/**
 * Available protocol map: conversation_type → protocol class.
 * @type {Object<string, typeof import('./stateMachine').StateMachine>}
 */
const PROTOCOL_REGISTRY = {
  focus: FocusProtocol,
  chat: ChatProtocol,
  main: MainProtocol,
};

/**
 * Creates a new protocol instance for a conversation.
 *
 * @param {Object} options
 * @param {string} options.conversationId - Conversation ID
 * @param {string} options.conversationType - Type ('focus', 'main', 'chat')
 * @param {Object} [options.meta] - Optional metadata (ex: focus_goal, persisted state)
 * @returns {import('./stateMachine').StateMachine}
 * @throws {ProtocolNotFoundError} If the type is not registered
 */
function createProtocol({ conversationId, conversationType, meta = {} }) {
  const ProtocolClass = PROTOCOL_REGISTRY[conversationType];
  if (!ProtocolClass) {
    throw new ProtocolNotFoundError(conversationId, conversationType);
  }

  // If we have persisted state, restore it
  if (meta?.persistedState) {
    return ProtocolClass.fromPersisted(meta.persistedState);
  }

  return new ProtocolClass({ conversationId });
}

/**
 * Persists a protocol's state in the DB.
 * Uses the conversation's focus_goal (JSON) field to store protocol state.
 *
 * @param {Object} db - DatabaseAPI
 * @param {import('./stateMachine').StateMachine} protocol
 */
function persistProtocolState(db, protocol) {
  const serialized = protocol.serialize();
  const conv = db.getConversation(protocol.conversationId);
  if (!conv) return;

  let focusGoal = {};
  try { focusGoal = JSON.parse(conv.focus_goal || '{}'); } catch (_) {}

  // Store protocol state inside focus_goal
  focusGoal.protocolState = {
    state: serialized.state,
    updatedAt: new Date().toISOString(),
  };

  db.updateFocusGoal(protocol.conversationId, JSON.stringify(focusGoal));
}

/**
 * Loads the protocol for a conversation from the DB.
 *
 * @param {Object} db - DatabaseAPI
 * @param {string} conversationId
 * @returns {import('./stateMachine').StateMachine|null}
 */
function loadProtocol(db, conversationId) {
  const conv = db.getConversation(conversationId);
  if (!conv) return null;

  // Try to recover persisted state from focus_goal
  let meta = {};
  if (conv.focus_goal) {
    try {
      const goal = JSON.parse(conv.focus_goal);
      if (goal.protocolState) {
        meta.persistedState = {
          conversationId,
          ...goal.protocolState,
        };
      }
    } catch (_) {}
  }

  try {
    return createProtocol({
      conversationId,
      conversationType: conv.conversation_type || 'chat',
      meta,
    });
  } catch (err) {
    console.error(`[Protocol] Failed to load protocol for ${conversationId}:`, err.message);
    return null;
  }
}

/**
 * Ensures that onEnter hooks of the current state are applied after recovery.
 * Used to recover side-effects like goal.finalizing = true.
 * @param {import('./stateMachine').StateMachine} protocol
 * @param {Object} [db] - DatabaseAPI for the hook to use
 * @param {Object} [conversation] - Recovered conversation
 */
async function applyRecoveryHooks(protocol, db, conversation) {
  if (!protocol || !db || !conversation) return;
  const { FOCUS_PHASE } = require('../constants/focusProtocol');
  if (protocol.state === FOCUS_PHASE.FINALIZING) {
    await protocol.enterState(FOCUS_PHASE.FINALIZING, { db, conversation });
  }
}

module.exports = {
  createProtocol,
  loadProtocol,
  persistProtocolState,
  applyRecoveryHooks,
  PROTOCOL_REGISTRY,
};
