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

  // Get regular messages
  // Phase 3: Filter out approval messages from chat history (only show pending via approvalMessages)
  let messages = db.getMessagesByConversation(conversationId)
    .filter(m => !['approval_request', 'approval_approved', 'approval_denied'].includes(m.role));

  // Get pending approvals and convert them to approval_request messages
  const pendingApprovals = db.getPendingApprovalsByConversation(conversationId);

  // Convert pending approvals to message format
  const approvalMessages = pendingApprovals.map(approval => ({
    id: `pending_approval_${approval.id}`,
    conversation_id: approval.conversation_id,
    role: 'approval_request',
    content: `**Command Approval Required**

The AI wants to execute the following command:

\`\`\`bash
${approval.command}
\`\`\`

${approval.cwd ? `Directory: \`${approval.cwd}\`` : ''}

*Waiting for approval...*`,
    tool_call_id: approval.tool_call_id,
    tool_name: approval.tool_name,
    tool_args: approval.tool_args,
    expires_at: approval.expires_at,
    created_at: approval.created_at,
    updated_at: approval.updated_at
  }));

  // Combine and sort all messages by created_at
  const allMessages = [...messages, ...approvalMessages].sort((a, b) =>
    new Date(a.created_at) - new Date(b.created_at)
  );

  res.json(allMessages);
});

// DELETE message
router.delete('/:id', (req, res) => {
  db.deleteMessage(req.params.id);
  res.status(204).send();
});

module.exports = { router, setIO };
