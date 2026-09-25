const express = require('express');
const router = express.Router();
const { DatabaseAPI, DatabaseConnection } = require('../services/db');
const indexer = require('../indexer');

// Database API instance
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

// GET /search/status?conversationId= — Get indexing status
router.get('/status', (req, res) => {
  const conversationId = req.query.conversationId;
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId query parameter is required' });
  }

  const conversation = db.getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const status = indexer.getIndexStatus(conversationId);
  const modelChanged = indexer.isModelChanged(conversationId);

  res.json({
    ...status,
    modelChanged,
    embeddingsConfigured: indexer.isEmbeddingsConfigured(),
  });
});

// POST /search/index-project — Index the project for a conversation
router.post('/index-project', (req, res) => {
  const { conversationId } = req.body;
  console.log(`[SEMANTIC SEARCH API] Index project request for conversation ${conversationId}`);
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  const conversation = db.getConversationWithProject(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  if (!conversation.folder_path) {
    return res.status(400).json({ error: 'Project has no folder_path set' });
  }

  if (!indexer.isEmbeddingsConfigured()) {
    console.log('[SEMANTIC SEARCH API] Embeddings not configured');
    return res.status(400).json({ error: 'Embeddings not configured' });
  }

  Promise.resolve()
    .then(async () => {
      const result = await indexer.indexProject(
        conversation.project_id,
        conversation.folder_path
      );
      console.log(`[SEMANTIC SEARCH API] Index project completed: ${JSON.stringify(result)}`);
      res.json(result);
    })
    .catch((error) => {
      console.error(`[SEMANTIC SEARCH API] Index project failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    });
});

// POST /search/index-worktree — Index the worktree for a conversation
router.post('/index-worktree', (req, res) => {
  const { conversationId } = req.body;
  console.log(`[SEMANTIC SEARCH API] Index worktree request for conversation ${conversationId}`);
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  const conversation = db.getConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  if (!indexer.isEmbeddingsConfigured()) {
    console.log('[SEMANTIC SEARCH API] Embeddings not configured');
    return res.status(400).json({ error: 'Embeddings not configured' });
  }

  const workingDir = conversation.worktree_path;
  if (!workingDir) {
    return res.status(400).json({ error: 'Conversation has no worktree path' });
  }

  Promise.resolve()
    .then(async () => {
      const result = await indexer.indexConversation(conversationId, workingDir);
      console.log(`[SEMANTIC SEARCH API] Index worktree completed: ${JSON.stringify(result)}`);
      res.json(result);
    })
    .catch((error) => {
      console.error(`[SEMANTIC SEARCH API] Index worktree failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    });
});

// POST /search — Perform semantic search
router.post('/', (req, res) => {
  const { query, conversationId, maxResults } = req.body;
  console.log(`[SEMANTIC SEARCH API] Search request: "${query}" for conversation ${conversationId}`);
  if (!query || !conversationId) {
    return res.status(400).json({ error: 'query and conversationId are required' });
  }

  Promise.resolve()
    .then(async () => {
      const results = await indexer.semanticSearch(query, maxResults || 5, conversationId);
      console.log(`[SEMANTIC SEARCH API] Search completed with ${Array.isArray(results) ? results.length : 0} results`);
      res.json(results);
    })
    .catch((error) => {
      console.error(`[SEMANTIC SEARCH API] Search failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    });
});

module.exports = router;