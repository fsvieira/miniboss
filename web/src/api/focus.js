import { API_URL } from './config';

export async function getFocusConversations(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/focus-conversations`);
  if (!response.ok) throw new Error('Failed to fetch focus conversations');
  return response.json();
}

export async function getFocusTree(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/focus-tree`);
  if (!response.ok) throw new Error('Failed to fetch focus tree');
  return response.json();
}

export async function getParentConversation(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/parent`);
  if (!response.ok) throw new Error('Failed to fetch parent conversation');
  return response.json();
}