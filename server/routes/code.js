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

// Marker for client-validation failures that should always surface as 400.
class ValidationError extends Error {}

function responseError(res, err) {
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  return res.status(statusForError(err)).json({ error: err.message });
}

// Sanitizes tags: accepts an array of strings, trims, drops empties, dedupes.
// Rejects non-array / non-string entries with a 400.
function sanitizeTags(tags) {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) {
    throw new ValidationError('"tags" must be an array of strings');
  }
  const seen = new Set();
  const clean = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      throw new ValidationError('"tags" must be an array of strings');
    }
    const t = tag.trim();
    if (!t) continue;
    if (!seen.has(t)) {
      seen.add(t);
      clean.push(t);
    }
  }
  return clean;
}

// Validates a line range against the real tracked file. Throws a ValidationError
// (400) on invalid range; lets CodeNavigatorError (404/400) propagate for
// untracked/traversal/binary/too-large files.
function validateRange(project, relpath, lineStart, lineEnd) {
  if (!Number.isInteger(lineStart) || lineStart < 1) {
    throw new ValidationError('"line_start" must be an integer >= 1');
  }
  if (!Number.isInteger(lineEnd) || lineEnd < lineStart) {
    throw new ValidationError('"line_end" must be an integer >= line_start');
  }
  return codeNavigator.getTrackedFiles(project.id, project.folder_path).then((trackedFiles) => {
    codeNavigator.resolveTrackedFile(project.folder_path, relpath, trackedFiles);
    const { lineCount } = codeNavigator.readTextFile(project.folder_path, relpath, trackedFiles);
    if (lineEnd > lineCount) {
      throw new ValidationError(`"line_end" (${lineEnd}) exceeds the file line count (${lineCount})`);
    }
  });
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
      responseError(res, err);
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
      responseError(res, err);
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
        return res.json({ results: [], nameResults: [], annotationResults: [] });
      }

      const [trackedFiles, results, annotationResults] = await Promise.all([
        codeNavigator.getTrackedFiles(project.id, project.folder_path),
        codeNavigator.searchContent(project.folder_path, q),
        db.searchCodeAnnotations(project.id, q, 50),
      ]);

      const lower = q.toLowerCase();
      const nameResults = trackedFiles.filter((rel) => rel.toLowerCase().includes(lower)).slice(0, MAX_SEARCH_RESULTS);

      res.json({ results, nameResults, annotationResults });
    })
    .catch((err) => {
      responseError(res, err);
    });
});

// GET the code annotations of a file.
router.get('/annotations', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const project = loadProject(req);
      if (!project || !project.folder_path) {
        return res.status(404).json({ error: 'The project has no associated git repository folder' });
      }
      const relpath = String(req.query.file || '');
      const trackedFiles = await codeNavigator.getTrackedFiles(project.id, project.folder_path);
      codeNavigator.resolveTrackedFile(project.folder_path, relpath, trackedFiles);
      const annotations = db.getCodeAnnotationsByFile(project.id, relpath);
      res.json({ annotations });
    })
    .catch((err) => {
      responseError(res, err);
    });
});

// POST a new code annotation for a file/line range.
router.post('/annotations', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const project = loadProject(req);
      if (!project || !project.folder_path) {
        return res.status(404).json({ error: 'The project has no associated git repository folder' });
      }
      const body = req.body || {};
      const relpath = String(body.file || '').replace(/\\/g, '/');
      const note = String(body.note || '').trim();
      if (!relpath) {
        throw new ValidationError('"file" is required');
      }
      if (!note) {
        throw new ValidationError('"note" must not be empty');
      }
      const lineStart = body.line_start;
      const lineEnd = body.line_end;
      await validateRange(project, relpath, lineStart, lineEnd);
      const tags = sanitizeTags(body.tags);
      const annotation = db.createCodeAnnotation({
        project_id: project.id,
        file_path: relpath,
        line_start: lineStart,
        line_end: lineEnd,
        note,
        tags,
      });
      res.status(201).json(annotation);
    })
    .catch((err) => {
      responseError(res, err);
    });
});

// PUT (update) an existing code annotation; ownership is checked against project_id.
router.put('/annotations/:id', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const project = loadProject(req);
      if (!project || !project.folder_path) {
        return res.status(404).json({ error: 'The project has no associated git repository folder' });
      }
      const id = Number(req.params.id);
      const existing = db.getCodeAnnotation(id);
      if (!existing || existing.project_id !== project.id) {
        return res.status(404).json({ error: 'Annotation not found' });
      }
      const body = req.body || {};
      const relpath = existing.file_path;
      const lineStart = body.line_start !== undefined ? body.line_start : existing.line_start;
      const lineEnd = body.line_end !== undefined ? body.line_end : existing.line_end;
      await validateRange(project, relpath, lineStart, lineEnd);
      const tags = sanitizeTags(body.tags);
      const note = body.note !== undefined ? String(body.note || '').trim() : undefined;
      if (note !== undefined && !note) {
        throw new ValidationError('"note" must not be empty');
      }
      const updated = db.updateCodeAnnotation(id, {
        note,
        tags: body.tags !== undefined ? tags : undefined,
        line_start: body.line_start !== undefined ? lineStart : undefined,
        line_end: body.line_end !== undefined ? lineEnd : undefined,
      });
      if (!updated) {
        return res.status(404).json({ error: 'Annotation not found' });
      }
      res.json(updated);
    })
    .catch((err) => {
      responseError(res, err);
    });
});

// DELETE a code annotation; ownership is checked against project_id.
router.delete('/annotations/:id', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const project = loadProject(req);
      if (!project || !project.folder_path) {
        return res.status(404).json({ error: 'The project has no associated git repository folder' });
      }
      const id = Number(req.params.id);
      const existing = db.getCodeAnnotation(id);
      if (!existing || existing.project_id !== project.id) {
        return res.status(404).json({ error: 'Annotation not found' });
      }
      db.deleteCodeAnnotation(id);
      res.status(204).end();
    })
    .catch((err) => {
      responseError(res, err);
    });
});

module.exports = router;
