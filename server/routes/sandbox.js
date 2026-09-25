const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseAPI, DatabaseConnection } = require('../services/db');

// Database API instance
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

// GET all sandbox paths
router.get('/paths', (req, res) => {
  const paths = db.getAllSandboxPaths();
  res.json(paths);
});

// POST new sandbox path
router.post('/paths', (req, res) => {
  const { path: targetPath, access_mode } = req.body;
  if (!targetPath || !String(targetPath).trim()) {
    return res.status(400).json({ error: 'Path is required' });
  }

  const resolvedPath = path.resolve(String(targetPath).trim());
  const mode = access_mode === 'write' ? 'write' : 'read';

  // Validate path exists
  if (!fs.existsSync(resolvedPath)) {
    return res.status(400).json({ error: `Path does not exist: ${resolvedPath}` });
  }

  const existing = db.getAllSandboxPaths().find(p => p.path === resolvedPath);
  if (existing) {
    return res.status(409).json({ error: 'Path already configured', path: existing });
  }

  const created = db.createSandboxPath({ path: resolvedPath, access_mode: mode });
  res.status(201).json(created);
});

// PUT update sandbox path
router.put('/paths/:id', (req, res) => {
  const { access_mode } = req.body;
  const existing = db.getSandboxPath(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Sandbox path not found' });

  const data = {};
  if (access_mode !== undefined) {
    if (!['read', 'write'].includes(access_mode)) {
      return res.status(400).json({ error: 'access_mode must be "read" or "write"' });
    }
    data.access_mode = access_mode;
  }

  const updated = db.updateSandboxPath(req.params.id, data);
  res.json(updated);
});

// DELETE sandbox path
router.delete('/paths/:id', (req, res) => {
  const deleted = db.deleteSandboxPath(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Sandbox path not found' });
  res.status(204).send();
});

// GET browse directory listing
router.get('/browse', (req, res) => {
  const requestedPath = req.query.path ? String(req.query.path) : os.homedir();
  const resolvedPath = path.resolve(requestedPath);

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: `Path does not exist: ${resolvedPath}` });
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isDirectory()) {
    return res.status(400).json({ error: `Not a directory: ${resolvedPath}` });
  }

  let entries = [];
  try {
    entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        path: path.join(resolvedPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return res.status(500).json({ error: `Failed to read directory: ${err.message}` });
  }

  const parentPath = path.dirname(resolvedPath);
  const canGoUp = parentPath !== resolvedPath;

  res.json({
    currentPath: resolvedPath,
    parentPath: canGoUp ? parentPath : null,
    entries,
  });
});

module.exports = router;