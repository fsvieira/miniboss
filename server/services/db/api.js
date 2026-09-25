/**
 * API class for CRUD operations on the database.
 * Provides high-level methods to interact with the tables.
 */
class DatabaseAPI {
  /**
   * @param {DatabaseConnection} connection - Instance of the database connection.
   */
  constructor(connection) {
    this.connection = connection;
  }

  // ===== PROJECTS CRUD =====

  /**
   * Creates a new project.
   * @param {Object} data - Project data.
   * @param {string} data.name - Project name.
   * @param {string} [data.folder_path] - Project folder path.
   * @returns {Object} Created project with ID.
   */
  createProject(data) {
    const stmt = this.connection.prepare(`
      INSERT INTO projects (name, folder_path, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const result = stmt.run(data.name, data.folder_path);
    return this.getProject(result.lastInsertRowid);
  }

  /**
   * Fetches a project by ID.
   * @param {number} id - Project ID.
   * @returns {Object|null} Found project or null.
   */
  getProject(id) {
    const stmt = this.connection.prepare(`
      SELECT id, name, folder_path, created_at, updated_at
      FROM projects
      WHERE id = ?
    `);

    return stmt.get(id) || null;
  }

  /**
   * Lists all projects.
   * @returns {Array} Array of projects.
   */
  getAllProjects() {
    const stmt = this.connection.prepare(`
      SELECT p.id, p.name, p.folder_path, p.created_at, p.updated_at, COUNT(c.id) AS conversation_count
      FROM projects p
      LEFT JOIN conversations c ON c.project_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `);

    const results = stmt.all();
    return results.map(row => ({
      ...row,
      conversation_count: Number(row.conversation_count),
    }));
  }

  /**
   * Updates a project.
   * @param {number} id - Project ID.
   * @param {Object} data - Data to update.
   * @param {string} [data.name] - New name.
   * @param {string} [data.folder_path] - New folder path.
   * @returns {Object|null} Updated project or null if not found.
   */
  updateProject(id, data) {
    const updates = [];
    const params = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      params.push(data.name);
    }

    if (data.folder_path !== undefined) {
      updates.push('folder_path = ?');
      params.push(data.folder_path);
    }

    if (updates.length === 0) {
      return this.getProject(id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const stmt = this.connection.prepare(`
      UPDATE projects
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    const result = stmt.run(...params);
    if (result.changes > 0) {
      return this.getProject(id);
    }

    return null;
  }

  /**
   * Deletes a project.
   * Manually clears project notes and executions (FK enforcement is OFF).
   * @param {number} id - Project ID.
   * @returns {boolean} True if the project was deleted.
   */
  deleteProject(id) {
    try {
      this.connection.prepare('DELETE FROM project_notes WHERE project_id = ?').run(id);
    } catch (_) {}
    try {
      this.connection.prepare('DELETE FROM plan_executions WHERE project_id = ?').run(id);
    } catch (_) {}
    const stmt = this.connection.prepare('DELETE FROM projects WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ===== PROJECT EXTRA FILES =====

  getExtraFilesForProject(projectId) {
    const stmt = this.connection.prepare(`
      SELECT file_path FROM project_extra_files
      WHERE project_id = ?
      ORDER BY file_path
    `);
    return stmt.all(projectId).map(row => row.file_path);
  }

  setExtraFilesForProject(projectId, filePaths = []) {
    const deleteStmt = this.connection.prepare('DELETE FROM project_extra_files WHERE project_id = ?');
    deleteStmt.run(projectId);

    const paths = Array.isArray(filePaths) ? filePaths : [];
    if (paths.length === 0) return;

    const insertStmt = this.connection.prepare(`
      INSERT OR IGNORE INTO project_extra_files (project_id, file_path)
      VALUES (?, ?)
    `);
    const insertMany = this.connection.transaction((pathsToInsert) => {
      for (const p of pathsToInsert) insertStmt.run(projectId, p);
    });
    insertMany(paths);
  }

  addExtraFile(projectId, filePath) {
    const stmt = this.connection.prepare(`
      INSERT OR IGNORE INTO project_extra_files (project_id, file_path)
      VALUES (?, ?)
    `);
    stmt.run(projectId, filePath);
  }

  removeExtraFile(projectId, filePath) {
    const stmt = this.connection.prepare(`
      DELETE FROM project_extra_files
      WHERE project_id = ? AND file_path = ?
    `);
    stmt.run(projectId, filePath);
  }

  // ===== CONVERSATIONS CRUD =====

  /**
   * Creates a new conversation.
   * @param {Object} data - Conversation data.
   * @param {number} data.project_id - Project ID.
   * @param {string} data.title - Conversation title.
   * @param {number} [data.provider_id] - ID do provider.
   * @param {string} [data.model] - Model used.
   * @param {number} [data.parent_id] - Parent conversation ID (for sub-conversations).
   * @param {string} [data.worktree_path] - Worktree path (inherited from parent in sub-conversations).
   * @param {string} [data.repo_root] - Repository root (inherited from parent).
   * @param {string} [data.git_branch] - Git branch (inherited from parent).
   * @param {string} [data.base_branch] - Base branch (inherited from parent).
   * @returns {Object} Created conversation with ID.
   */
  createConversation(data) {
    const stmt = this.connection.prepare(`
      INSERT INTO conversations (project_id, title, provider_id, model, parent_id, worktree_path, repo_root, git_branch, base_branch, conversation_type, max_iterations, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const result = stmt.run(
      data.project_id,
      data.title,
      data.provider_id || null,
      data.model || null,
      data.parent_id || null,
      data.worktree_path || null,
      data.repo_root || null,
      data.git_branch || null,
      data.base_branch || null,
      data.conversation_type || null,
      data.max_iterations != null ? data.max_iterations : null
    );
    return this.getConversation(result.lastInsertRowid);
  }

  /**
   * Fetches a conversation by ID.
   * @param {number} id - ID da conversa.
   * @returns {Object|null} Found conversation or null.
   */
  getConversation(id) {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch,
             ai_touched_files, parent_id, conversation_type, focus_goal, focus_report,
              active_focus_id, processing_state, phase, max_iterations, last_sent_ai_msg_id, thinking_mode, plan, mode
      FROM conversations
      WHERE id = ?
    `);

    return stmt.get(id) || null;
  }

  /**
   * Lists conversations of a project (only roots, parent_id IS NULL).
   * The project global conversation ('project') always appears first.
   * @param {number} projectId - Project ID.
   * @returns {Array} Array of root conversations.
   */
  getConversationsByProject(projectId) {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch, ai_touched_files, parent_id, conversation_type, last_sent_ai_msg_id, thinking_mode,
             processing_state, phase, active_focus_id, mode, plan, focus_report, focus_goal
      FROM conversations
      WHERE project_id = ? AND parent_id IS NULL
      ORDER BY CASE WHEN conversation_type = 'project' THEN 0 ELSE 1 END, updated_at DESC
    `);

    return stmt.all(projectId);
  }

  // ===== PROJECT MEMORY CONVERSATION =====

  /**
   * Fetches the global ('project') conversation of a project.
   * @param {number} projectId - Project ID.
   * @returns {Object|null} Global conversation or null.
   */
  getProjectConversation(projectId) {
    const stmt = this.connection.prepare(`
      SELECT * FROM conversations
      WHERE project_id = ? AND conversation_type = 'project'
      ORDER BY id ASC LIMIT 1
    `);
    return stmt.get(projectId) || null;
  }

  /**
   * Returns the project global conversation, creating it lazily if it does not exist.
   * Does not create worktree nor copy extra files — the global conversation works
   * directly on the real project folder (read-only).
   * On unique index collision (concurrent GETs), re-selects.
   * @param {number} projectId - Project ID.
   * @returns {Object|null} Global conversation (created or existing) or null if the project does not exist.
   */
  getOrCreateProjectConversation(projectId) {
    const existing = this.getProjectConversation(projectId);
    if (existing) return existing;

    const project = this.getProject(projectId);
    if (!project) return null;

    const { getMaxIterations } = require('../../utils/maxIterations');
    try {
      return this.createConversation({
        project_id: projectId,
        title: 'Project Memory',
        conversation_type: 'project',
        repo_root: project.folder_path || null,
        worktree_path: null,
        max_iterations: getMaxIterations(),
      });
    } catch (err) {
      // Corrida: outra request criou entretanto
      const again = this.getProjectConversation(projectId);
      if (again) return again;
      throw err;
    }
  }

  // ===== PROJECT NOTES =====

  /**
   * Creates a project memory note.
   * @param {Object} data - { project_id, kind, title, content, status?, tags?, source_conversation_id?, source_message_id? }
   * @returns {Object} Created note.
   */
  createProjectNote(data) {
    const stmt = this.connection.prepare(`
      INSERT INTO project_notes (project_id, kind, title, content, status, tags, source_conversation_id, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      data.project_id,
      data.kind || 'note',
      data.title || null,
      data.content,
      data.status || 'active',
      Array.isArray(data.tags) ? JSON.stringify(data.tags) : (data.tags || null),
      data.source_conversation_id || null,
      data.source_message_id || null
    );
    return this.getProjectNote(result.lastInsertRowid);
  }

  /**
   * Fetches a note by ID.
   * @param {number} id
   * @returns {Object|null}
   */
  getProjectNote(id) {
    const row = this.connection.prepare(`
      SELECT id, project_id, kind, title, content, status, tags, source_conversation_id, source_message_id, created_at, updated_at
      FROM project_notes WHERE id = ?
    `).get(id) || null;
    return row ? this._normalizeProjectNote(row) : null;
  }

  /**
   * Lists notes of a project.
   * @param {number} projectId
   * @param {Object} [options] - { status?, kind?, limit? }
   * @returns {Array}
   */
  getProjectNotes(projectId, options = {}) {
    const clauses = ['project_id = ?'];
    const params = [projectId];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
    params.push(limit);
    const rows = this.connection.prepare(`
      SELECT id, project_id, kind, title, content, status, tags, source_conversation_id, source_message_id, created_at, updated_at
      FROM project_notes
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...params);
    return rows.map(row => this._normalizeProjectNote(row));
  }

  /**
   * Updates a project memory note.
   * @param {number} id
   * @param {Object} data - { kind?, title?, content?, status?, tags? }
   * @returns {Object|null}
   */
  updateProjectNote(id, data) {
    const updates = [];
    const params = [];
    for (const field of ['kind', 'title', 'content', 'status']) {
      if (data[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(data[field]);
      }
    }
    if (data.tags !== undefined) {
      updates.push('tags = ?');
      params.push(Array.isArray(data.tags) ? JSON.stringify(data.tags) : data.tags);
    }
    if (updates.length === 0) {
      return this.getProjectNote(id);
    }
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    const result = this.connection.prepare(`
      UPDATE project_notes SET ${updates.join(', ')} WHERE id = ?
    `).run(...params);
    return result.changes > 0 ? this.getProjectNote(id) : null;
  }

  /**
   * Searches notes by text (LIKE on title/content, without FTS).
   * @param {number} projectId
   * @param {string} query
   * @param {number} [limit=10]
   * @returns {Array}
   */
  searchProjectNotes(projectId, query, limit = 10) {
    const q = String(query || '').trim();
    if (!q) return [];
    const maxLimit = Number(limit) > 0 ? Number(limit) : 10;
    const rows = this.connection.prepare(`
      SELECT id, project_id, kind, title, content, status, tags, source_conversation_id, source_message_id, created_at, updated_at
      FROM project_notes
      WHERE project_id = ? AND status = 'active' AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(projectId, `%${q}%`, `%${q}%`, maxLimit);
    return rows.map(row => this._normalizeProjectNote(row));
  }

  _normalizeProjectNote(row) {
    let tags = row.tags;
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch (_) {
        tags = null;
      }
    }
    return { ...row, tags: Array.isArray(tags) ? tags : null };
  }

  // ===== PLAN EXECUTIONS =====

  /**
   * Creates a plan execution line (Project → implementation conversation).
   */
  createPlanExecution(data) {
    const stmt = this.connection.prepare(`
      INSERT INTO plan_executions (project_id, global_conversation_id, execution_conversation_id, plan, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      data.project_id,
      data.global_conversation_id,
      data.execution_conversation_id,
      data.plan || null,
      data.status || 'executing'
    );
    return this.getPlanExecution(result.lastInsertRowid);
  }

  getPlanExecution(id) {
    return this.connection.prepare(`
      SELECT id, project_id, global_conversation_id, execution_conversation_id, plan, status, created_at, updated_at
      FROM plan_executions WHERE id = ?
    `).get(id) || null;
  }

  /**
   * Lists executions of a project (with execution conversation title).
   */
  getPlanExecutionsByProject(projectId) {
    return this.connection.prepare(`
      SELECT pe.*, c.title AS execution_title
      FROM plan_executions pe
      JOIN conversations c ON c.id = pe.execution_conversation_id
      WHERE pe.project_id = ?
      ORDER BY pe.created_at DESC, pe.id DESC
    `).all(projectId);
  }

  /**
   * Lists active ('executing') executions of a project.
   */
  getActivePlanExecutions(projectId) {
    return this.connection.prepare(`
      SELECT pe.*, c.title AS execution_title
      FROM plan_executions pe
      JOIN conversations c ON c.id = pe.execution_conversation_id
      WHERE pe.project_id = ? AND pe.status = 'executing'
      ORDER BY pe.created_at DESC, pe.id DESC
    `).all(projectId);
  }

  /**
   * Fetches the execution associated with an implementation conversation.
   */
  getPlanExecutionByExecutionConversation(executionConversationId) {
    return this.connection.prepare(`
      SELECT id, project_id, global_conversation_id, execution_conversation_id, plan, status, created_at, updated_at
      FROM plan_executions WHERE execution_conversation_id = ?
    `).get(executionConversationId) || null;
  }

  /**
   * Updates the status of a plan execution.
   */
  updatePlanExecutionStatus(id, status) {
    const stmt = this.connection.prepare(`
      UPDATE plan_executions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    const result = stmt.run(status, id);
    return result.changes > 0 ? this.getPlanExecution(id) : null;
  }

  /**
   * Lista sub-conversas de uma conversa pai.
   * @param {number} parentId - ID da conversa pai.
   * @returns {Array} Array de sub-conversas.
   */
  getSubConversations(parentId) {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch, ai_touched_files, parent_id, conversation_type, last_sent_ai_msg_id, thinking_mode
      FROM conversations
      WHERE parent_id = ?
      ORDER BY created_at ASC
    `);

    return stmt.all(parentId);
  }

  /**
   * Lists all conversations (roots and sub-conversations).
   * @returns {Array} Array de conversas.
   */
  getAllConversations() {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch, ai_touched_files, parent_id, conversation_type, last_sent_ai_msg_id, thinking_mode
      FROM conversations
      ORDER BY updated_at DESC
    `);

    return stmt.all();
  }

  /**
   * Atualiza uma conversa.
   * @param {number} id - ID da conversa.
   * @param {Object} data - Data to update.
   * @returns {Object|null} Updated conversation or null if not found.
   */
  updateConversation(id, data) {
    const updates = [];
    const params = [];

    const fields = ['title', 'provider_id', 'model', 'repo_root', 'worktree_path', 'git_branch', 'base_branch', 'ai_touched_files', 'last_summarized_at', 'parent_id', 'conversation_type', 'focus_goal', 'focus_report', 'active_focus_id', 'max_iterations', 'last_sent_ai_msg_id', 'thinking_mode', 'plan', 'mode'];
    for (const field of fields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(data[field]);
      }
    }

    if (updates.length === 0) {
      return this.getConversation(id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const stmt = this.connection.prepare(`
      UPDATE conversations
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    const result = stmt.run(...params);
    if (result.changes > 0) {
      return this.getConversation(id);
    }

    return null;
  }

  /**
   * Fetches a conversation with associated project information.
   * @param {number} id - ID da conversa.
   * @returns {Object|null} Conversa com dados do projeto ou null.
   */
  getConversationWithProject(id) {
    const stmt = this.connection.prepare(`
      SELECT c.*, p.folder_path, p.name AS project_name
      FROM conversations c
      JOIN projects p ON p.id = c.project_id
      WHERE c.id = ?
    `);

    return stmt.get(id) || null;
  }

  /**
   * Apaga uma conversa.
   * Limpa manualmente eventuais linhas de plan_executions que a referenciem
   * (FK enforcement is OFF).
   * @param {number} id - ID da conversa.
   * @returns {boolean} True se a conversa foi apagada.
   */
  deleteConversation(id) {
    try {
      this.connection.prepare(`
        DELETE FROM plan_executions WHERE execution_conversation_id = ? OR global_conversation_id = ?
      `).run(id, id);
    } catch (_) {}
    const stmt = this.connection.prepare('DELETE FROM conversations WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Cria uma conversa de focus.
   * @param {Object} data - Dados do focus.
   * @param {number} data.project_id - Project ID.
   * @param {number} data.parent_id - ID da conversa pai (MAIN ou outro focus).
   * @param {string} data.title - Focus title.
   * @param {string} data.focus_goal - JSON com goal/context/expectedResult.
   * @param {string} data.worktree_path - Caminho do worktree (herdado).
   * @param {number} [data.provider_id] - ID do provider.
   * @param {string} [data.model] - Modelo.
   * @returns {Object} Focus criado.
   */
  createFocusConversation(data) {
    // Inherit max_iterations from parent conversation, or use default from .env (200)
    const maxIterations = data.max_iterations != null ? data.max_iterations : 200;

    const stmt = this.connection.prepare(`
      INSERT INTO conversations (project_id, parent_id, title, conversation_type, focus_goal, worktree_path, repo_root, git_branch, base_branch, provider_id, model, max_iterations, created_at, updated_at)
      VALUES (?, ?, ?, 'focus', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      data.project_id,
      data.parent_id,
      data.title,
      data.focus_goal || null,
      data.worktree_path || null,
      data.repo_root || null,
      data.git_branch || null,
      data.base_branch || null,
      data.provider_id || null,
      data.model || null,
      maxIterations
    );
    return this.getConversation(result.lastInsertRowid);
  }

  /**
   * Define a conversa como tipo 'main' (orquestrador).
   * @param {number} id - ID da conversa.
   * @returns {Object|null} Conversa atualizada.
   */
  setConversationAsMain(id) {
    return this.updateConversation(id, { conversation_type: 'main' });
  }

  /**
   * Atualiza o focus_goal de uma conversa.
   * @param {number} id - ID da conversa.
   * @param {string} focusGoal - JSON string com goal/context/expectedResult.
   * @returns {Object|null} Conversa atualizada.
   */
  updateFocusGoal(id, focusGoal) {
    return this.updateConversation(id, { focus_goal: focusGoal });
  }

  /**
   * Atualiza o focus_report de uma conversa.
   * @param {number} id - ID da conversa.
   * @param {string} focusReport - JSON string com o report.
   * @returns {Object|null} Conversa atualizada.
   */
  updateFocusReport(id, focusReport) {
    return this.updateConversation(id, { focus_report: focusReport });
  }

  /**
   * Gets the current plan of a conversation (Plan Mode).
   * @param {number} conversationId
   * @returns {string|null} Markdown/JSON of the plan, or null if none.
   */
  getPlan(conversationId) {
    const conv = this.getConversation(conversationId);
    return conv ? conv.plan : null;
  }

  /**
   * Substitui o plano atual de uma conversa (Plan Mode).
   * @param {number} conversationId
   * @param {string|null} plan - Markdown/JSON do plano; vazio/null apaga.
   * @returns {Object|null} Conversa atualizada.
   */
  updatePlan(conversationId, plan) {
    const normalized = (plan == null || String(plan).trim() === '') ? null : String(plan);
    return this.updateConversation(conversationId, { plan: normalized });
  }

  /**
   * Gets the current mode of the conversation (Plan Mode): 'plan' (read-only) or 'exec'.
   * @param {number} conversationId
   * @returns {string} 'plan' | 'exec'
   */
  getConversationMode(conversationId) {
    const conv = this.getConversation(conversationId);
    return conv && conv.mode === 'exec' ? 'exec' : 'plan';
  }

  /**
   * Define o modo da conversa (Plan Mode): 'plan' (read-only) ou 'exec'.
   * @param {number} conversationId
   * @param {string} mode
   * @returns {Object|null} Conversa atualizada.
   */
  setConversationMode(conversationId, mode) {
    const normalized = mode === 'exec' ? 'exec' : 'plan';
    return this.updateConversation(conversationId, { mode: normalized });
  }

  /**
   * Busca a conversa pai de um focus.
   * @param {number} childId - ID do focus.
   * @returns {Object|null} Conversa pai.
   */
  getParentConversation(childId) {
    const child = this.getConversation(childId);
    if (!child || !child.parent_id) return null;
    return this.getConversation(child.parent_id);
  }

  /**
   * Lista sub-focos de uma conversa (MAIN ou outro focus).
   * @param {number} parentId - ID da conversa pai.
   * @returns {Array} Array de focos.
   */
  getFocusConversations(parentId) {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch,
             ai_touched_files, parent_id, conversation_type, focus_goal, focus_report, last_sent_ai_msg_id, thinking_mode
      FROM conversations
      WHERE parent_id = ? AND conversation_type = 'focus'
      ORDER BY created_at ASC
    `);
    return stmt.all(parentId);
  }

  /**
   * Gets the recursive focus tree for a conversation.
   * @param {number} conversationId - ID da conversa raiz.
   * @returns {Array} Focus tree.
   */
  getFocusTree(conversationId) {
    const buildTree = (parentId) => {
      const children = this.getFocusConversations(parentId);
      return children.map(child => ({
        ...child,
        children: buildTree(child.id)
      }));
    };
    return buildTree(conversationId);
  }

  /**
   * Apaga recursivamente todas as conversas de focus descendentes.
   * Usa ON DELETE CASCADE para remover mensagens associadas.
   * @param {number} parentId - ID da conversa pai.
   * @returns {number} Number of deleted focus conversations.
   */
  deleteAllFocusConversations(parentId) {
    let count = 0;
    const children = this.getFocusConversations(parentId);
    for (const child of children) {
      count += this.deleteAllFocusConversations(child.id);
      // Clear any active_focus_id references pointing to this child before deleting it
      this.connection.prepare(`
        UPDATE conversations SET active_focus_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE active_focus_id = ?
      `).run(child.id);
      this.deleteMessagesByConversation(child.id);
      if (this.deleteConversation(child.id)) {
        count++;
      }
    }
    return count;
  }

  // ===== ACTIVE FOCUS MANAGEMENT =====

  /**
   * Define o active_focus_id de uma conversa (MAIN ou FOCUS).
   * @param {number} conversationId - ID da conversa pai.
   * @param {number} focusId - ID do focus ativo.
   * @returns {Object|null} Conversa atualizada.
   */
  setActiveFocus(conversationId, focusId) {
    return this.updateConversation(conversationId, { active_focus_id: focusId });
  }

  /**
   * Limpa o active_focus_id de uma conversa.
   * @param {number} conversationId - ID da conversa.
   * @returns {Object|null} Conversa atualizada.
   */
  clearActiveFocus(conversationId) {
    return this.updateConversation(conversationId, { active_focus_id: null });
  }

  /**
   * Retorna o focus ativo (com focus_report IS NULL) para uma conversa.
   * @param {number} conversationId - ID da conversa pai.
   * @returns {Object|null} Focus ativo ou null.
   */
  getActiveFocus(conversationId) {
    const conv = this.getConversation(conversationId);
    if (!conv || !conv.active_focus_id) return null;
    const focus = this.getConversation(conv.active_focus_id);
    // Only return if focus still exists and has no report (active)
    if (focus && !focus.focus_report) return focus;
    // Clean up stale reference
    if (focus && focus.focus_report) {
      this.clearActiveFocus(conversationId);
    }
    return null;
  }

  /**
   * Limpa todos os active_focus_ids (para crash recovery).
   * @returns {number} Number of updated conversations.
   */
  clearAllActiveFocuses() {
    const stmt = this.connection.prepare(`
      UPDATE conversations SET active_focus_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE active_focus_id IS NOT NULL
    `);
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Returns all focus conversations without focus_report (orphans).
   * @returns {Array} Array of orphan focuses.
   */
  findOrphanFocuses() {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch,
             ai_touched_files, parent_id, conversation_type, focus_goal, focus_report, last_sent_ai_msg_id, thinking_mode
      FROM conversations
      WHERE conversation_type = 'focus' AND focus_report IS NULL
      ORDER BY created_at ASC
    `);
    return stmt.all();
  }

  /**
   * Lists focus conversations relevant for client hydration.
   * Includes focuses without report or in non-terminal phases.
   * @returns {Array}
   */
  getActiveFocusConversations() {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch,
             ai_touched_files, parent_id, conversation_type, focus_goal, focus_report,
             active_focus_id, processing_state, phase, max_iterations, last_sent_ai_msg_id
      FROM conversations
      WHERE conversation_type = 'focus'
        AND (focus_report IS NULL OR phase NOT IN ('completed','cancelled','failed'))
      ORDER BY updated_at DESC
    `);

    return stmt.all();
  }

    /**
   * Lists focus conversations with known terminal state for initial hydration.
   * @returns {Array}
   */
  getTerminalFocusConversations() {
    const stmt = this.connection.prepare(`
      SELECT id, project_id, title, created_at, updated_at, last_summarized_at,
             provider_id, model, repo_root, worktree_path, git_branch, base_branch,
             ai_touched_files, parent_id, conversation_type, focus_goal, focus_report,
             active_focus_id, processing_state, phase, max_iterations, last_sent_ai_msg_id
      FROM conversations
      WHERE conversation_type = 'focus'
        AND (focus_report IS NOT NULL OR phase IN ('completed','cancelled','failed'))
      ORDER BY updated_at DESC
    `);

    return stmt.all();
  }

  // ===== MESSAGES CRUD =====

  /**
   * Cria uma nova mensagem.
   * @param {Object} data - Dados da mensagem.
   * @param {number} data.conversation_id - ID da conversa.
   * @param {string} data.role - Papel da mensagem (user, assistant, tool, etc.).
   * @param {string} data.content - Message content.
   * @param {string} [data.status] - Status da mensagem (default 'completed').
   * @returns {Object} Mensagem criada com ID.
   */
  createMessage(data) {
    try {
      const stmt = this.connection.prepare(`
        INSERT INTO messages (conversation_id, role, content, raw_response, error_message,
                            tool_calls, tool_call_id, tool_name, tool_args, tool_result, status, thinking_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      const result = stmt.run(
        data.conversation_id,
        data.role,
        data.content,
        data.raw_response,
        data.error_message,
        data.tool_calls,
        data.tool_call_id,
        data.tool_name,
        data.tool_args,
        data.tool_result,
        data.status || 'completed',
        data.thinking_status || null
      );

      return this.getMessage(result.lastInsertRowid);
    }
    catch (e) {
      console.error("[CREATE MESSAGE DB] Insert or post-insert getMessage failed:", e);
    }
    
  }

  /**
   * Busca uma mensagem por ID.
   * @param {number} id - ID da mensagem.
   * @returns {Object|null} Mensagem encontrada ou null.
   */
  getMessage(id) {
    const stmt = this.connection.prepare(`
      SELECT id, conversation_id, role, content, raw_response, error_message, tool_calls,
             tool_call_id, tool_name, tool_args, tool_result, status, thinking_status, processed_at, created_at
      FROM messages
      WHERE id = ?
    `);

    const message = stmt.get(id) || null;
    
    if (message && message.tool_calls) {
      try {
        message.tool_calls = JSON.parse(message.tool_calls);
      } catch (parseErr) {
        console.error(`[DB] CRITICAL: Failed to JSON.parse tool_calls for message id=${message.id} (conversation ${message.conversation_id}). Raw value (first 200 chars):`, 
          String(message.tool_calls).substring(0, 200), 
          'Error:', parseErr.message);
        message._tool_calls_raw = message.tool_calls;
        message.tool_calls = null;
      }
    }

    return message;
  }

  /**
   * Lista mensagens de uma conversa.
   * @param {number} conversationId - ID da conversa.
   * @param {Object} [options] - Read options.
   * @param {number} [options.limit] - If > 0, returns only the last N messages (most recent).
   * @returns {Array} Array of messages (chronological ASC order).
   */
  getMessagesByConversation(conversationId, options = {}) {
    const limit = Number(options.limit) || 0;

    if (limit > 0) {
      // Fetch the last N messages (most recent) and return in ASC order,
      // avoiding loading very long histories into memory.
      const stmt = this.connection.prepare(`
        SELECT * FROM (
          SELECT id, conversation_id, role, content, raw_response, error_message, tool_calls,
                 tool_call_id, tool_name, tool_args, tool_result, status, thinking_status, processed_at, created_at
          FROM messages
          WHERE conversation_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        )
        ORDER BY created_at ASC, id ASC
      `);

      return stmt.all(conversationId, limit);
    }

    const stmt = this.connection.prepare(`
      SELECT id, conversation_id, role, content, raw_response, error_message, tool_calls,
             tool_call_id, tool_name, tool_args, tool_result, status, thinking_status, processed_at, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `);

    return stmt.all(conversationId);
  }

  /**
   * Lista mensagens pendentes para processamento.
   * @returns {Array} Array de mensagens pendentes.
   */
  getPendingMessages() {
    const stmt = this.connection.prepare(`
      SELECT id, conversation_id, role, content, raw_response, error_message, tool_calls,
             tool_call_id, tool_name, tool_args, tool_result, status, processed_at, created_at
      FROM messages
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `);

    return stmt.all();
  }

  /**
   * Atualiza uma mensagem.
   * @param {number} id - ID da mensagem.
   * @param {Object} data - Data to update.
   * @param {string} [data.status] - Novo status.
   * @param {string} [data.processed_at] - Timestamp de processamento.
   * @returns {Object|null} Updated message or null if not found.
   */
  updateMessage(id, data) {
    const updates = [];
    const params = [];

    if (data.status !== undefined) {
      updates.push('status = ?');
      params.push(data.status);
    }

    if (data.processed_at !== undefined) {
      updates.push('processed_at = ?');
      params.push(data.processed_at);
    }

    if (data.tool_result !== undefined) {
      updates.push('tool_result = ?');
      params.push(data.tool_result);
    }

    if (data.content !== undefined) {
      updates.push('content = ?');
      params.push(data.content);
    }

    if (updates.length === 0) {
      return this.getMessage(id);
    }

    params.push(id);

    const stmt = this.connection.prepare(`
      UPDATE messages
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    const result = stmt.run(...params);
    if (result.changes > 0) {
      return this.getMessage(id);
    }

    return null;
  }

  /**
   * Cria uma tool message com status 'pending'.
   * @param {number} conversationId - ID da conversa.
   * @param {Object} toolCall - Tool call da AI.
   * @param {string} toolCall.id - ID da tool call.
   * @param {Object} toolCall.function - Called function.
   * @param {string} toolCall.function.name - Nome da tool.
   * @param {string} toolCall.function.arguments - Argumentos JSON.
   * @returns {Object} Mensagem criada.
   */
  createPendingToolMessage(conversationId, toolCall) {
    const toolName = toolCall.function?.name || toolCall.name;
    const toolArgs = toolCall.function?.arguments || '{}';
    const stmt = this.connection.prepare(`
      INSERT INTO messages (conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, status, created_at)
      VALUES (?, 'tool', '', ?, ?, ?, NULL, 'pending', CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      conversationId,
      toolCall.id,
      toolName,
      toolArgs
    );
    return this.getMessage(result.lastInsertRowid);
  }

  /**
   * Atomic claim of the next pending tool message.
   * Transition: pending → processing.
   * Uses SQL transaction to guarantee mutual exclusion.
   * @returns {Object|null} Tool message claimada ou null.
   */
  claimNextPendingToolMessage() {
    const claimTx = this.connection.transaction(() => {
      // Fetch next pending tool message
      const msg = this.connection.prepare(`
        SELECT id FROM messages
        WHERE role = 'tool' AND status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get();

      if (!msg) return null;

      // Atomic transition: only claims if still in 'pending'
      const result = this.connection.prepare(`
        UPDATE messages SET status = 'processing'
        WHERE id = ? AND status = 'pending'
      `).run(msg.id);

      if (result.changes === 0) return null;

      return this.getMessage(msg.id);
    });

    return claimTx();
  }

  /**
   * Verifica se uma conversa tem tool messages pendentes ou a processar.
   * @param {number} conversationId - ID da conversa.
   * @returns {boolean} True if there are pending/processing tools.
   */
  hasPendingToolsInConversation(conversationId) {
    const result = this.connection.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE conversation_id = ? AND role = 'tool' AND status IN ('pending', 'processing')
    `).get(conversationId);
    return (result?.count || 0) > 0;
  }

  /**
   * Count tool messages por status numa conversa.
   * @param {number} conversationId
   * @param {string} status
   * @returns {number}
   */
  countToolMessagesByStatus(conversationId, status) {
    const result = this.connection.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE conversation_id = ? AND role = 'tool' AND status = ?
    `).get(conversationId, status);
    return result?.count || 0;
  }

  /**
   * Apaga uma mensagem.
   * @param {number} id - ID da mensagem.
   * @returns {boolean} True se a mensagem foi apagada.
   */
  deleteMessage(id) {
    const stmt = this.connection.prepare('DELETE FROM messages WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
    * Deletes all messages from a conversation.
    * Clears external references (ex: last_sent_ai_msg_id) before deleting.
    * @param {number} conversationId - ID of the conversation.
    * @returns {number} Number of messages deleted.
   */
  deleteMessagesByConversation(conversationId) {
    // Clear any foreign key references pointing to messages in this conversation
    this.connection.prepare(`
      UPDATE conversations SET last_sent_ai_msg_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND last_sent_ai_msg_id IS NOT NULL
    `).run(conversationId);

    const stmt = this.connection.prepare('DELETE FROM messages WHERE conversation_id = ?');
    const result = stmt.run(conversationId);
    return result.changes;
  }

  /**
   * Cria uma mensagem de assistente.
   * @param {number} conversationId
   * @param {string} content
   * @param {string} rawResponse
   * @returns {Object} Mensagem criada
   */
   createAssistantMessage(conversationId, content, rawResponse, toolCalls = null) {
     const stmt = this.connection.prepare(`
       INSERT INTO messages (conversation_id, role, content, raw_response, tool_calls, status, created_at)
       VALUES (?, 'assistant', ?, ?, ?, 'completed', CURRENT_TIMESTAMP)
     `);
     const result = stmt.run(conversationId, content || '', rawResponse || null, toolCalls);
     return this.getMessage(result.lastInsertRowid);
   }

  /**
   * Cria uma mensagem de tool.
   * @param {number} conversationId
   * @param {Object} data
   * @returns {Object} Mensagem criada
   */
  createToolMessage(conversationId, data) {
    const stmt = this.connection.prepare(`
      INSERT INTO messages (conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, status, thinking_status, created_at)
      VALUES (?, 'tool', ?, ?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      conversationId,
      data.content || '',
      data.tool_call_id,
      data.tool_name,
      data.tool_args || null,
      data.tool_result || null,
      data.thinking_status || null
    );
    return this.getMessage(result.lastInsertRowid);
  }

  // ===== PROVIDERS CRUD =====

  /**
   * Cria um novo provider.
   * @param {Object} data - Dados do provider.
   * @param {string} data.name - Nome do provider.
   * @param {string} data.api_key - Chave da API.
   * @param {string} data.base_url - URL base.
   * @param {boolean} [data.is_active] - If it is active.
   * @returns {Object} Provider criado com ID.
   */
  createProvider(data) {
    const stmt = this.connection.prepare(`
      INSERT INTO providers (name, api_key, base_url, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const result = stmt.run(data.name, data.api_key, data.base_url, data.is_active ? 1 : 0);
    return this.getProvider(result.lastInsertRowid);
  }

  /**
   * Busca um provider por ID.
   * @param {number} id - ID do provider.
   * @returns {Object|null} Provider encontrado ou null.
   */
  getProvider(id) {
    const stmt = this.connection.prepare(`
      SELECT id, name, api_key, base_url, is_active, created_at, updated_at
      FROM providers
      WHERE id = ?
    `);

    const result = stmt.get(id);
    if (result) {
      result.is_active = Boolean(result.is_active);
    }
    return result || null;
  }

  /**
   * Lista todos os providers.
   * @returns {Array} Array de providers.
   */
  getAllProviders() {
    const stmt = this.connection.prepare(`
      SELECT id, name, api_key, base_url, is_active, created_at, updated_at
      FROM providers
      ORDER BY name ASC
    `);

    const results = stmt.all();
    return results.map(provider => ({
      ...provider,
      is_active: Boolean(provider.is_active),
    }));
  }

  /**
   * Lista providers ativos.
   * @returns {Array} Array de providers ativos.
   */
  getActiveProviders() {
    const stmt = this.connection.prepare(`
      SELECT id, name, api_key, base_url, is_active, created_at, updated_at
      FROM providers
      WHERE is_active = 1
      ORDER BY name ASC
    `);

    const results = stmt.all();
    return results.map(provider => ({
      ...provider,
      is_active: Boolean(provider.is_active),
    }));
  }

  /**
   * Atualiza um provider.
   * @param {number} id - ID do provider.
   * @param {Object} data - Data to update.
   * @returns {Object|null} Updated provider or null if not found.
   */
  updateProvider(id, data) {
    const updates = [];
    const params = [];

    const fields = ['name', 'api_key', 'base_url'];
    for (const field of fields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(data[field]);
      }
    }

    if (data.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(data.is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return this.getProvider(id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const stmt = this.connection.prepare(`
      UPDATE providers
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    const result = stmt.run(...params);
    if (result.changes > 0) {
      return this.getProvider(id);
    }

    return null;
  }

  /**
   * Apaga um provider.
   * @param {number} id - ID do provider.
   * @returns {boolean} True se o provider foi apagado.
   */
  deleteProvider(id) {
    const stmt = this.connection.prepare('DELETE FROM providers WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Define um provider como ativo, desativando todos os outros.
   * @param {number} id - ID do provider a ativar.
   * @returns {Object|null} Activated provider or null if not found.
   */
  setActiveProvider(id) {
    // First deactivate all
    this.connection.prepare('UPDATE providers SET is_active = 0').run();
    // Then activate the selected one
    return this.updateProvider(id, { is_active: true });
  }

  // ===== SETTINGS CRUD =====

  /**
   * Sets a configuration.
   * @param {string} key - Configuration key.
   * @param {string} value - Configuration value.
   */
  setSetting(key, value) {
    const stmt = this.connection.prepare(`
      INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
    `);
    stmt.run(key, value);
  }

  /**
   * Fetches a configuration by key.
   * @param {string} key - Configuration key.
   * @returns {string|null} Configuration value or null.
   */
  getSetting(key) {
    const stmt = this.connection.prepare(`
      SELECT value FROM settings WHERE key = ?
    `);

    const result = stmt.get(key);
    return result ? result.value : null;
  }

  /**
   * Lists all configurations.
   * @returns {Object} Object with key-value of configurations.
   */
  getAllSettings() {
    const stmt = this.connection.prepare(`
      SELECT key, value FROM settings ORDER BY key ASC
    `);

    const results = stmt.all();
    const settings = {};
    for (const row of results) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  /**
   * Deletes a configuration.
   * @param {string} key - Configuration key.
   * @returns {boolean} True if the configuration was deleted.
   */
  deleteSetting(key) {
    const stmt = this.connection.prepare('DELETE FROM settings WHERE key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  }

  // ===== SANDBOX PATHS CRUD =====

  /**
   * Cria um novo caminho de sandbox.
   * @param {Object} data - Dados do caminho.
   * @param {string} data.path - Caminho absoluto.
   * @param {string} [data.access_mode] - 'read' ou 'write' (default 'read').
   * @returns {Object} Caminho criado com ID.
   */
  createSandboxPath(data) {
    const stmt = this.connection.prepare(`
      INSERT OR IGNORE INTO sandbox_paths (path, access_mode, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(data.path, data.access_mode || 'read');
    return this.getSandboxPath(result.lastInsertRowid);
  }

  /**
   * Busca um caminho de sandbox por ID.
   * @param {number} id - ID do caminho.
   * @returns {Object|null} Caminho encontrado ou null.
   */
  getSandboxPath(id) {
    const stmt = this.connection.prepare(`
      SELECT id, path, access_mode, created_at, updated_at
      FROM sandbox_paths
      WHERE id = ?
    `);
    return stmt.get(id) || null;
  }

  /**
   * Lista todos os caminhos de sandbox.
   * @returns {Array} Array de caminhos.
   */
  getAllSandboxPaths() {
    const stmt = this.connection.prepare(`
      SELECT id, path, access_mode, created_at, updated_at
      FROM sandbox_paths
      ORDER BY path ASC
    `);
    return stmt.all();
  }

  /**
   * Atualiza um caminho de sandbox.
   * @param {number} id - ID do caminho.
   * @param {Object} data - Data to update.
   * @param {string} [data.path] - Novo caminho.
   * @param {string} [data.access_mode] - Novo modo de acesso.
   * @returns {Object|null} Updated path or null if not found.
   */
  updateSandboxPath(id, data) {
    const updates = [];
    const params = [];

    if (data.path !== undefined) {
      updates.push('path = ?');
      params.push(data.path);
    }
    if (data.access_mode !== undefined) {
      updates.push('access_mode = ?');
      params.push(data.access_mode);
    }

    if (updates.length === 0) {
      return this.getSandboxPath(id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const stmt = this.connection.prepare(`
      UPDATE sandbox_paths
      SET ${updates.join(', ')}
      WHERE id = ?
    `);
    const result = stmt.run(...params);
    if (result.changes > 0) {
      return this.getSandboxPath(id);
    }
    return null;
  }

  /**
   * Apaga um caminho de sandbox.
   * @param {number} id - ID do caminho.
   * @returns {boolean} True se o caminho foi apagado.
   */
  deleteSandboxPath(id) {
    const stmt = this.connection.prepare('DELETE FROM sandbox_paths WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ===== AUTO APPROVAL RULES =====

  createAutoApprovalRule(data) {
    const existing = this.getAutoApprovalRuleByHash(data.rule_hash);
    if (existing) {
      return existing;
    }

    const stmt = this.connection.prepare(`
      INSERT INTO auto_approval_rules (command_name, rule_hash, rule_json, created_at, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    const result = stmt.run(
      data.command_name,
      data.rule_hash,
      data.rule_json
    );

    return this.getAutoApprovalRule(result.lastInsertRowid);
  }

  getAutoApprovalRule(id) {
    const stmt = this.connection.prepare(`
      SELECT id, command_name, rule_hash, rule_json, created_at, updated_at
      FROM auto_approval_rules
      WHERE id = ?
    `);

    return stmt.get(id) || null;
  }

  getAutoApprovalRuleByHash(ruleHash) {
    const stmt = this.connection.prepare(`
      SELECT id, command_name, rule_hash, rule_json, created_at, updated_at
      FROM auto_approval_rules
      WHERE rule_hash = ?
    `);

    return stmt.get(ruleHash) || null;
  }

  getAutoApprovalRulesByCommand(commandName) {
    const stmt = this.connection.prepare(`
      SELECT id, command_name, rule_hash, rule_json, created_at, updated_at
      FROM auto_approval_rules
      WHERE command_name = ?
      ORDER BY created_at ASC
    `);

    return stmt.all(commandName);
  }

  countAutoApprovalRulesByCommand(commandName) {
    const stmt = this.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM auto_approval_rules
      WHERE command_name = ?
    `);

    return stmt.get(commandName)?.count || 0;
  }

  // ===== PENDING APPROVALS CRUD =====

  /**
   * Creates a new pending approval.
   * @param {Object} data - Pending approval data.
   * @param {string} data.tool_call_id - ID da chamada de ferramenta.
   * @param {number} data.conversation_id - ID da conversa.
   * @param {string} data.command - Comando a executar.
   * @param {string} [data.cwd] - Working directory.
   * @param {string} [data.tool_name] - Nome da ferramenta.
   * @param {string} [data.tool_args] - Argumentos da ferramenta.
   * @returns {Object} Pending approval created with ID.
   */
  createPendingApproval(data) {
    // Close any existing open approval with the same tool_call_id first
    this.closePendingApprovalByToolCallId(data.tool_call_id, 'superseded');

    // Use INSERT OR REPLACE to handle the case where a closed row with the
    // same tool_call_id already exists (UNIQUE constraint on tool_call_id)
    const stmt = this.connection.prepare(`
      INSERT OR REPLACE INTO pending_approvals (tool_call_id, conversation_id, command, cwd, tool_name, tool_args, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      data.tool_call_id,
      data.conversation_id,
      data.command,
      data.cwd || null,
      data.tool_name || null,
      data.tool_args || null,
      data.expires_at || null
    );

    return this.getPendingApproval(result.lastInsertRowid);
  }

  /**
   * Fetches a pending approval by ID.
   * @param {number} id - Pending approval ID.
   * @returns {Object|null} Found pending approval or null.
   */
  getPendingApproval(id) {
    const stmt = this.connection.prepare(`
      SELECT id, tool_call_id, conversation_id, command, cwd, tool_name, tool_args,
             expires_at, closed_at, close_reason, created_at, updated_at
      FROM pending_approvals
      WHERE id = ?
    `);

    return stmt.get(id) || null;
  }

  getPendingApprovalByToolCallId(toolCallId) {
    const stmt = this.connection.prepare(`
      SELECT id, tool_call_id, conversation_id, command, cwd, tool_name, tool_args,
             expires_at, closed_at, close_reason, created_at, updated_at
      FROM pending_approvals
      WHERE tool_call_id = ?
    `);

    return stmt.get(toolCallId) || null;
  }

  /**
   * Lists pending approvals of a conversation.
   * @param {number} conversationId - ID da conversa.
   * @returns {Array} Array of pending approvals.
   */
  getPendingApprovalsByConversation(conversationId, options = {}) {
    const includeClosed = options.includeClosed === true;
    const stmt = this.connection.prepare(`
      SELECT id, tool_call_id, conversation_id, command, cwd, tool_name, tool_args,
             expires_at, closed_at, close_reason, created_at, updated_at
      FROM pending_approvals
      WHERE conversation_id = ?
        AND (
          ? = 1
          OR (
            closed_at IS NULL
            AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
          )
        )
      ORDER BY created_at ASC
    `);

    return stmt.all(conversationId, includeClosed ? 1 : 0);
  }

  closePendingApprovalByToolCallId(toolCallId, closeReason = 'handled') {
    const stmt = this.connection.prepare(`
      UPDATE pending_approvals
      SET closed_at = CURRENT_TIMESTAMP,
          close_reason = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE tool_call_id = ?
        AND closed_at IS NULL
    `);
    const result = stmt.run(closeReason, toolCallId);
    return result.changes > 0;
  }

  expirePendingApprovals() {
    const findStmt = this.connection.prepare(`
      SELECT id, tool_call_id, conversation_id, command, cwd, tool_name, tool_args,
             expires_at, closed_at, close_reason, created_at, updated_at
      FROM pending_approvals
      WHERE closed_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at <= CURRENT_TIMESTAMP
      ORDER BY expires_at ASC
    `);
    const closeStmt = this.connection.prepare(`
      UPDATE pending_approvals
      SET closed_at = CURRENT_TIMESTAMP,
          close_reason = 'expired',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND closed_at IS NULL
    `);

    const tx = this.connection.transaction(() => {
      const approvals = findStmt.all();
      const expired = [];

      for (const approval of approvals) {
        const result = closeStmt.run(approval.id);
        if (result.changes > 0) {
          expired.push({
            ...approval,
            close_reason: 'expired'
          });
        }
      }

      return expired;
    });

    return tx();
  }

  /**
   * Deletes a pending approval.
   * @param {number} id - Pending approval ID.
   * @returns {boolean} True if the approval was deleted.
   */
  deletePendingApproval(id) {
    const stmt = this.connection.prepare('DELETE FROM pending_approvals WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Atualiza o timestamp updated_at de uma conversa.
   * @param {number} id - ID da conversa.
   * @returns {Object|null} Updated conversation or null if not found.
   */
  updateConversationTimestamp(id) {
    const stmt = this.connection.prepare(`
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const result = stmt.run(id);
    if (result.changes > 0) {
      return this.getConversation(id);
    }

    return null;
  }

  /**
   * Atualiza o timestamp updated_at de um projeto.
   * @param {number} id - Project ID.
   * @returns {Object|null} Updated project or null if not found.
   */
  updateProjectTimestamp(id) {
    const stmt = this.connection.prepare(`
      UPDATE projects
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const result = stmt.run(id);
    if (result.changes > 0) {
      return this.getProject(id);
    }

    return null;
  }

  // ===== CONVERSATION TASKS =====

  createTask(conversationId, description, parentId = null) {
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2);
    const stmt = this.connection.prepare(`
      INSERT INTO conversation_tasks (id, conversation_id, parent_id, description, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'todo', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    stmt.run(id, conversationId, parentId, description);
    return { id };
  }

  updateTask(id, { status, description, notes }) {
    const fields = [];
    const values = [];
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (notes !== undefined) { fields.push('notes = ?'); values.push(notes); }
    if (fields.length === 0) return null;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    const stmt = this.connection.prepare(`UPDATE conversation_tasks SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...values);
    return result.changes > 0 ? this.getTask(id) : null;
  }

  deleteTask(id) {
    const stmt = this.connection.prepare('DELETE FROM conversation_tasks WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  getTask(id) {
    const stmt = this.connection.prepare('SELECT * FROM conversation_tasks WHERE id = ?');
    return stmt.get(id) || null;
  }

  getTasksByConversation(conversationId) {
    const stmt = this.connection.prepare(`
      SELECT id, parent_id, description, status, notes, created_at, updated_at
      FROM conversation_tasks
      WHERE conversation_id = ?
      ORDER BY created_at
    `);
    return stmt.all(conversationId);
  }

  getTaskTree(conversationId) {
    const tasks = this.getTasksByConversation(conversationId);
    const taskMap = {};
    tasks.forEach(t => { taskMap[t.id] = { ...t, children: [] }; });
    const roots = [];
    tasks.forEach(t => {
      if (t.parent_id && taskMap[t.parent_id]) {
        taskMap[t.parent_id].children.push(taskMap[t.id]);
      } else {
        roots.push(taskMap[t.id]);
      }
    });
    return roots;
  }

  /**
   * Encontra a tool message createFocus associada a um focusId.
   * Usa o tool_result JSON para encontrar a mensagem que criou o focus.
   * @param {number} parentConversationId - ID da conversa pai
   * @param {number} focusId - ID do focus criado
   * @returns {Object|null} Mensagem encontrada ou null
   */
  findCreateFocusToolMessage(parentConversationId, focusId) {
    const stmt = this.connection.prepare(`
      SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, status, processed_at, created_at
      FROM messages
      WHERE conversation_id = ? AND role = 'tool' AND tool_name IN ('createFocus', 'investigate')
      ORDER BY created_at DESC
    `);
    const messages = stmt.all(parentConversationId);
    for (const msg of messages) {
      if (msg.tool_result) {
        try {
          const result = JSON.parse(msg.tool_result);
          if (result.focusId && (Number(result.focusId) === Number(focusId) || String(result.focusId) === String(focusId))) {
            return msg;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  // ===== FOCUS RUNTIME =====

  getFocusRuntimeState(conversationId) {
    const { deserializeRuntimeState } = require('../focusRuntime/store');
    const stmt = this.connection.prepare('SELECT * FROM focus_runtime_states WHERE conversation_id = ?');
    return deserializeRuntimeState(stmt.get(conversationId) || null);
  }

  createFocusRuntimeState(data) {
    const { serializeRuntimeState } = require('../focusRuntime/store');
    const row = serializeRuntimeState(data);
    const stmt = this.connection.prepare(`
      INSERT INTO focus_runtime_states (
        conversation_id, parent_conversation_id, root_conversation_id, owner, phase, tool_mode,
        report_status, active_child_focus_id, blocked_by_focus_id, initial_budget,
        remaining_turns, turns_used, current_turn_id, trigger_message_id, pending_action,
        pending_action_payload, provider_state, operation_id, last_ai_message_id,
        last_tool_message_id, error_json, metadata_json, phase_entered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    stmt.run(
      row.conversation_id,
      row.parent_conversation_id || null,
      row.root_conversation_id || null,
      row.owner,
      row.phase,
      row.tool_mode,
      row.report_status,
      row.active_child_focus_id || null,
      row.blocked_by_focus_id || null,
      row.initial_budget ?? null,
      row.remaining_turns ?? null,
      row.turns_used ?? 0,
      row.current_turn_id || null,
      row.trigger_message_id || null,
      row.pending_action || null,
      row.pending_action_payload,
      row.provider_state,
      row.operation_id || null,
      row.last_ai_message_id || null,
      row.last_tool_message_id || null,
      row.error_json,
      row.metadata_json,
      row.phase_entered_at || null
    );
    return this.getFocusRuntimeState(row.conversation_id);
  }

  updateFocusRuntimeState(conversationId, patch) {
    const { serializeRuntimeState } = require('../focusRuntime/store');
    const row = serializeRuntimeState(patch);
    const allowed = ['parent_conversation_id', 'root_conversation_id', 'owner', 'phase', 'tool_mode', 'report_status', 'active_child_focus_id', 'blocked_by_focus_id', 'initial_budget', 'remaining_turns', 'turns_used', 'current_turn_id', 'trigger_message_id', 'pending_action', 'pending_action_payload', 'provider_state', 'operation_id', 'last_ai_message_id', 'last_tool_message_id', 'error_json', 'metadata_json', 'phase_entered_at'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        fields.push(`${key} = ?`);
        values.push(row[key]);
      }
    }
    if (fields.length === 0) return this.getFocusRuntimeState(conversationId);
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(conversationId);
    const stmt = this.connection.prepare(`UPDATE focus_runtime_states SET ${fields.join(', ')} WHERE conversation_id = ?`);
    const result = stmt.run(...values);
    return result.changes > 0 ? this.getFocusRuntimeState(conversationId) : null;
  }

  appendFocusRuntimeEvent(data) {
    const { serializeRuntimeEvent } = require('../focusRuntime/store');
    const row = serializeRuntimeEvent(data);
    const stmt = this.connection.prepare(`
      INSERT INTO focus_runtime_events (conversation_id, from_phase, event, to_phase, turn_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(row.conversation_id, row.from_phase || null, row.event, row.to_phase, row.turn_id || null, row.payload_json);
    return this.connection.prepare('SELECT * FROM focus_runtime_events WHERE id = ?').get(result.lastInsertRowid);
  }

  listFocusRuntimeStatesByOwner(owner) {
    const { deserializeRuntimeState } = require('../focusRuntime/store');
    return this.connection.prepare('SELECT * FROM focus_runtime_states WHERE owner = ? ORDER BY updated_at DESC').all(owner).map(deserializeRuntimeState);
  }

  listPendingFocusRuntimeActions() {
    const { deserializeRuntimeState } = require('../focusRuntime/store');
    return this.connection.prepare('SELECT * FROM focus_runtime_states WHERE pending_action IS NOT NULL ORDER BY updated_at ASC').all().map(deserializeRuntimeState);
  }

  listNonTerminalFocusRuntimeStates() {
    const { deserializeRuntimeState } = require('../focusRuntime/store');
    return this.connection.prepare("SELECT * FROM focus_runtime_states WHERE phase NOT IN ('completed','cancelled','failed') ORDER BY updated_at ASC").all().map(deserializeRuntimeState);
  }

  // ===== SCHEDULED RETRIES (Camada 2 helpers) =====

  upsertScheduledRetry(conversationId, dueAt, reason) {
    const stmt = this.connection.prepare(`
      INSERT INTO scheduled_retries (conversation_id, due_at, reason, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(conversation_id) DO UPDATE SET due_at = excluded.due_at, reason = excluded.reason, updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(conversationId, dueAt, reason || 'retry');
    return { conversation_id: conversationId, due_at: dueAt, reason };
  }

  getDueScheduledRetries(now) {
    const stmt = this.connection.prepare('SELECT conversation_id, due_at, reason FROM scheduled_retries WHERE due_at <= ?');
    return stmt.all(now);
  }

  removeScheduledRetry(conversationId) {
    const stmt = this.connection.prepare('DELETE FROM scheduled_retries WHERE conversation_id = ?');
    stmt.run(conversationId);
  }

  // =====================================================================
  // PROCESSING STATE MANAGEMENT (Novo sistema)
  // =====================================================================

  /**
   * Atomic transition: claim of the next conversation in 'queued' or 'tool_results'.
   * Uses an SQL transaction to ensure only one worker wins.
   * @param {number} [providerId] - Opcional. If provided, only claims conversations from this provider.
   * @returns {Object|null} The claimed conversation, or null if none.
   */
  claimNextQueuedConversation(providerId) {
    const claimTx = this.connection.transaction(() => {
      // Fetch the next claimable conversation, excluding busy providers
      let query = `
        SELECT c.* FROM conversations c
        WHERE c.processing_state IN ('queued', 'tool_results')
          AND (
            c.active_focus_id IS NULL
            OR EXISTS (SELECT 1 FROM conversations f WHERE f.id = c.active_focus_id AND f.focus_report IS NOT NULL)
          )
      `;
      const params = [];

      if (providerId) {
        // Excluir providers ocupados (a menos que seja este provider)
        query += ` AND (
          c.provider_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM providers p WHERE p.id = c.provider_id AND p.busy_conversation_id IS NOT NULL AND p.busy_conversation_id != c.id)
        )`;
      }

      query += ` ORDER BY c.updated_at ASC LIMIT 1`;

      const conv = this.connection.prepare(query).get(...params);
      if (!conv) return null;

      // Atomic transition: only claims if still in 'queued' or 'tool_results'
      const updateStmt = this.connection.prepare(`
        UPDATE conversations SET processing_state = 'sending', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND processing_state IN ('queued', 'tool_results')
      `);
      const result = updateStmt.run(conv.id);
      if (result.changes === 0) return null; // another worker already claimed

      return this.getConversation(conv.id);
    });

    return claimTx();
  }

  /**
   * Atualiza o processing_state de uma conversa.
   * @param {number} conversationId
   * @param {string} state - Um dos PROCESSING_STATES
   * @returns {Object|null}
   */
  updateProcessingState(conversationId, state) {
    const stmt = this.connection.prepare(`
      UPDATE conversations SET processing_state = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const result = stmt.run(state, conversationId);
    if (result.changes > 0) {
      return this.getConversation(conversationId);
    }
    return null;
  }

  /**
   * Atualiza a phase de uma conversa (controlada pelo protocolo).
   * @param {number} conversationId
   * @param {string} phase
   * @returns {Object|null}
   */
  updatePhase(conversationId, phase) {
    const stmt = this.connection.prepare(`
      UPDATE conversations SET phase = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const result = stmt.run(phase, conversationId);
    if (result.changes > 0) {
      return this.getConversation(conversationId);
    }
    return null;
  }

  /**
   * Updates processing_state + phase in a single operation.
   * @param {number} conversationId
   * @param {string} processingState
   * @param {string} phase
   * @returns {Object|null}
   */
  updateProcessingStateAndPhase(conversationId, processingState, phase) {
    const stmt = this.connection.prepare(`
      UPDATE conversations SET processing_state = ?, phase = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const result = stmt.run(processingState, phase, conversationId);
    if (result.changes > 0) {
      return this.getConversation(conversationId);
    }
    return null;
  }

  /**
   * Updates processing_state, phase, max_iterations and focus_report in a single operation.
   * @param {number} conversationId
   * @param {Object} data - { processing_state?, phase?, max_iterations?, focus_report? }
   * @returns {Object|null}
   */
  updateConversationState(conversationId, data) {
    const updates = [];
    const params = [];

    if (data.processing_state !== undefined) {
      updates.push('processing_state = ?');
      params.push(data.processing_state);
    }
    if (data.phase !== undefined) {
      updates.push('phase = ?');
      params.push(data.phase);
    }
    if (data.max_iterations !== undefined) {
      updates.push('max_iterations = ?');
      params.push(data.max_iterations);
    }
    if (data.focus_report !== undefined) {
      updates.push('focus_report = ?');
      params.push(data.focus_report);
    }

    if (updates.length === 0) {
      return this.getConversation(conversationId);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(conversationId);

    const stmt = this.connection.prepare(`
      UPDATE conversations
      SET ${updates.join(', ')}
      WHERE id = ?
    `);
    const result = stmt.run(...params);
    if (result.changes > 0) {
      return this.getConversation(conversationId);
    }
    return null;
  }

  /**
   * Busca conversas por processing_state.
   * @param {string|string[]} states
   * @returns {Array}
   */
  getConversationsByProcessingState(states) {
    const stateList = Array.isArray(states) ? states : [states];
    const placeholders = stateList.map(() => '?').join(',');
    const stmt = this.connection.prepare(`
      SELECT c.*, p.name AS project_name, p.folder_path
      FROM conversations c
      JOIN projects p ON p.id = c.project_id
      WHERE c.processing_state IN (${placeholders})
      ORDER BY c.updated_at ASC
    `);
    return stmt.all(...stateList);
  }

  /**
   * Busca conversas por phase + processing_state.
   * @param {string} phase
   * @param {string|string[]} states
   * @returns {Array}
   */
  getConversationsByPhaseAndState(phase, states) {
    const stateList = Array.isArray(states) ? states : [states];
    const placeholders = stateList.map(() => '?').join(',');
    const stmt = this.connection.prepare(`
      SELECT c.*, p.name AS project_name, p.folder_path
      FROM conversations c
      JOIN projects p ON p.id = c.project_id
      WHERE c.phase = ? AND c.processing_state IN (${placeholders})
      ORDER BY c.updated_at ASC
    `);
    return stmt.all(phase, ...stateList);
  }

  /**
   * Marca uma conversa como 'queued' (pronta para processar).
   * @param {number} conversationId
   * @returns {Object|null}
   */
  markConversationAsQueued(conversationId) {
    return this.updateProcessingState(conversationId, 'queued');
  }

  /**
   * Marca uma conversa como 'idle' (parada).
   * @param {number} conversationId
   * @returns {Object|null}
   */
  markConversationAsIdle(conversationId) {
    return this.updateProcessingState(conversationId, 'idle');
  }

  // =====================================================================
  // AI TURN SCHEDULING (ConversationManager integration)
  // =====================================================================

  /**
   * Get conversations that need AI processing based on last_sent_ai_msg_id.
   * A conversation needs processing when last_sent_ai_msg_id is null (never processed)
   * or doesn't match the current last message.
   * Results are ordered by reference date (oldest first):
   *   - if last_sent_ai_msg_id is set, use that message's created_at
   *   - if null, use the first message's created_at
   * @returns {Array}
   */
  getConversationsNeedingAi() {
    const stmt = this.connection.prepare(`
      SELECT c.*,
        COALESCE(
          (SELECT m3.created_at FROM messages m3 WHERE m3.id = c.last_sent_ai_msg_id),
          (SELECT m4.created_at FROM messages m4 WHERE m4.conversation_id = c.id ORDER BY m4.created_at ASC, m4.id ASC LIMIT 1)
        ) AS reference_date
      FROM conversations c
      WHERE
        (c.last_sent_ai_msg_id IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id))
        OR
        (c.last_sent_ai_msg_id IS NOT NULL AND c.last_sent_ai_msg_id != (
          SELECT m2.id FROM messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1
        ))
      ORDER BY reference_date ASC
    `);
    return stmt.all();
  }

  /**
   * Get the message referenced by last_sent_ai_msg_id.
   * @param {number} conversationId
   * @returns {Object|null}
   */
  getLastSentAiMessage(conversationId) {
    const stmt = this.connection.prepare(`
      SELECT m.* FROM messages m
      WHERE m.id = (SELECT last_sent_ai_msg_id FROM conversations WHERE id = ?)
    `);
    return stmt.get(conversationId) || null;
  }

  /**
   * Update last_sent_ai_msg_id for a conversation.
   * @param {number} conversationId
   * @param {number} messageId
   * @returns {boolean}
   */
  updateLastSentAiMessage(conversationId, messageId) {
    const stmt = this.connection.prepare(`
      UPDATE conversations SET last_sent_ai_msg_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const result = stmt.run(messageId, conversationId);
    return result.changes > 0;
  }

  // =====================================================================
  // PROVIDER BUSY MANAGEMENT
  // =====================================================================

  /**
   * Gets the ID of the conversation occupying a provider.
   * @param {number} providerId
   * @returns {number|null}
   */
  getProviderBusyConversation(providerId) {
    const stmt = this.connection.prepare('SELECT busy_conversation_id FROM providers WHERE id = ?');
    const row = stmt.get(providerId);
    return row ? row.busy_conversation_id : null;
  }

  /**
   * Marca um provider como ocupado com uma conversa.
   * @param {number} providerId
   * @param {number} conversationId
   */
  setProviderBusy(providerId, conversationId) {
    const stmt = this.connection.prepare(`
      UPDATE providers SET busy_conversation_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(conversationId, providerId);
  }

  /**
   * Frees a provider (no longer occupied).
   * @param {number} providerId
   */
  clearProviderBusy(providerId) {
    const stmt = this.connection.prepare(`
      UPDATE providers SET busy_conversation_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(providerId);
  }

  // =====================================================================
  // CONVERSATION TOKEN USAGE (Metrics and context — Phase D)
  // =====================================================================

  /**
   * Records the token usage of an AI call. Never deleted by clear.
   * @param {Object} data - { conversation_id, model, prompt_tokens, completion_tokens, cost_usd? }
   */
  recordTokenUsage(data) {
    const stmt = this.connection.prepare(`
      INSERT INTO conversation_token_usage (conversation_id, model, prompt_tokens, completion_tokens, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      data.conversation_id,
      data.model || null,
      Number(data.prompt_tokens) || 0,
      Number(data.completion_tokens) || 0,
      data.cost_usd != null ? Number(data.cost_usd) : null
    );
    return result.lastInsertRowid;
  }

  /**
   * Gets the IDs of all descendant conversations (recursive via parent_id),
   * including the conversation itself.
   * @param {number} conversationId
   * @returns {number[]}
   */
  getConversationSubtreeIds(conversationId) {
    const ids = new Set([Number(conversationId)]);
    let frontier = [Number(conversationId)];
    while (frontier.length > 0) {
      const placeholders = frontier.map(() => '?').join(',');
      const children = this.connection.prepare(
        `SELECT id FROM conversations WHERE parent_id IN (${placeholders})`
      ).all(...frontier);
      frontier = children.map(c => Number(c.id)).filter(id => !ids.has(id));
      for (const id of frontier) ids.add(id);
    }
    return Array.from(ids);
  }

  /**
   * Total de uso de tokens de uma conversa incluindo descendentes.
   * For MAIN it gives the global total (delegated work included); for a focus,
   * gives the total of its own subtree.
   * @param {number} conversationId
   * @returns {Object} { total_prompt_tokens, total_completion_tokens, total_tokens, total_cost_usd, call_count, models }
   */
  getConversationTokenUsage(conversationId) {
    const subtreeIds = this.getConversationSubtreeIds(conversationId);
    if (subtreeIds.length === 0) {
      return { total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, total_cost_usd: null, call_count: 0, models: [] };
    }
    const placeholders = subtreeIds.map(() => '?').join(',');
    const row = this.connection.prepare(`
      SELECT
        COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
        SUM(cost_usd) AS total_cost_usd,
        COUNT(*) AS call_count
      FROM conversation_token_usage
      WHERE conversation_id IN (${placeholders})
    `).get(...subtreeIds);

    const models = this.connection.prepare(`
      SELECT DISTINCT model FROM conversation_token_usage
      WHERE conversation_id IN (${placeholders}) AND model IS NOT NULL AND model != ''
      ORDER BY model
    `).all(...subtreeIds).map(r => r.model);

    return {
      total_prompt_tokens: Number(row?.total_prompt_tokens) || 0,
      total_completion_tokens: Number(row?.total_completion_tokens) || 0,
      total_tokens: Number(row?.total_tokens) || 0,
      total_cost_usd: row?.total_cost_usd != null ? Number(row.total_cost_usd) : null,
      call_count: Number(row?.call_count) || 0,
      models,
    };
  }

  // =====================================================================
  // CONVERSATION EVENTS (debugging)
  // =====================================================================

  /**
   * Regista um evento de conversa para debugging.
   * @param {Object} data
   * @param {number} data.conversation_id
   * @param {string} data.event
   * @param {string} [data.from_processing_state]
   * @param {string} [data.to_processing_state]
   * @param {string} [data.from_phase]
   * @param {string} [data.to_phase]
   * @param {string} [data.payload_json]
   */
  createConversationEvent(data) {
    try {
      const stmt = this.connection.prepare(`
        INSERT INTO conversation_events (conversation_id, event, from_processing_state, to_processing_state, from_phase, to_phase, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        data.conversation_id,
        data.event,
        data.from_processing_state || null,
        data.to_processing_state || null,
        data.from_phase || null,
        data.to_phase || null,
        data.payload_json || null
      );
    } catch (_) {
      // Table may not exist yet; ignore
    }
  }
}

module.exports = {
  DatabaseAPI,
};