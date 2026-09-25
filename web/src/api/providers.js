import { API_URL } from './config.js';

export async function getProviders() {
  const response = await fetch(`${API_URL}/providers`);
  if (!response.ok) throw new Error('Failed to fetch providers');
  return response.json();
}

export async function getActiveProvider() {
  const response = await fetch(`${API_URL}/providers/active`);
  if (!response.ok) throw new Error('Failed to fetch active provider');
  return response.json();
}

export async function createProvider(provider) {
  const response = await fetch(`${API_URL}/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(provider)
  });
  if (!response.ok) throw new Error('Failed to create provider');
  return response.json();
}

export async function updateProvider(id, updates) {
  const response = await fetch(`${API_URL}/providers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  if (!response.ok) throw new Error('Failed to update provider');
  return response.json();
}

export async function deleteProvider(id) {
  const response = await fetch(`${API_URL}/providers/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete provider');
}

export async function activateProvider(id) {
  const response = await fetch(`${API_URL}/providers/${id}/activate`, { method: 'POST' });
  if (!response.ok) throw new Error('Failed to activate provider');
  return response.json();
}

// --- UI convenience helpers (moved from legacy aiService.js) ---

export async function setCurrentProviderId(id) {
  if (id) {
    await activateProvider(id);
  }
  // Store in localStorage for UI state only
  localStorage.setItem('currentProviderId', id || '');
}

export async function getCurrentProviderId() {
  // Get from localStorage for UI state
  const id = localStorage.getItem('currentProviderId');
  if (id) {
    try {
      // Verify it's still the active provider on server
      const active = await getActiveProvider();
      if (active && active.id.toString() === id) {
        return id;
      }
    } catch (error) {
      console.warn('Failed to verify active provider:', error);
    }
  }
  // Fallback to server's active provider
  try {
    const active = await getActiveProvider();
    if (active) {
      localStorage.setItem('currentProviderId', active.id.toString());
      return active.id.toString();
    }
  } catch (error) {
    console.warn('Failed to get active provider:', error);
  }
  return '';
}
