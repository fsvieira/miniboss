import { API_URL } from './config.js';

export async function getProjects() {
  const response = await fetch(`${API_URL}/projects`);
  if (!response.ok) throw new Error('Failed to fetch projects');
  return response.json();
}

export async function createProject(name, folderPath) {
  const response = await fetch(`${API_URL}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder_path: folderPath })
  });
  if (!response.ok) throw new Error('Failed to create project');
  return response.json();
}

export async function updateProject(id, name, folderPath) {
  const response = await fetch(`${API_URL}/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder_path: folderPath })
  });
  if (!response.ok) throw new Error('Failed to update project');
  return response.json();
}

export async function deleteProject(id) {
  const response = await fetch(`${API_URL}/projects/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete project');
}
export async function setupConversation(projectId) {
  const response = await fetch(`${API_URL}/projects/${projectId}/setup-conversation`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Failed to create the Setup & Test conversation');
  return data;
}

export async function resetBaseImage(projectId) {
  const response = await fetch(`${API_URL}/projects/${projectId}/container/reset`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Failed to reset the base image');
  return data;
}
