import { useEffect } from 'react';
import chatStore from '../stores/chatStore';

export function useConversation(conversation) {
  const conversationId = conversation?.id || null;
  const state = chatStore.getConversationState(conversationId);

  useEffect(() => {
    if (!conversationId) {
      return;
    }

    chatStore.observeConversation(conversationId);
    if (!state.hasLoaded && !state.isLoadingConversation) {
      chatStore.loadConversation(conversationId);
    }
  }, [conversationId, state.hasLoaded, state.isLoadingConversation]);

  return {
    messages: state.messages,
    contextInfo: state.contextInfo,
    loadMessages: (targetConversationId) =>
      chatStore.loadConversation(targetConversationId || conversationId),
    reloadContextInfo: (targetConversationId) =>
      chatStore.reloadContextInfo(targetConversationId || conversationId)
  };
}
