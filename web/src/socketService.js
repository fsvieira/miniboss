import { io } from 'socket.io-client';

class SocketService {
  constructor() {
    this.socket = null;
    this.listeners = new Map();
    this.joinedConversationIds = new Set();
  }

  connect() {
    if (this.socket?.connected) return;

    this.socket = io({
      path: '/api/socket.io',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
      this.joinedConversationIds.forEach((conversationId) => {
        this.socket.emit('join-conversation', conversationId);
      });
    });

    this.socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });

    // Forward events to listeners
    this.socket.on('message', (message) => {
      this.emit('message', message);
    });

    this.socket.on('ai-status', (status) => {
      this.emit('ai-status', status);
    });

    // Forward streaming events to listeners
    this.socket.on('text', (data) => {
      this.emit('text', data);
    });

    this.socket.on('tool_start', (data) => {
      this.emit('tool_start', data);
    });

    this.socket.on('tool_end', (data) => {
      this.emit('tool_end', data);
    });

    this.socket.on('checkpoint', (data) => {
      this.emit('checkpoint', data);
    });

    this.socket.on('checkpoint_complete', (data) => {
      this.emit('checkpoint_complete', data);
    });

    this.socket.on('context_info', (data) => {
      this.emit('context_info', data);
    });

    this.socket.on('command_approval_required', (data) => {
      this.emit('command_approval_required', data);
    });

    this.socket.on('approval_handled', (data) => {
      this.emit('approval_handled', data);
    });

    this.socket.on('approval_expired', (data) => {
      this.emit('approval_expired', data);
    });

    this.socket.on('done', (data) => {
      this.emit('done', data);
    });

    this.socket.on('finish', (data) => {
      this.emit('finish', data);
    });

    this.socket.on('error', (data) => {
      this.emit('error', data);
    });

    // Focus system events
    this.socket.on('focus_started', (data) => {
      this.emit('focus_started', data);
    });

    this.socket.on('focus_report', (data) => {
      this.emit('focus_report', data);
    });

    this.socket.on('focus_status_change', (data) => {
      this.emit('focus_status_change', data);
    });

    this.socket.on('focus_closed', (data) => {
      this.emit('focus_closed', data);
    });

    this.socket.on('stream_cancelled', (data) => {
      this.emit('stream_cancelled', data);
    });

    this.socket.on('conversation_state', (data) => {
      this.emit('conversation_state', data);
    });

    this.socket.on('planUpdated', (data) => {
      this.emit('planUpdated', data);
    });

    this.socket.on('taskTreeUpdated', (data) => {
      this.emit('taskTreeUpdated', data);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  joinConversation(conversationId) {
    if (!this.socket?.connected) {
      this.connect();
    }

    if (!conversationId || this.joinedConversationIds.has(conversationId)) {
      return;
    }

    this.joinedConversationIds.add(conversationId);
    if (this.socket?.connected) {
      this.socket.emit('join-conversation', conversationId);
    }

    console.log(`Joined conversation ${conversationId}`);
  }

  leaveConversation(conversationId) {
    this.joinedConversationIds.delete(conversationId);

    if (this.socket?.connected) {
      this.socket.emit('leave-conversation', conversationId);
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => callback(data));
    }
  }

  emitToServer(event, data) {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
    }
  }
}

// Export singleton instance
const socketService = new SocketService();
export default socketService;
