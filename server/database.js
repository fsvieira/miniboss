const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getDatabasePath } = require('./config/paths');

const dbPath = getDatabasePath();

// Create directory if it does not exist
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Create tables
db.exec(`
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
     FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
   );

     CREATE TABLE IF NOT EXISTS messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       conversation_id INTEGER NOT NULL,
       role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system', 'approval_request', 'approval_approved', 'approval_denied')),
       content TEXT NOT NULL,
       raw_response TEXT,
       error_message TEXT,
       tool_calls TEXT,
       tool_call_id TEXT,
       tool_name TEXT,
       tool_args TEXT,
       tool_result TEXT,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
     );

   CREATE TABLE IF NOT EXISTS providers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     api_key TEXT NOT NULL,
     base_url TEXT NOT NULL,
     is_active BOOLEAN DEFAULT 0,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

     CREATE TABLE IF NOT EXISTS pending_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_call_id TEXT NOT NULL UNIQUE,
      conversation_id INTEGER NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT,
      tool_name TEXT,
      tool_args TEXT,
      expires_at DATETIME,
      closed_at DATETIME,
      close_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auto_approval_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_name TEXT NOT NULL,
      rule_hash TEXT NOT NULL UNIQUE,
      rule_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_auto_approval_rules_command_name ON auto_approval_rules(command_name);

     CREATE TABLE IF NOT EXISTS project_extra_files (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       project_id INTEGER NOT NULL,
       file_path TEXT NOT NULL,
       UNIQUE(project_id, file_path),
       FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
     );

     CREATE TABLE IF NOT EXISTS conversation_tasks (
       id TEXT PRIMARY KEY,
       conversation_id INTEGER NOT NULL,
       parent_id TEXT,
       description TEXT NOT NULL,
       status TEXT NOT NULL CHECK(status IN ('todo','in_progress','done','blocked')),
       notes TEXT,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
       FOREIGN KEY (parent_id) REFERENCES conversation_tasks(id) ON DELETE CASCADE
     );
     CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON conversation_tasks(conversation_id, parent_id);

     CREATE TABLE IF NOT EXISTS sandbox_paths (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       path TEXT NOT NULL UNIQUE,
       access_mode TEXT NOT NULL DEFAULT 'read' CHECK(access_mode IN ('read', 'write')),
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
     );
  
  `);

// Migration: Add columns if they don't exist
const messagesColumns = db.prepare("PRAGMA table_info(messages)").all().map(col => col.name);
if (!messagesColumns.includes('raw_response')) {
  db.prepare("ALTER TABLE messages ADD COLUMN raw_response TEXT").run();
}
if (!messagesColumns.includes('error_message')) {
  db.prepare("ALTER TABLE messages ADD COLUMN error_message TEXT").run();
}

// Migration: Add tool_call_id, tool_name, tool_args, tool_result columns
if (!messagesColumns.includes('tool_call_id')) {
  db.prepare("ALTER TABLE messages ADD COLUMN tool_call_id TEXT").run();
}
if (!messagesColumns.includes('tool_name')) {
  db.prepare("ALTER TABLE messages ADD COLUMN tool_name TEXT").run();
}
if (!messagesColumns.includes('tool_args')) {
  db.prepare("ALTER TABLE messages ADD COLUMN tool_args TEXT").run();
}
if (!messagesColumns.includes('tool_result')) {
  db.prepare("ALTER TABLE messages ADD COLUMN tool_result TEXT").run();
}
if (!messagesColumns.includes('tool_calls')) {
  db.prepare("ALTER TABLE messages ADD COLUMN tool_calls TEXT").run();
}

// Migration: add approval lifecycle columns
const pendingApprovalsColumns = db.prepare("PRAGMA table_info(pending_approvals)").all().map(col => col.name);
if (!pendingApprovalsColumns.includes('expires_at')) {
  db.prepare("ALTER TABLE pending_approvals ADD COLUMN expires_at DATETIME").run();
}
if (!pendingApprovalsColumns.includes('closed_at')) {
  db.prepare("ALTER TABLE pending_approvals ADD COLUMN closed_at DATETIME").run();
}
if (!pendingApprovalsColumns.includes('close_reason')) {
  db.prepare("ALTER TABLE pending_approvals ADD COLUMN close_reason TEXT").run();
}
db.prepare("CREATE INDEX IF NOT EXISTS idx_pending_approvals_conversation_active ON pending_approvals(conversation_id, closed_at, expires_at)").run();
db.prepare("CREATE INDEX IF NOT EXISTS idx_pending_approvals_tool_call_id ON pending_approvals(tool_call_id)").run();

// Migration: Widen role CHECK to accept 'tool' — SQLite needs table recreation
const currentTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get();
if (currentTableInfo && currentTableInfo.sql && currentTableInfo.sql.includes("CHECK(role IN ('user', 'assistant'))")) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system', 'approval_request', 'approval_approved', 'approval_denied')),
      content TEXT NOT NULL,
      raw_response TEXT,
      error_message TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    INSERT INTO messages_new SELECT id, conversation_id, role, content, raw_response, error_message, tool_call_id, tool_name, tool_args, tool_result, created_at FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;
  `);
  console.log('[DB] Migration: messages table recreated to accept tool role');
}

// Migration: Add approval roles to messages table — SQLite needs table recreation
const currentMessagesTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get();
if (currentMessagesTableInfo && currentMessagesTableInfo.sql && !currentMessagesTableInfo.sql.includes("'approval_request'")) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system', 'approval_request', 'approval_approved', 'approval_denied')),
      content TEXT NOT NULL,
      raw_response TEXT,
      error_message TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    INSERT INTO messages_new SELECT id, conversation_id, role, content, raw_response, error_message, tool_call_id, tool_name, tool_args, tool_result, created_at FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;
  `);
  console.log('[DB] Migration: messages table recreated to accept approval roles');
}

// Migration for projects table: add folder_path column
const projectsColumns = db.prepare("PRAGMA table_info(projects)").all().map(col => col.name);
if (!projectsColumns.includes('folder_path')) {
  db.prepare("ALTER TABLE projects ADD COLUMN folder_path TEXT").run();
}

// Migration for conversations table: add last_summarized_at column
let conversationsColumns = db.prepare("PRAGMA table_info(conversations)").all().map(col => col.name);
if (!conversationsColumns.includes('last_summarized_at')) {
  db.prepare("ALTER TABLE conversations ADD COLUMN last_summarized_at DATETIME").run();
  conversationsColumns = db.prepare("PRAGMA table_info(conversations)").all().map(col => col.name);
}

// Migration for conversations table: add provider_id and model columns
if (!conversationsColumns.includes('provider_id')) {
  db.prepare("ALTER TABLE conversations ADD COLUMN provider_id INTEGER").run();
}
if (!conversationsColumns.includes('model')) {
  db.prepare("ALTER TABLE conversations ADD COLUMN model TEXT").run();
}
if (!conversationsColumns.includes('repo_root')) {
  db.prepare("ALTER TABLE conversations ADD COLUMN repo_root TEXT").run();
}
if (!conversationsColumns.includes('worktree_path')) {
  db.prepare("ALTER TABLE conversations ADD COLUMN worktree_path TEXT").run();
}
if (!conversationsColumns.includes('git_branch')) {
  db.prepare("ALTER TABLE conversations ADD COLUMN git_branch TEXT").run();
}
if (!conversationsColumns.includes('base_branch')) {
  db.prepare("ALTER TABLE conversations ADD COLUMN base_branch TEXT").run();
}
  if (!conversationsColumns.includes('ai_touched_files')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN ai_touched_files TEXT").run();
  }
  if (!conversationsColumns.includes('thinking_mode')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN thinking_mode TEXT").run();
  }

  // Migration: Add conversation_type and focus_goal columns (Focus Recursive System)
  const conversationsColumnsFinal2 = db.prepare("PRAGMA table_info(conversations)").all().map(col => col.name);
  if (!conversationsColumnsFinal2.includes('conversation_type')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN conversation_type TEXT DEFAULT 'chat'").run();
    console.log('[DB] Migration: added conversation_type column to conversations');
  }
  if (!conversationsColumnsFinal2.includes('focus_goal')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN focus_goal TEXT").run();
    console.log('[DB] Migration: added focus_goal column to conversations');
  }
  if (!conversationsColumnsFinal2.includes('focus_report')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN focus_report TEXT").run();
    console.log('[DB] Migration: added focus_report column to conversations');
  }

// Migration: Add conversation_progress table for progress tracking
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
if (!tables.includes('conversation_progress')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL UNIQUE,
      todo_list TEXT NOT NULL DEFAULT '[]',
      progress_score INTEGER DEFAULT 0,
      iterations_used INTEGER DEFAULT 0,
      extended_iterations INTEGER DEFAULT 0,
      last_progress_iteration INTEGER DEFAULT 0,
      consecutive_no_progress INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_progress_conversation ON conversation_progress(conversation_id);
  `);
  console.log('[DB] Migration: conversation_progress table created');
}

// Migration: Add UNIQUE constraint to conversation_id if not present
const progressTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_progress'").get();
if (progressTableInfo && progressTableInfo.sql && !progressTableInfo.sql.includes('UNIQUE')) {
  // Recreate table with UNIQUE constraint
  db.exec(`
    CREATE TABLE conversation_progress_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL UNIQUE,
      todo_list TEXT NOT NULL DEFAULT '[]',
      progress_score INTEGER DEFAULT 0,
      iterations_used INTEGER DEFAULT 0,
      extended_iterations INTEGER DEFAULT 0,
      last_progress_iteration INTEGER DEFAULT 0,
      consecutive_no_progress INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    INSERT INTO conversation_progress_new
      SELECT * FROM conversation_progress
      WHERE conversation_id IN (
        SELECT conversation_id FROM conversation_progress
        GROUP BY conversation_id HAVING COUNT(*) = 1
      );
    DROP TABLE conversation_progress;
    ALTER TABLE conversation_progress_new RENAME TO conversation_progress;
    CREATE INDEX IF NOT EXISTS idx_progress_conversation ON conversation_progress(conversation_id);
  `);
  console.log('[DB] Migration: conversation_progress table updated with UNIQUE constraint');
}

// Migration: Add status and processed_at columns to messages table
const messagesColumns2 = db.prepare("PRAGMA table_info(messages)").all().map(col => col.name);
if (!messagesColumns2.includes('status')) {
  db.prepare("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'completed'").run();
  console.log('[DB] Migration: added status column to messages table');
}
  if (!messagesColumns2.includes('processed_at')) {
    db.prepare("ALTER TABLE messages ADD COLUMN processed_at DATETIME").run();
    console.log('[DB] Migration: added processed_at column to messages table');
  }

  // Migration: Add parent_id column to conversations table
  const conversationsColumnsFinal = db.prepare("PRAGMA table_info(conversations)").all().map(col => col.name);
  if (!conversationsColumnsFinal.includes('parent_id')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN parent_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_conversations_parent_id ON conversations(parent_id)").run();
    console.log('[DB] Migration: added parent_id column to conversations table');
  }

  // Migration: Add conversation_tasks table
  const taskTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  if (!taskTables.includes('conversation_tasks')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_tasks (
        id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        parent_id TEXT,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('todo','in_progress','done','blocked')),
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES conversation_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON conversation_tasks(conversation_id, parent_id);
    `);
    console.log('[DB] Migration: conversation_tasks table created');
  }

// Migration: Add active_focus_id column to conversations table
   const conversationsColumnsAfter = db.prepare("PRAGMA table_info(conversations)").all().map(col => col.name);
   if (!conversationsColumnsAfter.includes('active_focus_id')) {
     db.prepare("ALTER TABLE conversations ADD COLUMN active_focus_id INTEGER REFERENCES conversations(id)").run();
     db.prepare("CREATE INDEX IF NOT EXISTS idx_conversations_active_focus_id ON conversations(active_focus_id)").run();
     console.log('[DB] Migration: added active_focus_id column to conversations');
   }

   // Migration: Add camada 1/2 state columns to conversations table
   if (!conversationsColumnsAfter.includes('camada_state_json')) {
     db.prepare("ALTER TABLE conversations ADD COLUMN camada_state_json TEXT DEFAULT '{}'").run();
     console.log('[DB] Migration: added camada_state_json column to conversations');
   }
   if (!conversationsColumnsAfter.includes('camara_1_retry_state')) {
     db.prepare("ALTER TABLE conversations ADD COLUMN camara_1_retry_state TEXT").run();
     console.log('[DB] Migration: added camara_1_retry_state column to conversations');
   }

   // Migration: scheduled retries table
   const tablesFinal = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
   if (!tablesFinal.includes('scheduled_retries')) {
     db.exec(`
       CREATE TABLE IF NOT EXISTS scheduled_retries (
         conversation_id INTEGER PRIMARY KEY,
         due_at INTEGER NOT NULL,
         reason TEXT NOT NULL DEFAULT 'retry',
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
       );
       CREATE INDEX IF NOT EXISTS idx_scheduled_retries_due_at ON scheduled_retries(due_at);
     `);
     console.log('[DB] Migration: scheduled_retries table created');
   }

   db.exec(`
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

   // Migration: conversation_token_usage (Metrics and context — Phase D)
   // Records token usage per AI call. Never deleted by clear.
   const tokenUsageTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
   if (!tokenUsageTables.includes('conversation_token_usage')) {
     db.exec(`
       CREATE TABLE IF NOT EXISTS conversation_token_usage (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         conversation_id INTEGER NOT NULL,
         model TEXT,
         prompt_tokens INTEGER NOT NULL DEFAULT 0,
         completion_tokens INTEGER NOT NULL DEFAULT 0,
         cost_usd REAL,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
       );
       CREATE INDEX IF NOT EXISTS idx_token_usage_conversation ON conversation_token_usage(conversation_id, created_at);
     `);
     console.log('[DB] Migration: conversation_token_usage table created');
   }

   // =====================================================================
   // NEW MIGRATIONS: processing_state, phase, max_iterations, provider busy
   // =====================================================================

   const convCols = db.prepare("PRAGMA table_info(conversations)").all().map(col => col.name);
   if (!convCols.includes('processing_state')) {
     db.prepare("ALTER TABLE conversations ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'idle'").run();
     db.prepare("CREATE INDEX IF NOT EXISTS idx_conversations_processing_state ON conversations(processing_state)").run();
     console.log('[DB] Migration: added processing_state column to conversations');
   }
   if (!convCols.includes('phase')) {
     db.prepare("ALTER TABLE conversations ADD COLUMN phase TEXT NOT NULL DEFAULT 'idle'").run();
     db.prepare("CREATE INDEX IF NOT EXISTS idx_conversations_phase ON conversations(phase)").run();
     console.log('[DB] Migration: added phase column to conversations');
   }
    if (!convCols.includes('max_iterations')) {
      db.prepare("ALTER TABLE conversations ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 20").run();
      console.log('[DB] Migration: added max_iterations column to conversations');
    }

    // Migration: Add last_sent_ai_msg_id column to conversations table
    if (!convCols.includes('last_sent_ai_msg_id')) {
      db.prepare("ALTER TABLE conversations ADD COLUMN last_sent_ai_msg_id INTEGER").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_conversations_last_sent_ai_msg_id ON conversations(last_sent_ai_msg_id)").run();
      console.log('[DB] Migration: added last_sent_ai_msg_id column to conversations');
    }

    // Migration: Add plan column to conversations table (Plan Mode — um plano atual por conversa)
    const convColsAfterPlan = db.prepare("PRAGMA table_info(conversations)").all().map(col => col.name);
    if (!convColsAfterPlan.includes('plan')) {
      db.prepare("ALTER TABLE conversations ADD COLUMN plan TEXT").run();
      console.log('[DB] Migration: added plan column to conversations');
    }
    if (!convColsAfterPlan.includes('mode')) {
      db.prepare("ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan'").run();
      console.log('[DB] Migration: added mode column to conversations');
    }

    // Migration: Add busy_conversation_id to providers table
   const providersCols = db.prepare("PRAGMA table_info(providers)").all().map(col => col.name);
   if (!providersCols.includes('busy_conversation_id')) {
     db.prepare("ALTER TABLE providers ADD COLUMN busy_conversation_id INTEGER REFERENCES conversations(id)").run();
     console.log('[DB] Migration: added busy_conversation_id column to providers');
   }

// Migration: Create conversation_events table (optional, for debugging)
    const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    if (!allTables.includes('conversation_events')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL,
          event TEXT NOT NULL,
          from_processing_state TEXT,
          to_processing_state TEXT,
          from_phase TEXT,
          to_phase TEXT,
          payload_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_conv_events_conversation ON conversation_events(conversation_id, created_at);
      `);
      console.log('[DB] Migration: conversation_events table created');
    }

    // =====================================================================
    // PROJECT MEMORY CONVERSATION (Fase 1)
    // project_notes + plan_executions + unique index of project conversation
    // =====================================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'note'
          CHECK(kind IN ('idea','note','decision','discovery','open_question')),
        title TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
        tags TEXT,
        source_conversation_id INTEGER,
        source_message_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_notes_project
        ON project_notes(project_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS plan_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        global_conversation_id INTEGER NOT NULL,
        execution_conversation_id INTEGER NOT NULL UNIQUE,
        plan TEXT,
        status TEXT NOT NULL DEFAULT 'executing'
          CHECK(status IN ('executing','done','cancelled','failed')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (global_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (execution_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      -- ensures 1 global conversation per project even with concurrent GETs
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_project_memory
        ON conversations(project_id) WHERE conversation_type = 'project';
    `);

    module.exports = db;