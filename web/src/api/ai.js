import { API_URL } from './config.js';

// SSE functions removed - now using WebSocket streaming exclusively

export async function fetchModels(providerId) {
  const response = await fetch(`${API_URL}/ai/models/${providerId}`);
  if (!response.ok) throw new Error('Failed to fetch models');
  return response.json();
}