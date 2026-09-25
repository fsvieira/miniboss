import { API_URL } from './config.js';

/**
 * Index a conversation's project + worktree with SSE progress tracking.
 * @param {number} conversationId
 * @param {object} callbacks - { onProgress, onDone, onError }
 */
export async function indexConversation(conversationId, callbacks = {}) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/index`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to index' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'progress') {
          callbacks.onProgress?.(data);
        } else if (data.type === 'done') {
          callbacks.onDone?.(data);
        } else if (data.type === 'error') {
          callbacks.onError?.(new Error(data.error));
        }
      } catch {
        // ignore malformed events
      }
    }
  }
}

/**
 * Re-index changed files only.
 * @param {number} conversationId
 * @returns {Promise<{reindexed: number, chunkCount: number}>}
 */
export async function reindexConversation(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/reindex`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Failed to re-index');
  return response.json();
}

/**
 * Get indexing status for a conversation.
 * @param {number} conversationId
 * @returns {Promise<{indexed: boolean, chunkCount: number, lastIndexed: string|null, model: string|null, modelChanged: boolean, embeddingsConfigured: boolean}>}
 */
export async function getIndexStatus(conversationId) {
  const response = await fetch(`${API_URL}/conversations/${conversationId}/index-status`);
  if (!response.ok) throw new Error('Failed to get index status');
  return response.json();
}