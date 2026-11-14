import { API_URL } from './config.js';

async function handle(response) {
  if (!response.ok) {
    let message = 'Request failed';
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch (_) {
      const text = await response.text();
      if (text) message = text;
    }
    throw new Error(message);
  }
  return response.json();
}

export async function getCodeTree(projectId) {
  const response = await fetch(`${API_URL}/projects/${projectId}/code/tree`);
  return handle(response);
}

export async function getCodeFile(projectId, path) {
  const response = await fetch(`${API_URL}/projects/${projectId}/code/file?path=${encodeURIComponent(path)}`);
  return handle(response);
}

export async function searchCode(projectId, q) {
  const response = await fetch(`${API_URL}/projects/${projectId}/code/search?q=${encodeURIComponent(q)}`);
  return handle(response);
}

export async function getCodeAnnotations(projectId, file) {
  const response = await fetch(`${API_URL}/projects/${projectId}/code/annotations?file=${encodeURIComponent(file)}`);
  return handle(response);
}

export async function createCodeAnnotation(projectId, data) {
  const response = await fetch(`${API_URL}/projects/${projectId}/code/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handle(response);
}

export async function updateCodeAnnotation(projectId, id, data) {
  const response = await fetch(`${API_URL}/projects/${projectId}/code/annotations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handle(response);
}

export async function deleteCodeAnnotation(projectId, id) {
  const response = await fetch(`${API_URL}/projects/${projectId}/code/annotations/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    let message = 'Request failed';
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch (_) {
      /* ignore */
    }
    throw new Error(message);
  }
}
