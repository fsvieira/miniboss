const dbApi = require('../services/db/api');

function createTaskTreeTools(conversationId) {
  const db = new dbApi.DatabaseAPI(require('../database'));

  return {
    addTodo: {
      name: 'addTodo',
      description: 'Add a new task or subtask to the task tree',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Task description' },
          parentId: { type: 'string', description: 'Optional parent task ID for subtask' }
        },
        required: ['description']
      },
      handler: async ({ description, parentId }) => {
        return db.createTask(conversationId, description, parentId || null);
      }
    },

    updateTodo: {
      name: 'updateTodo',
      description: 'Update task status, description or notes',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'] },
          description: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['id']
      },
      handler: async ({ id, status, description, notes }) => {
        return db.updateTask(id, { status, description, notes });
      }
    },

    removeTodo: {
      name: 'removeTodo',
      description: 'Remove a task',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID' }
        },
        required: ['id']
      },
      handler: async ({ id }) => {
        return db.deleteTask(id);
      }
    },

    getTaskTree: {
      name: 'getTaskTree',
      description: 'Get current task tree for visibility',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        return db.getTaskTree(conversationId);
      }
    }
  };
}

module.exports = { createTaskTreeTools };