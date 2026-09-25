import chatStore from '../stores/chatStore';

export function useStreaming(conversationId) {
  const state = chatStore.getConversationState(conversationId);

  const streamMessage = (targetConversationId, message, callbacks = {}) =>
    chatStore.streamConversationMessage(targetConversationId || conversationId, message, callbacks);

  const cancelStream = (targetConversationId) =>
    chatStore.cancelConversationStream(targetConversationId || conversationId);

  // 'cancelling' mantense activo ata que o servidor confirme o `done`
  // (signal that the loop stopped completely). Only then is the UI unlocked.)
  return {
    isLoading: state.isLoading || state.aiStatus === 'generating' || state.aiStatus === 'cancelling',
    streamingMessage: state.streamingMessage,
    toolIndicators: state.toolIndicators,
    streamMessage,
    cancelStream
  };
}
