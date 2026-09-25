'use strict';

const { MESSAGE_STATES, FINAL_MESSAGE_STATES, PROCESSING_STATES } = require('../constants/processingStates');
const { executeTool } = require('../tools');
const { runShellCommand } = require('./shellExecutor');
const { safeSerializeToolResult } = require('../controllers/toolUtils');
const { createTaskTreeTools } = require('../tools/taskTreeTools');
const { parseSimpleCommand, findMatchingRule, isSandboxed } = require('./commandApprovalService');
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

    /** @type {Map<string, { toolMessageId: number, conversationId: number, command: string, cwd: string, timeout: number }>} */
    this.pendingApprovalTools = new Map();
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

    let result;

    // Special tools with their own async flow
    if (toolName === 'runCommand') {
      result = await this._handleRunCommand(toolMsg, toolArgs, workingDir, conversationId);
      if (result && result.requiresApproval) {
        return; // Tool stays in 'processing' until user approves/denies
      }
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
   * Special handler for runCommand.
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
      readOnlyWorktree: conv && ['focus', 'subbot', 'project'].includes(conv.conversation_type),
      extraPaths: this._getSandboxExtraPaths()
    };

    const sandboxed = isSandboxed(sandboxOpts);

    const parsedCommand = parseSimpleCommand(command, cwd, workingDir);

    // Outer timeout: timeout + 30s buffer, or 5min if no timeout specified
    const maxTimeout = timeout > 0 ? timeout + 30000 : 300000;

    // If sandboxed, skip auto-approval check and run directly with sandbox
    if (sandboxed) {
      this.socketService.broadcastToolStart(conversationId, 'runCommand', toolArgs, false, toolMsg.tool_call_id);
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

    const autoApprovalRule = findMatchingRule(this.db, parsedCommand, {
      worktreePath: workingDir,
    });

    if (autoApprovalRule) {
      // Auto-aprovado: executa directamente
      this.socketService.broadcastToolStart(conversationId, 'runCommand', toolArgs, false, toolMsg.tool_call_id);
      let result;
      try {
        result = await Promise.race([
          runShellCommand(command, cwd, timeout),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Command timeout (outer)')), maxTimeout)
          )
        ]);
        result.autoApproved = true;
        result.autoApprovalRuleId = autoApprovalRule.id;
      } catch (err) {
        result = {
          stdout: '',
          stderr: err.message || String(err),
          exitCode: 1,
          failed: true,
          autoApproved: true,
          autoApprovalRuleId: autoApprovalRule.id
        };
      }

      this.socketService.broadcastToolEnd(conversationId, 'runCommand', result);
      return result;
    }

    // Needs user approval
    this.socketService.broadcastToolStart(conversationId, 'runCommand', toolArgs, true, toolMsg.tool_call_id);

    const approval = this.db.createPendingApproval({
      tool_call_id: toolMsg.tool_call_id,
      conversation_id: conversationId,
      command,
      cwd,
      tool_name: 'runCommand',
      tool_args: toolMsg.tool_args || '{}',
      expires_at: new Date(Date.now() + 600000).toISOString(), // 10 min
    });

    this.socketService.broadcastCommandApprovalRequired(conversationId, {
      conversationId,
      toolCallId: toolMsg.tool_call_id,
      command,
      cwd,
      expiresAt: approval.expires_at,
      parsedCommand,
    });

    // Store to resolve when user responds (via resolveCommandApproval)
    this.pendingApprovalTools.set(toolMsg.tool_call_id, {
      toolMessageId: toolMsg.id,
      conversationId,
      command,
      cwd,
      timeout,
    });

    return { requiresApproval: true };
  }

  /**
   * Resolves a pending command approval.
   * Called by socketService when the user approves/denies.
   */
  async resolveCommandApproval(toolCallId, approved) {
    const pending = this.pendingApprovalTools.get(toolCallId);
    if (!pending) {
      console.log(`[ToolProcessor] No pending approval for toolCallId=${toolCallId}`);
      return;
    }

    this.pendingApprovalTools.delete(toolCallId);

    try {
      let result;

      if (approved) {
        const conv = this.db.getConversation(pending.conversationId);
        const repoRoot = conv?.repo_root;
        const worktreePath = conv?.worktree_path;
        const sandboxOpts = {
          enabled: true,
          repoRoot,
          worktreePath: worktreePath || repoRoot,
          readOnlyWorktree: conv && ['focus', 'subbot', 'project'].includes(conv.conversation_type),
          extraPaths: this._getSandboxExtraPaths()
        };
        const maxTimeout = pending.timeout > 0 ? pending.timeout + 30000 : 300000;
        result = await Promise.race([
          runShellCommand(pending.command, pending.cwd, pending.timeout, sandboxOpts),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Command timeout (outer)')), maxTimeout)
          )
        ]);
      } else {
        result = {
          stdout: '',
          stderr: 'Command denied by user',
          exitCode: 1,
        };
      }

      // Broadcast tool end
      this.socketService.broadcastToolEnd(pending.conversationId, 'runCommand', result);

      // Passar ao ConversationManager para actualizar BD e estado
      if (this.conversationManager) {
        await this.conversationManager.handleToolResult(
          pending.conversationId, pending.toolMessageId, result, null
        );
      }
    } catch (err) {
      console.error(`[ToolProcessor] Error resolving command approval for ${toolCallId}:`, err);
      if (this.conversationManager) {
        await this.conversationManager.handleToolResult(
          pending.conversationId, pending.toolMessageId, null, err
        );
      }
    }
  }

  /**
   * Cleanup: marca todas as approvals pendentes como erro (para shutdown).
   */
  async cleanup() {
    for (const [toolCallId, pending] of this.pendingApprovalTools) {
      try {
        if (this.conversationManager) {
          await this.conversationManager.handleToolResult(
            pending.conversationId,
            pending.toolMessageId,
            null,
            new Error('Server shutdown')
          );
        }
      } catch (_) {}
    }
    this.pendingApprovalTools.clear();
  }

  cleanupConversation(conversationId) {
    for (const [toolCallId, pending] of this.pendingApprovalTools) {
      if (pending.conversationId == conversationId) {
        this.pendingApprovalTools.delete(toolCallId);
      }
    }
  }
}

module.exports = ToolProcessor;