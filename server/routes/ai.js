const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiControllerSingleton');
const { indexProject, indexConversation, semanticSearch, ensureConversationIndexed, getIndexStatus } = require('../indexer');

function setIO(socketIO) {
  // AI controller now uses messageController for WebSocket communication
  // No need to set IO directly
}

// Removed: POST /chat endpoint - now handled via WebSocket

// GET fetch models from provider
router.get('/models/:providerId', (req, res) => aiController.fetchModels(req, res));

// POST index project files
router.post('/search/index-project', async (req, res) => {
  try {
    const { conversationId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    await ensureConversationIndexed(conversationId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error indexing project:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST index worktree files
router.post('/search/index-worktree', async (req, res) => {
  try {
    const { conversationId } = req.body;
    console.log(`[SEMANTIC SEARCH API] AI route index worktree request for conversation ${conversationId}`);
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    await indexConversation(conversationId);
    console.log(`[SEMANTIC SEARCH API] AI route index worktree completed for conversation ${conversationId}`);
    res.json({ success: true });
  } catch (error) {
    console.error(`[SEMANTIC SEARCH API] AI route index worktree failed for conversation ${conversationId}: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// POST perform semantic search
router.post('/search', async (req, res) => {
  try {
    const { query, conversationId, maxResults } = req.body;
    console.log(`[SEMANTIC SEARCH API] AI route search request: "${query}" for conversation ${conversationId}`);
    if (!query || !conversationId) {
      return res.status(400).json({ error: 'query and conversationId are required' });
    }

    const results = await semanticSearch(query, maxResults || 5, conversationId);
    console.log(`[SEMANTIC SEARCH API] AI route search completed with ${Array.isArray(results) ? results.length : 0} results`);
    res.json(results);
  } catch (error) {
    console.error(`[SEMANTIC SEARCH API] AI route search failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// GET get index status
router.get('/search/status', async (req, res) => {
  try {
    const { conversationId } = req.query;
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    const status = getIndexStatus(conversationId);
    res.json(status);
  } catch (error) {
    console.error('Error getting index status:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setIO };
