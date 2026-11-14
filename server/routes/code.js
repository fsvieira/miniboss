'use strict';

const express = require('express');
// mergeParams lets the router read `req.params.projectId` from the
// `/api/projects/:projectId/code` mount path (Router defaults to mergeParams:false).
const router = express.Router({ mergeParams: true });
const { DatabaseAPI, DatabaseConnection } = require('../services/db');
const codeNavigator = require('../services/codeNavigator');

// Database API instance (follows the convention in routes/projects.js)
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

const { CodeNavigatorError, MAX_SEARCH_RESULTS } = codeNavigator;

function loadProject(req) {
  const project = db.getProject(req.params.projectId);
  if (!project) return null;
  return project;
}

function statusForError(err) {
  if (!(err instanceof CodeNavigatorError)) return 500;
  switch (err.code) {
    case 'binary':
    case 'too-large':
      return 400;
    case 'not-found':
      return 404;
    default:
      return 500;
  }
}

// GET the full list of tracked files (flat relpaths; the client builds the tree).
router.get('/tree', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const project = loadProject(req);
      if (!project || !project.folder_path) {
        return res.status(404).json({ error: 'The project has no associated git repository folder' });
      }
      const files = await codeNavigator.getTrackedFiles(project.id, project.folder_path);
      res.json({ files });
    })
    .catch((err) => {
      res.status(statusForError(err)).json({ error: err.message });
    });
});

// GET a single tracked text file.
router.get('/file', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const project = loadProject(req);
      if (!project || !project.folder_path) {
        return res.status(404).json({ error: 'The project has no associated git repository folder' });
      }
      const relpath = String(req.query.path || '');
      const trackedFiles = await codeNavigator.getTrackedFiles(project.id, project.folder_path);
      const file = codeNavigator.readTextFile(project.folder_path, relpath, trackedFiles);
      res.json(file);
    })
    .catch((err) => {
      res.status(statusForError(err)).json({ error: err.message });
    });
});

// GET search results: file content hits + file name hits.
router.get('/search', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const project = loadProject(req);
      if (!project || !project.folder_path) {
        return res.status(404).json({ error: 'The project has no associated git repository folder' });
      }
      const q = String(req.query.q || '').trim();
      if (!q) {
        return res.json({ results: [], nameResults: [] });
      }

      const [trackedFiles, results] = await Promise.all([
        codeNavigator.getTrackedFiles(project.id, project.folder_path),
        codeNavigator.searchContent(project.folder_path, q),
      ]);

      const lower = q.toLowerCase();
      const nameResults = trackedFiles.filter((rel) => rel.toLowerCase().includes(lower)).slice(0, MAX_SEARCH_RESULTS);

      res.json({ results, nameResults });
    })
    .catch((err) => {
      res.status(statusForError(err)).json({ error: err.message });
    });
});

module.exports = router;
