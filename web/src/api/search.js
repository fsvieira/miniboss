import { API_URL } from './config.js';

export async function indexProject(conversationId) {
  const response = await fetch(`${API_URL}/search/index-project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export async function indexWorktree(conversationId) {
  const response = await fetch(`${API_URL}/search/index-worktree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export async function searchSemantic(query, conversationId, maxResults = 5) {
  const response = await fetch(`${API_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, conversationId, maxResults }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const result = await response.json();
  if (typeof result === 'string') {
    throw new Error(result);
  }

  return result;
}

export async function getIndexStatus(conversationId) {
  const response = await fetch(`${API_URL}/search/status?conversationId=${conversationId}`);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}