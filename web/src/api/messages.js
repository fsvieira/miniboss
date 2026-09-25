import { API_URL } from './config.js';

export async function getMessages(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/messages`);
  if (!response.ok) throw new Error('Failed to fetch messages');
  return response.json();
}

export async function sendMessage(conversationId, role, content, rawResponse, errorMessage) {
  throw new Error('sendMessage REST endpoint has been removed. Use WebSocket send_message event via streamService instead.');
}