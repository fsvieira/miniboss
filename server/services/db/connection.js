const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getDatabasePath } = require('../../config/paths');

/**
 * Class to manage the SQLite database connection.
 * Provides basic query execution and transaction management methods.
 */
class DatabaseConnection {
  /**
   * Creates a new database connection.
   * @param {string} [dbPath] - Path to the database file. Uses the default path if not specified.
   */
  constructor(dbPath = null) {
    const dbFilePath = dbPath || getDatabasePath();

    // Create directory if it does not exist
    const dbDir = path.dirname(dbFilePath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbFilePath);

    // Lightweight migration: add thinking_status column if missing
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN thinking_status TEXT");
    } catch (e) {
      // Column already exists or other error – ignore
      if (!e.message.includes('duplicate column name')) {
        console.warn('[DB] thinking_status migration warning:', e.message);
      }
    }

    // Lightweight migration: add active_focus_id column if missing
    try {
      this.db.exec("ALTER TABLE conversations ADD COLUMN active_focus_id INTEGER REFERENCES conversations(id)");
    } catch (e) {
      // Column already exists or other error – ignore
      if (!e.message.includes('duplicate column name')) {
        console.warn('[DB] active_focus_id migration warning:', e.message);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS focus_runtime_states (
        conversation_id INTEGER PRIMARY KEY,
        parent_conversation_id INTEGER,
        root_conversation_id INTEGER,
        owner TEXT NOT NULL CHECK(owner IN ('legacy','shadow','runtime')) DEFAULT 'legacy',
        phase TEXT NOT NULL,
        tool_mode TEXT NOT NULL,
        report_status TEXT NOT NULL,
        active_child_focus_id INTEGER,
        blocked_by_focus_id INTEGER,
        initial_budget INTEGER,
        remaining_turns INTEGER,
        turns_used INTEGER NOT NULL DEFAULT 0,
        current_turn_id TEXT,
        trigger_message_id INTEGER,
        pending_action TEXT,
        pending_action_payload TEXT,
        provider_state TEXT,
        operation_id TEXT,
        last_ai_message_id INTEGER,
        last_tool_message_id INTEGER,
        error_json TEXT,
        metadata_json TEXT,
        phase_entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_focus_runtime_states_owner ON focus_runtime_states(owner);
      CREATE INDEX IF NOT EXISTS idx_focus_runtime_states_phase ON focus_runtime_states(phase);
      CREATE INDEX IF NOT EXISTS idx_focus_runtime_states_pending_action ON focus_runtime_states(pending_action);

      CREATE TABLE IF NOT EXISTS focus_runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        from_phase TEXT,
        event TEXT NOT NULL,
        to_phase TEXT NOT NULL,
        turn_id TEXT,
        payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_focus_runtime_events_conversation ON focus_runtime_events(conversation_id, created_at);
    `);
  }

  /**
   * Prepares an SQL statement.
   * @param {string} sql - SQL query to prepare.
   * @returns {Statement} Prepared statement.
   */
  prepare(sql) {
    return this.db.prepare(sql);
  }

  /**
   * Executes an SQL DDL query (CREATE, ALTER, DROP, etc.).
   * @param {string} sql - SQL query to execute.
   */
  exec(sql) {
    return this.db.exec(sql);
  }

  /**
   * Creates a transactional function (does not execute immediately).
   * @param {Function} callback - Function to execute inside the transaction.
   * @returns {Function} Transactional function that can be called with arguments.
   */
  transaction(callback) {
    return this.db.transaction(callback);
  }

  /**
   * Closes the database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Checks whether the connection is open.
   * @returns {boolean} True if the connection is open.
   */
  isOpen() {
    return this.db !== null;
  }
}

module.exports = {
  DatabaseConnection,
};
