import { API_URL } from './config.js';

export async function getSandboxPaths() {
  const response = await fetch(`${API_URL}/sandbox/paths`);
  if (!response.ok) throw new Error('Failed to fetch sandbox paths');
  return response.json();
}

export async function createSandboxPath(path, accessMode = 'read') {
  const response = await fetch(`${API_URL}/sandbox/paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, access_mode: accessMode })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create sandbox path');
  }
  return response.json();
}

export async function updateSandboxPath(id, updates) {
  const response = await fetch(`${API_URL}/sandbox/paths/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  if (!response.ok) throw new Error('Failed to update sandbox path');
  return response.json();
}

export async function deleteSandboxPath(id) {
  const response = await fetch(`${API_URL}/sandbox/paths/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete sandbox path');
}

export async function browseDirectory(path) {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const response = await fetch(`${API_URL}/sandbox/browse${query}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to browse directory');
  }
  return response.json();
}