import { getMessages } from '../api/messages';
import { getContextInfo } from '../api/settings';

class ConversationService {
  async loadMessages(conversationId) {
    if (!conversationId) {
      return { messages: [], contextInfo: null };
    }

    try {
      const [messages, contextInfo] = await Promise.all([
        getMessages(conversationId),
        getContextInfo(conversationId)
      ]);

      return { messages, contextInfo };
    } catch (error) {
      console.error('Failed to load conversation data:', error);
      return { messages: [], contextInfo: null };
    }
  }

  async reloadContextInfo(conversationId) {
    if (!conversationId) return null;

    try {
      return await getContextInfo(conversationId);
    } catch (error) {
      console.error('Failed to reload context info:', error);
      return null;
    }
  }
}

export default new ConversationService();