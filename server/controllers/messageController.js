const serviceRegistry = require('../services/serviceFactory');

class MessageController {
  constructor() {
    this.io = null;
  }

  setIO(io) {
    this.io = io;
  }

  broadcastMessage(message, conversationId) {
    conversationId = conversationId || message.conversation_id;

    if (this.io) {
      this.io.to(`conversation-${conversationId}`).emit('message', message);
    }
  }

  emitToConversation(conversationId, event, data) {
    if (this.io) {
      this.io.to(`conversation-${conversationId}`).emit(event, data);
    }
  }

  setConversationStatus(conversationId, status) {
    this.emitToConversation(conversationId, 'ai-status', {
      conversationId,
      status
    });
  }

  async createAndQueueMessageAsync(message) {
    const conversationId = message.conversationId || message.conversation_id;
    const toolCalls = message.tool_calls || message.toolCalls || null;
    const thinkingStatus = message.thinkingStatus || message.thinking_status || null;
    const db = serviceRegistry.getDatabaseAPI();

    const createdMessage = db.createMessage({
      conversation_id: conversationId,
      role: message.role,
      content: message.content,
      raw_response: message.raw_response || null,
      error_message: message.error_message || null,
      tool_calls: toolCalls ? JSON.stringify(toolCalls) : null,
      tool_call_id: message.tool_call_id || null,
      tool_name: message.tool_name || null,
      tool_args: message.tool_args || null,
      tool_result: message.tool_result || null,
      status: message.status || 'pending',
      thinking_status: thinkingStatus || null
    });

    db.markConversationAsQueued(parseInt(conversationId, 10));

    if (createdMessage) {
      this.broadcastMessage(createdMessage, conversationId);
    }

    return createdMessage || { conversationId, role: message.role, content: message.content, status: message.status || 'pending' };
  }
}

module.exports = new MessageController();
