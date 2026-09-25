'use strict';

const { DatabaseAPI, DatabaseConnection } = require('./db');

/**
 * Broadcaster — Separate process that reads new messages from the DB
 * and broadcasts them to the socket in atomic batches.
 *
 * Replaces the one-by-one chatQueue with batches grouped by conversation.
 */
class Broadcaster {
  constructor(io) {
    this.io = io;
    this.lastMessageId = 0;
    this.pollInterval = 500; // ms
    this.tickTimer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Load the last known ID
    try {
      const connection = new DatabaseConnection();
      const db = new DatabaseAPI(connection);
      const lastMsg = connection.prepare('SELECT MAX(id) as max_id FROM messages').get();
      if (lastMsg && lastMsg.max_id) {
        this.lastMessageId = lastMsg.max_id;
      }
      connection.close();
    } catch (_) {}

    this.tickTimer = setInterval(() => this._tick(), this.pollInterval);
    console.log(`[Broadcaster] Started, polling every ${this.pollInterval}ms from message ID ${this.lastMessageId}`);
  }

  stop() {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    console.log('[Broadcaster] Stopped');
  }

  _tick() {
    if (!this.running || !this.io) return;

    try {
      const connection = new DatabaseConnection();
      const db = new DatabaseAPI(connection);

      // Fetch new messages since the last known ID
      const newMessages = connection.prepare(`
        SELECT m.*, c.processing_state, c.phase, c.conversation_type, c.active_focus_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id > ?
        ORDER BY m.id ASC
      `).all(this.lastMessageId);

      if (newMessages.length === 0) {
        connection.close();
        return;
      }

      // Update last ID
      this.lastMessageId = newMessages[newMessages.length - 1].id;

      // Group by conversation_id
      const grouped = {};
      for (const msg of newMessages) {
        const convId = msg.conversation_id;
        if (!grouped[convId]) {
          grouped[convId] = [];
        }
        grouped[convId].push(msg);
      }

      // Emit atomic batches for each conversation
      for (const [convId, messages] of Object.entries(grouped)) {
        const convInfo = messages[0];
        const isFocus = String(convInfo.conversation_type) === 'focus';

        // Emit individual messages (for compatibility with current frontend)
        for (const msg of messages) {
          if (isFocus && msg.role === 'system') {
            console.log(`[Broadcaster] Broadcasting system message for focus ${convId}: ${(msg.content || '').slice(0, 120)}`);
          }
          this.io.to(`conversation-${convId}`).emit('message', msg);
        }

        // Emit batch (for frontends that support batch)
        this.io.to(`conversation-${convId}`).emit('messages_batch', {
          conversationId: parseInt(convId),
          messages,
          processing_state: convInfo.processing_state,
          phase: convInfo.phase,
        });

        if (convInfo.processing_state && convInfo.phase) {
          const { computeConversationStatus } = require('./conversationStatus');
          this.io.to(`conversation-${convId}`).emit('conversation_state', {
            conversationId: parseInt(convId),
            phase: convInfo.phase,
            processing_state: convInfo.processing_state,
            status: computeConversationStatus(convInfo, db),
            conversationType: convInfo.conversation_type || 'chat'
          });
        }
      }

      connection.close();
    } catch (err) {
      console.error('[Broadcaster] Error:', err);
    }
  }
}

module.exports = Broadcaster;