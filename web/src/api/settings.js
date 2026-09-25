import { API_URL } from './config.js';

export async function getSetting(key) {
  const response = await fetch(`${API_URL}/settings/${key}`);
  if (!response.ok) throw new Error('Failed to get setting');
  return response.json();
}

export async function setSetting(key, value) {
  const response = await fetch(`${API_URL}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  });
  if (!response.ok) throw new Error('Failed to set setting');
  return response.json();
}

export async function getContextInfo(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/context`);
  if (!response.ok) throw new Error('Failed to get context info');
  return response.json();
}

export async function cancelConversationAI(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/cancel`, {
    method: 'POST'
  });
  if (!response.ok) throw new Error('Failed to cancel AI operation');
  return response.json();
}

export async function clearConversationMessages(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/clear`, {
    method: 'POST'
  });
  if (!response.ok) throw new Error('Failed to clear conversation');
  return response.json();
}
