const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { DatabaseAPI, DatabaseConnection } = require('../services/db');
const gitService = require('../services/gitService');
const { getMaxIterations } = require('../utils/maxIterations');

// Database API instance
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

// GET all projects
router.get('/', (req, res) => {
  const projects = db.getAllProjects();
  res.json(projects);
});

// GET single project
router.get('/:id', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// POST new project
router.post('/', (req, res) => {
  const { name, folder_path } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  Promise.resolve()
    .then(async () => {
      const normalizedFolderPath = folder_path ? await gitService.validateProjectRepository(folder_path) : null;
      const project = db.createProject({ name, folder_path: normalizedFolderPath });
      res.status(201).json(project);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

// PUT update project
router.put('/:id', (req, res) => {
  const { name, folder_path } = req.body;
  if (name === undefined) return res.status(400).json({ error: 'Name is required' });

  Promise.resolve()
    .then(async () => {
      const data = { name };

      if (folder_path !== undefined) {
        const normalizedFolderPath = folder_path ? await gitService.validateProjectRepository(folder_path) : null;
        data.folder_path = normalizedFolderPath;
      }

      const project = db.updateProject(req.params.id, data);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(project);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

// DELETE project
router.delete('/:id', (req, res) => {
  db.deleteProject(req.params.id);
  res.status(204).send();
});

// Search files by name in project folder (excludes git-tracked files)
router.get('/:id/extra-files/search', async (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project || !project.folder_path) {
    return res.json([]);
  }
  const query = (req.query.q || '').toLowerCase().trim();
  if (!query) {
    return res.json([]);
  }

  console.log(`[ExtraFiles] Search started for project ${project.id} with query "${query}"`);
  console.log(`[ExtraFiles] Base folder: ${project.folder_path}`);

  const results = [];
  const MAX_RESULTS = 200;

  // Get all tracked files once (much faster than per-file git calls)
  let trackedFiles = new Set();
  try {
    const { execSync } = require('child_process');
    const output = execSync('git ls-files', {
      cwd: project.folder_path,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });
    output.split('\n').forEach(line => {
      if (line.trim()) trackedFiles.add(line.trim());
    });
    console.log(`[ExtraFiles] Loaded ${trackedFiles.size} tracked files`);
  } catch (e) {
    console.log('[ExtraFiles] Could not load git tracked files, proceeding without filter');
  }

  function walk(dir, rel) {
    if (results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.log(`[ExtraFiles] Cannot read dir: ${rel || '.'} (${e.message})`);
      return;
    }
    console.log(`[ExtraFiles] Walking: ${rel || '.'} (${entries.length} entries)`);
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) break;
      if (entry.name === '.git') continue; // skip git internals
      const full = path.join(dir, entry.name);
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        const relForGit = relPath.split(path.sep).join('/');
        const nameMatch = entry.name.toLowerCase().includes(query);
        const isTracked = trackedFiles.has(relForGit);
        if (nameMatch) {
          console.log(`[ExtraFiles] Found matching file: ${relPath} | tracked=${isTracked}`);
        }
        if (!isTracked && nameMatch) {
          results.push(relPath);
        }
      }
    }
  }

  try {
    walk(project.folder_path, '');
    console.log(`[ExtraFiles] Search finished, found ${results.length} results`);
    res.json(results.slice(0, MAX_RESULTS));
  } catch (e) {
    console.error('[ExtraFiles] Search error:', e);
    res.json([]);
  }
});

// GET currently selected extra files for a project
router.get('/:id/extra-files/selected', (req, res) => {
  const files = db.getExtraFilesForProject(req.params.id);
  res.json(files);
});

// PUT selected extra files for a project
router.put('/:id/extra-files/selected', (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files)) {
    return res.status(400).json({ error: 'files must be an array' });
  }
  db.setExtraFilesForProject(req.params.id, files);
  res.json({ success: true });
});

// GET conversations by project
router.get('/:projectId/conversations', (req, res) => {
  try {
    // The project global conversation ('project') is created lazily and always appears first
    db.getOrCreateProjectConversation(req.params.projectId);
  } catch (e) {
    console.warn(`[Projects] Failed to ensure project conversation for project ${req.params.projectId}:`, e.message);
  }
  const conversations = db.getConversationsByProject(req.params.projectId);
  // Estado autoritativo (Fase E) para a sidebar
  const { computeConversationStatus } = require('../services/conversationStatus');
  const withStatus = conversations.map(conv => ({
    ...conv,
    status: computeConversationStatus(conv, db),
  }));
  res.json(withStatus);
});

// POST new conversation in project
router.post('/:projectId/conversations', (req, res) => {
  const { title, parent_id } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  Promise.resolve()
    .then(async () => {
      const project = db.getProject(req.params.projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (parent_id) {
        // Sub-conversa: herda worktree_path e git info da conversa pai
        const parentConversation = db.getConversation(parent_id);
        if (!parentConversation) {
          return res.status(404).json({ error: 'Parent conversation not found' });
        }

        const conversation = db.createConversation({
          project_id: req.params.projectId,
          title,
          parent_id,
          worktree_path: parentConversation.worktree_path,
          repo_root: parentConversation.repo_root,
          git_branch: parentConversation.git_branch,
          base_branch: parentConversation.base_branch,
          provider_id: parentConversation.provider_id,
          model: parentConversation.model,
        });

        db.updateProjectTimestamp(req.params.projectId);

        return res.status(201).json(conversation);
      }

      // Root conversation — normal behavior with worktree creation
      await gitService.validateProjectRepository(project.folder_path);

      const conversation = db.createConversation({
        project_id: req.params.projectId,
        title,
        conversation_type: 'main',
        max_iterations: getMaxIterations()
      });

      db.updateProjectTimestamp(req.params.projectId);

      await gitService.ensureConversationWorktree(conversation.id);
      await gitService.copyExtraFilesToWorktree(conversation.id);

      res.status(201).json(conversation);
    })
    .catch((error) => {
      res.status(400).json({ error: error.message });
    });
});

module.exports = router;
