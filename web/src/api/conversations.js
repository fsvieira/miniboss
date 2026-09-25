import { API_URL } from './config.js';

export async function getConversations(projectId) {
  const response = await fetch(`${API_URL}/projects/${projectId}/conversations`);
  if (!response.ok) throw new Error('Failed to fetch conversations');
  return response.json();
}

export async function createConversation(projectId, title, parentId = null) {
  const response = await fetch(`${API_URL}/projects/${projectId}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, parent_id: parentId })
  });
  if (!response.ok) throw new Error('Failed to create conversation');
  return response.json();
}

export async function getConversation(id) {
  const response = await fetch(`${API_URL}/conversations/${id}`);
  if (!response.ok) throw new Error('Failed to fetch conversation');
  return response.json();
}

export async function updateConversation(id, title) {
  const response = await fetch(`${API_URL}/conversations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  if (!response.ok) throw new Error('Failed to update conversation');
  return response.json();
}

export async function setConversationModel(conversationId, providerId, model, thinkingMode = null) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/model`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, model, thinkingMode })
  });
  if (!response.ok) throw new Error('Failed to set conversation model');
  return response.json();
}

export async function deleteConversation(id) {
  const response = await fetch(`${API_URL}/conversations/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete conversation');
}

export async function getConversationGitState(id) {
  const response = await fetch(`${API_URL}/conversations/${id}/git`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to fetch conversation git state');
  return data;
}

export async function getConversationGitDiff(id) {
  const response = await fetch(`${API_URL}/conversations/${id}/git/diff`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to fetch conversation git diff');
  return data;
}

export async function commitConversationChanges(id, message) {
  const response = await fetch(`${API_URL}/conversations/${id}/git/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to commit conversation changes');
  return data;
}

export async function mergeConversationChanges(id) {
  const response = await fetch(`${API_URL}/conversations/${id}/git/merge`, {
    method: 'POST'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to merge conversation changes');
  return data;
}

export async function resetConversationChanges(id) {
  const response = await fetch(`${API_URL}/conversations/${id}/git/reset`, {
    method: 'POST'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to reset conversation changes');
  return data;
}

export async function openConversationFolder(id) {
  const response = await fetch(`${API_URL}/conversations/${id}/open-folder`, {
    method: 'POST'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to open conversation folder');
  return data;
}

export async function getSubConversations(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/sub-conversations`);
  if (!response.ok) throw new Error('Failed to fetch sub-conversations');
  return response.json();
}

export async function fetchTaskTree(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/tasks`);
  if (!response.ok) throw new Error('Failed to fetch task tree');
  return response.json();
}

export async function getPlan(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/plan`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to fetch plan');
  return data;
}

export async function updatePlan(conversationId, plan) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/plan`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to update plan');
  return data;
}

export async function setConversationMode(conversationId, mode) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to set conversation mode');
  return data;
}

export async function executePlan(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/execute-plan`, {
    method: 'POST'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to execute plan');
  return data;
}
