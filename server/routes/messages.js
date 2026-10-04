const express = require('express');
const router = express.Router();
const { DatabaseAPI, DatabaseConnection } = require('../services/db');
const messageController = require('../controllers/messageController');

// Database API instance for operations that don't go through messageController
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

// Note: io is passed from the main server file for WebSocket broadcasting
let io = null;

function setIO(socketIO) {
  io = socketIO;
}

// GET messages by conversation
router.get('/conversations/:conversationId/messages', (req, res) => {
  const conversationId = req.params.conversationId;

  // Filter out approval messages from chat history (historical rows only).
  const messages = db.getMessagesByConversation(conversationId)
    .filter(m => !['approval_request', 'approval_approved', 'approval_denied'].includes(m.role));

  res.json(messages);
});

// DELETE message
router.delete('/:id', (req, res) => {
  db.deleteMessage(req.params.id);
  res.status(204).send();
});

module.exports = { router, setIO };
