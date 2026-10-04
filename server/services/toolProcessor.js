'use strict';

const { MESSAGE_STATES, FINAL_MESSAGE_STATES, PROCESSING_STATES } = require('../constants/processingStates');
const { executeTool } = require('../tools');
const { runShellCommand } = require('./shellExecutor');
const { safeSerializeToolResult } = require('../controllers/toolUtils');
const { createTaskTreeTools } = require('../tools/taskTreeTools');
const path = require('path');

/**
 * ToolProcessor — Processes tool messages asynchronously.
 *
 * Flow:
 * 1. trigger() is called after creating pending tool messages (in ConversationManager)
 * 2. _process() atomically claims pending tools and executes handlers
 * 3. When each tool finishes, it calls conversationManager.handleToolResult()
 *    which updates the DB, broadcasts, and checks if all tools completed.
 */
class ToolProcessor {
  constructor(db, socketService) {
    this.db = db;
    this.socketService = socketService;
    this.conversationManager = null;
    this.running = false;
    this._restartNeeded = false;
  }

  setConversationManager(cm) {
    this.conversationManager = cm;
  }

  /**
   * Trigger to process pending tools.
   * Uses setImmediate to not block the caller.
   */
  trigger() {
    if (this.running) {
      this._restartNeeded = true;
      return;
    }
    this._restartNeeded = false;
    setImmediate(() => this._process());
  }

  /**
   * Processes all pending tool messages.
   * Atomic claim → executes handler → passes result to ConversationManager.
   */
  async _process() {
    if (this.running) return;
    this.running = true;

    try {
      let safety = 0;
      do {
        if (safety > 0) {
          this._restartNeeded = false;
        }
        safety++;

        let hasWork = true;
        while (hasWork) {
          const toolMsg = this.db.claimNextPendingToolMessage();
          if (!toolMsg) {
            hasWork = false;
            break;
          }

          // Broadcast status update (pending → processing)
          this.socketService.broadcastToConversation(toolMsg.conversation_id, 'message', toolMsg);

          try {
            await this._executeToolHandler(toolMsg);
          } catch (err) {
            console.error(`[ToolProcessor] Error processing tool message ${toolMsg.id}:`, err);
            // Pass error to ConversationManager
            if (this.conversationManager) {
              await this.conversationManager.handleToolResult(
                toolMsg.conversation_id, toolMsg.id, null, err
              );
            }
          }
        }

        if (this._restartNeeded && safety >= 10) {
          console.warn('[ToolProcessor] Safety limit reached, restarting...');
        }
      } while (this._restartNeeded && safety < 10);
    } catch (err) {
      console.error('[ToolProcessor] Error in _process:', err);
    } finally {
      this.running = false;
    }
  }

  /**
   * Executes the specific handler for each tool.
   * At the end, calls conversationManager.handleToolResult().
   */
  async _executeToolHandler(toolMsg) {
    const toolName = toolMsg.tool_name;
    const conversationId = toolMsg.conversation_id;
    let toolArgs = {};
    try {
      toolArgs = JSON.parse(toolMsg.tool_args || '{}');
    } catch (_) {}

    const conv = this.db.getConversation(conversationId);
    const workingDir = conv?.worktree_path || conv?.repo_root;
    if (!workingDir) {
      throw new Error(`Cannot execute tool for conversation ${conversationId}: no worktree_path or repo_root set.`);
    }

    const context = {
      conversationId,
    };

    // Plan mode enforcement: block write-capable tools at the processor level so even
    // if a tool call slips through definitions filtering, the worktree stays read-only.
    // runCommand is allowed in plan mode: it always runs sandboxed with the worktree
    // mounted read-only (readOnlyWorktree in _handleRunCommand), so writes are blocked
    // by bwrap at the filesystem level.
    const writeTools = new Set([
      'writeFile', 'editFile', 'moveFile', 'deleteFile', 'createDirectory', 'copyFile'
    ]);
    if (conv?.mode === 'plan' && writeTools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is disabled in plan mode.`);
    }

    let result;

    // Special tools with their own async flow
    if (toolName === 'runCommand') {
      result = await this._handleRunCommand(toolMsg, toolArgs, workingDir, conversationId);
    } else if (toolName === 'investigate') {
      result = await executeTool(toolName, toolArgs, workingDir, context, conversationId);
    } else if (toolName === 'submitFindings') {
      result = await executeTool(toolName, toolArgs, workingDir, context, conversationId);
    } else {
      result = await executeTool(toolName, toolArgs, workingDir, context, conversationId);
    }

    // Pass result to ConversationManager to update DB and state
    if (this.conversationManager) {
      await this.conversationManager.handleToolResult(conversationId, toolMsg.id, result, null);
    }

    if (
      ['addTodo', 'updateTodo', 'removeTodo', 'getTaskTree'].includes(toolName) &&
      conversationId
    ) {
      try {
        const taskTree = await createTaskTreeTools(conversationId).getTaskTree.handler();
        this.socketService.broadcastToConversation(conversationId, 'taskTreeUpdated', {
          conversationId,
          tree: taskTree
        });
      } catch (taskTreeError) {
        console.error('[ToolProcessor] Failed to emit taskTreeUpdated:', taskTreeError);
      }
    }

    if (toolName === 'updatePlan' && conversationId) {
      try {
        const { createPlanTools } = require('../tools/planTools');
        const planTools = createPlanTools(conversationId);
        const planResult = await planTools.getPlan.handler();
        this.socketService.broadcastToConversation(conversationId, 'planUpdated', {
          conversationId,
          plan: planResult && planResult.plan != null ? planResult.plan : null
        });
      } catch (planError) {
        console.error('[ToolProcessor] Failed to emit planUpdated:', planError);
      }
    }
  }

  /**
   * Loads the configured sandbox paths from the DB.
   * @returns {Array<{path: string, writable: boolean}>}
   */
  _getSandboxExtraPaths() {
    try {
      const rows = this.db.getAllSandboxPaths();
      return (rows || []).map(row => ({
        path: row.path,
        writable: row.access_mode === 'write'
      }));
    } catch (err) {
      console.error('[ToolProcessor] Failed to load sandbox paths:', err);
      return [];
    }
  }

  /**
   * Returns the sandbox paths marked to be exported into the command PATH
   * (export_to_path = 1).
   * @returns {Array<string>} Absolute paths.
   */
  _getExportToPathPaths() {
    try {
      const rows = this.db.getAllSandboxPaths();
      return (rows || [])
        .filter(row => Number(row.export_to_path) === 1)
        .map(row => row.path);
    } catch (err) {
      console.error('[ToolProcessor] Failed to load export-to-PATH paths:', err);
      return [];
    }
  }

  /**
   * Returns every configured sandbox path (regardless of the export flag).
   * @returns {Array<string>} Absolute paths.
   */
  _getConfiguredSandboxPaths() {
    try {
      const rows = this.db.getAllSandboxPaths();
      return (rows || []).map(row => row.path).filter(Boolean);
    } catch (err) {
      console.error('[ToolProcessor] Failed to load sandbox paths:', err);
      return [];
    }
  }

  /**
   * Builds the environment for a runCommand execution.
   *
   * The `PATH` is derived from the process env but the "Export to PATH" flag is
   * authoritative: a configured sandbox path that is NOT marked for export is
   * removed from the inherited PATH, then the exported paths are appended.
   * Without this, a path that already exists in the host PATH (e.g. ~/.deno/bin)
   * would always be visible and toggling the flag would appear to do nothing.
   * Standard system directories are never removed.
   *
   * @returns {Object} Environment map passed to spawn/bwrap.
   */
  _buildRunEnv() {
    const exported = this._getExportToPathPaths();
    const exportedSet = new Set(exported);
    const configured = new Set(this._getConfiguredSandboxPaths());

    const systemPaths = new Set([
      '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin',
      '/sbin', '/bin', '/usr/games', '/usr/local/games', '/snap/bin'
    ]);

    const merged = (process.env.PATH || '')
      .split(':')
      .filter(Boolean)
      .filter(p => !configured.has(p) || exportedSet.has(p) || systemPaths.has(p));

    for (const p of exported) {
      if (p && !merged.includes(p)) {
        merged.push(p);
      }
    }

    return { ...process.env, PATH: merged.join(':') };
  }

  /**
   * Special handler for runCommand.
   *
   * runCommand always executes inside the sandbox (bubblewrap). There is no
   * approval / auto-approval flow anymore: the worktree is mounted read-only
   * for plan mode and for focus/subbot/project conversations, and extra access
   * is controlled by the configured sandbox paths.
   */
  async _handleRunCommand(toolMsg, toolArgs, workingDir, conversationId) {
    const command = toolArgs.command || '';
    const cwd = workingDir;
    const timeout = toolArgs.timeout || 0;

    const conv = this.db.getConversation(conversationId);
    const repoRoot = conv?.repo_root;
    const worktreePath = conv?.worktree_path;

    // Sandbox is mandatory - always enabled
    const sandboxOpts = {
      enabled: true,
      repoRoot,
      worktreePath: worktreePath || repoRoot,
      readOnlyWorktree: conv && ['focus', 'subbot', 'project'].includes(conv.conversation_type) || conv?.mode === 'plan',
      extraPaths: this._getSandboxExtraPaths(),
      env: this._buildRunEnv()
    };

    // Outer timeout: timeout + 30s buffer, or 5min if no timeout specified
    const maxTimeout = timeout > 0 ? timeout + 30000 : 300000;

    console.log('[ToolProcessor] runCommand', {
      command: command.slice(0, 120),
      conversationId,
      readOnlyWorktree: sandboxOpts.readOnlyWorktree,
      timeout
    });

    this.socketService.broadcastToolStart(conversationId, 'runCommand', toolArgs, toolMsg.tool_call_id);
    let result;
    try {
      result = await Promise.race([
        runShellCommand(command, cwd, timeout, sandboxOpts),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Command timeout (outer)')), maxTimeout)
        )
      ]);
      result.sandboxed = true;
    } catch (err) {
      result = {
        stdout: '',
        stderr: err.message || String(err),
        exitCode: 1,
        failed: true,
        sandboxed: true
      };
    }

    this.socketService.broadcastToolEnd(conversationId, 'runCommand', result);
    return result;
  }
}

module.exports = ToolProcessor;