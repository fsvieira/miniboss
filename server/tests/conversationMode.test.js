const assert = require('assert');
const { DatabaseConnection } = require('../services/db/connection');
const { DatabaseAPI } = require('../services/db/api');

async function testConversationModeDefaultsAndPersists() {
  const connection = new DatabaseConnection(':memory:');
  const db = new DatabaseAPI(connection);

  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        folder_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        mode TEXT NOT NULL DEFAULT 'plan'
      );
    `);

    const project = db.createProject({ name: 'Mode Test' });
    const conversation = db.createConversation({ project_id: project.id, title: 'Default mode' });

    assert.strictEqual(conversation.mode, 'plan', 'New conversations should default to plan mode');

    const updatedToExec = db.setConversationMode(conversation.id, 'exec');
    assert.strictEqual(updatedToExec.mode, 'exec', 'Mode should update to exec');

    const reloaded = db.getConversation(updatedToExec.id);
    assert.strictEqual(reloaded.mode, 'exec', 'Mode should persist after reload');

    const normalizedInvalid = db.setConversationMode(conversation.id, 'invalid');
    assert.strictEqual(normalizedInvalid.mode, 'plan', 'Invalid mode should normalize to plan');

    const switchedBack = db.setConversationMode(conversation.id, 'plan');
    assert.strictEqual(switchedBack.mode, 'plan', 'Mode should switch back to plan');
  } finally {
    connection.close();
  }
}

async function run() {
  await testConversationModeDefaultsAndPersists();
  console.log('conversationMode.test.js: ok');
}

run().catch((error) => {
  console.error('conversationMode.test.js: failed');
  console.error(error);
  process.exitCode = 1;
});
