/**
 * Progress Tracking Service for AI Tool Loop
 * Monitors task progress, detects stagnation, and enables dynamic iteration extension
 */

class ProgressTracker {
  constructor(maxIterations = 20, maxExtensions = 3) {
    this.state = {
      lastProgressIteration: 0,
      consecutiveNoProgress: 0,
      totalProgressScore: 0,
      extendedIterations: 0,
      maxExtensions,
      baseMaxIterations: maxIterations,
      currentMaxIterations: maxIterations,
      history: [], // Track recent actions to detect repetition
      phase: 'planning', // 'planning' or 'execution'
      pressureLevel: 0, // 0, 1, 2 for pressure escalation
      aiReportedProgress: null, // AI reported progress percentage
      totalReads: 0,
      totalWrites: 0
    };
  }

  get currentMaxIterations() {
    return this.state.currentMaxIterations;
  }



  /**
   * Analyze a tool call to determine if it represents real progress
   * @returns {Object} { hasProgress: boolean, score: number, reason: string, isRepeated: boolean }
   */
  analyzeToolCall(toolName, args, result) {
    // Create unique action key
    const actionKey = `${toolName}:${JSON.stringify(args)}`;
    
    // Check if action is repeated
    const isRepeated = this.state.history.includes(actionKey);
    
    let score = 0;
    let hasProgress = false;
    let reason = '';

    switch (toolName) {
      case 'readFile':
      case 'readMultipleFiles':
        if (!isRepeated) {
          score = 1;
          hasProgress = true;
          reason = 'New file read';
        } else {
          score = -1; // Penalty for repetition
          reason = 'File already read previously';
        }
        break;

      case 'writeFile':
      case 'editFile':
      case 'edit':
        score = 3;
        hasProgress = true;
          reason = 'File modified/created';
        break;

      case 'searchInFiles':
      case 'grep':
        if (result && !isRepeated) {
          const hasResults = this._hasSearchResults(result);
          if (hasResults) {
            score = 1;
            hasProgress = true;
            reason = 'Search with useful results';
          } else {
            score = 0;
            reason = 'Search without results';
          }
        } else {
          score = -0.5;
          reason = 'Repeated search';
        }
        break;

      case 'glob':
        if (!isRepeated) {
          score = 0.5;
          hasProgress = true;
          reason = 'Structure exploration';
        } else {
          score = -0.5;
          reason = 'Repeated glob';
        }
        break;

      case 'bash':
        score = 2;
        hasProgress = true;
          reason = 'Command execution';
        break;

      case 'task':
        score = 2;
        hasProgress = true;
          reason = 'Subagent launched';
        break;



      default:
        score = 0;
        reason = `Tool ${toolName}`;
    }

    // Update history (keep last 20 actions)
    this.state.history.push(actionKey);
    if (this.state.history.length > 20) {
      this.state.history.shift();
    }

    return { hasProgress, score, reason, isRepeated };
  }

  /**
   * Update progress state after analyzing a tool call
   * @param {string} toolName - Name of tool called
   * @param {Object} args - Tool arguments
   * @param {any} result - Tool result
   * @param {number} currentIteration - Current iteration number
   * @param {boolean} hasTodoUpdate - Whether response contained todo list update
   * @returns {Object} Update info including whether to extend iterations
   */
   updateProgress(toolName, args, result, currentIteration) {
    const analysis = this.analyzeToolCall(toolName, args, result);

    if (analysis.hasProgress) {
      this.state.totalProgressScore += analysis.score;
      this.state.lastProgressIteration = currentIteration;
      this.state.consecutiveNoProgress = 0;
    } else {
      this.state.consecutiveNoProgress++;
    }

    // Track reads and writes
    if (this.isReadTool(toolName)) {
      this.state.totalReads++;
    } else if (this.isWriteTool(toolName)) {
      this.state.totalWrites++;
      // Transition to execution phase on first write
      if (this.state.phase === 'planning') {
        this.state.phase = 'execution';
        this.resetTaskIterations();
        console.log('Transitioned to EXECUTION phase on first write action');
      }
    }

    // Calculate extra iterations based on write ratio
    const totalActions = this.state.totalReads + this.state.totalWrites;
    const writeRatio = totalActions > 0 ? this.state.totalWrites / totalActions : 0;
    const extraIterations = Math.floor(writeRatio * 2); // 0-2 extra iterations

    // Apply extra iterations if not already extended
    if (extraIterations > this.state.extendedIterations && this.state.extendedIterations < this.state.maxExtensions) {
      const iterationsToAdd = extraIterations - this.state.extendedIterations;
      this.state.currentMaxIterations += iterationsToAdd;
      this.state.extendedIterations = extraIterations;
      console.log(`Granted ${iterationsToAdd} extra iterations based on write ratio ${writeRatio.toFixed(2)}`);
    }

    return {
      ...analysis,
      consecutiveNoProgress: this.state.consecutiveNoProgress,
      totalProgressScore: this.state.totalProgressScore,
      currentMaxIterations: this.state.currentMaxIterations,
      phase: this.state.phase,
      extraIterations
    };
  }

  /**
   * Check if tool is a read tool
   */
  isReadTool(toolName) {
    const readTools = ['readFile', 'readMultipleFiles', 'readFileChunk', 'readFileLines', 'listDirectory', 'getFileTree', 'searchFiles', 'searchInFiles', 'grepInFile', 'getFileInfo', 'semanticSearch'];
    return readTools.includes(toolName);
  }

  /**
   * Check if tool is a write tool
   */
  isWriteTool(toolName) {
    const writeTools = ['writeFile', 'editFile', 'moveFile', 'deleteFile', 'copyFile', 'createDirectory'];
    return writeTools.includes(toolName);
  }



  /**
   * Check if iterations should be extended based on progress
   */
   _shouldExtendIterations(currentIteration) {
     // Only consider extending if close to the current max iterations
     if (currentIteration < this.state.currentMaxIterations - 3) {
       return false;
     }
 
     // Don't extend if max extensions reached
     if (this.state.extendedIterations >= this.state.maxExtensions) {
       return false;
     }
 
     // Only extend if there has been recent progress (e.g., in the last 2 iterations)
     // and the overall progress score is positive.
     // Also, avoid extending if current tasks are blocked and no new path is found.
     const hasRecentProgress = (currentIteration - this.state.lastProgressIteration) <= 2;
     if (!hasRecentProgress || this.state.consecutiveNoProgress > 0 || this.state.totalProgressScore <= 0) {
       return false;
     }
 
     // Extend by 5 iterations
     this.state.currentMaxIterations += 5;
     this.state.extendedIterations++;
     console.log(`Extended iterations. New max: ${this.state.currentMaxIterations}`);
     return true;
   }

  /**
   * Check if we should suggest breaking tasks into smaller ones
   */
  shouldSuggestTaskBreakdown() {
    return this.state.consecutiveNoProgress >= 3;
  }

  /**
   * Detect if there's stagnation in progress
   */
  detectStagnation() {
    const stagnationLevel = this.state.consecutiveNoProgress;

    if (stagnationLevel >= 4) {
      return {
        isStagnant: true,
        level: 'critical',
        message: 'Multiple iterations without real progress. It is crucial to reevaluate the strategy. Break tasks into VERY small and specific subtasks, or ask the user for clarification.'
      };
    } else if (stagnationLevel >= 2) {
      return {
        isStagnant: true,
        level: 'warning',
        message: 'Two iterations without progress. Immediately break tasks into smaller and more specific subtasks. Example: instead of "Implement feature X", break into: "1. Read function Y, 2. Add parameter Z, 3. Test change".'
      };
    }

    return { isStagnant: false, level: 'normal', message: '' };
  }

  /**
   * Generate a final report when hitting iteration limit
   */
   generateReport(finalIteration) {
     const stagnation = this.detectStagnation();
     const report = {
       summary: "",
       completedTasks: [],
       pendingTasks: [],
       inProgressTasks: [],
        reasonForStopping: `Iteration limit (${this.state.currentMaxIterations}) reached at iteration ${finalIteration}.`,
       nextSteps: "",
       statistics: {
         totalIterations: finalIteration,
         maxIterationsAllowed: this.state.baseMaxIterations + (this.state.extendedIterations * 5),
         totalProgressScore: this.state.totalProgressScore,
         extendedIterationsCount: this.state.extendedIterations,
         consecutiveNoProgress: this.state.consecutiveNoProgress,
         stagnationLevel: stagnation.level
       }
     };
 
     // Completed Tasks
     if (this.state.completedTasks.length > 0) {
       report.completedTasks = this.state.completedTasks.map(t => ({
         id: t.id,
         description: t.description,
         completedAt: t.completedAt,
         iterationCompleted: t.iterationCompleted
       }));
        report.summary += `Completed: ${this.state.completedTasks.length} tasks. `;
     }
 
     // Pending Tasks
     if (this.state.pendingTasks.length > 0) {
       report.pendingTasks = this.state.pendingTasks.map(t => ({
         id: t.id,
         description: t.description
       }));
       report.summary += `Pendentes: ${this.state.pendingTasks.length} tarefas. `; 
     }
 
     // In Progress Tasks
     if (this.state.inProgressTasks.length > 0) {
       report.inProgressTasks = this.state.inProgressTasks.map(t => ({
         id: t.id,
         description: t.description
       }));
       report.summary += `Em progresso: ${this.state.inProgressTasks.length} tarefas. `; 
     }
 
     // Next Steps based on stagnation
     if (stagnation.isStagnant) {
       report.summary += `Nota: ${stagnation.message} `; 
       if (stagnation.level === 'warning') {
          report.nextSteps = "Consider reviewing pending tasks and breaking them into smaller subtasks to facilitate progress. Analyze the latest actions to identify blockers.";
       } else if (stagnation.level === 'critical') {
          report.nextSteps = "It is crucial to reevaluate the current strategy. Tasks may be poorly defined or the plan may need a complete review. Look for external blockers or missing information.";
       }
     } else if (this.state.pendingTasks.length > 0 || this.state.inProgressTasks.length > 0) {
        report.nextSteps = "Continue working on pending tasks. If necessary, reevaluate the priority or complexity of upcoming tasks.";
     } else {
        report.nextSteps = "All known tasks have been completed. Check for additional requirements or whether the main objective has been achieved.";
     }
 
     return report;
   }

  /**
   * Get pending tasks sorted by priority (for context compression)
   */
  getPendingTasksForCompression() {
    // Return pending and in-progress tasks
    const relevant = [
      ...this.state.inProgressTasks,
      ...this.state.pendingTasks
    ];

    // Limit to most relevant
    return relevant.slice(0, 10);
  }

  /**
   * Get recently completed tasks (for context compression)
   */
  getRecentCompletedTasks(limit = 5) {
    return this.state.completedTasks
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      .slice(0, limit);
  }

  /**
   * Reset iteration limit for next task
   */
  resetTaskIterations() {
    this.state.taskIterationLimit = this.state.baseMaxIterations;
    this.state.taskIterationsUsed = 0;
    console.log(`Reset task iterations to ${this.state.taskIterationLimit}`);
  }

  /**
   * Check if we should escalate pressure based on current iteration
   * @param {number} currentIteration - Current iteration number
   * @returns {Object} { shouldEscalate: boolean, level: number, message: string }
   */
  checkPressureEscalation(currentIteration) {
    if (this.state.phase !== 'planning') {
      return { shouldEscalate: false, level: this.state.pressureLevel, message: null };
    }

    const third = Math.floor(this.state.currentMaxIterations / 3);
    const newLevel = Math.min(2, Math.floor(currentIteration / third));

    if (newLevel > this.state.pressureLevel) {
      this.state.pressureLevel = newLevel;
      const messages = [
        "",
        "Analyze the requirements and start developing a structured plan or todo list.",
        "Create a comprehensive plan or todo list for this task.",
        "Based on the current context, create a detailed plan to complete the work."
      ];
      return { shouldEscalate: true, level: newLevel, message: messages[newLevel] };
    }

    return { shouldEscalate: false, level: this.state.pressureLevel, message: null };
  }

  /**
   * Parse AI progress report from response content
   * @param {string} content - Response content
   * @returns {number|null} Progress percentage or null
   */
  parseProgressReport(content) {
    if (!content) return null;

    // Look for patterns like "progress: 50%", "Progress: 75%", etc.
    const progressMatch = content.match(/progress:\s*(\d+)%/i);
    if (progressMatch) {
      const progress = parseInt(progressMatch[1], 10);
      if (progress >= 0 && progress <= 100) {
        this.state.aiReportedProgress = progress;
        return progress;
      }
    }
    return null;
  }

  /**
   * Force transition to execution phase
   */
  transitionToExecution() {
    this.state.phase = 'execution';
    console.log('Forced transition to EXECUTION phase');
  }



  /**
   * Check if current task iterations are exhausted
   * @param {number} currentIteration - Current iteration number
   * @returns {boolean} Whether task iteration limit is reached
   */
  isTaskIterationLimitReached(currentIteration) {
    if (this.state.phase !== 'execute_todo') {
      return false;
    }

    return this.state.taskIterationsUsed >= this.state.taskIterationLimit;
  }

  /**
   * Get current state for system prompts
   */
  getStateForPrompt() {
    const stagnation = this.detectStagnation();

    return {
      currentIteration: this.state.lastProgressIteration,
      maxIterations: this.state.currentMaxIterations,
      progressScore: this.state.totalProgressScore,
      stagnationWarning: stagnation.isStagnant ? stagnation.message : null,
      phase: this.state.phase,
      pressureLevel: this.state.pressureLevel,
      aiReportedProgress: this.state.aiReportedProgress,
      totalReads: this.state.totalReads,
      totalWrites: this.state.totalWrites
    };
  }

  /**
   * Extract relevant file paths from tool calls for context compression
   */
  extractRelevantFiles(messages) {
    const relevantFiles = new Set();
    const pendingKeywords = this.state.pendingTasks
      .concat(this.state.inProgressTasks)
      .map(t => t.description.toLowerCase().split(/\s+/))
      .flat();

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const filePath = this._extractFilePathFromMessage(msg);
        if (filePath) {
          // Check if file is relevant to pending tasks
          const isRelevant = pendingKeywords.some(keyword =>
            filePath.toLowerCase().includes(keyword) ||
            keyword.includes(filePath.toLowerCase().split('/').pop()?.replace(/\.\w+$/, '') || '')
          );
          
          if (isRelevant) {
            relevantFiles.add(filePath);
          }
        }
      }
    }

    return Array.from(relevantFiles).slice(0, 10);
  }

  // Private helper methods

  _hasSearchResults(result) {
    if (!result) return false;
    if (typeof result === 'string') {
      return result.length > 50 && !result.includes('No matches');
    }
    if (Array.isArray(result)) {
      return result.length > 0;
    }
    return Object.keys(result).length > 0;
  }

  _extractFilePathFromMessage(msg) {
    // Try to extract file path from tool result
    if (typeof msg.content === 'string') {
      // Look for file paths in the content
      const pathMatch = msg.content.match(/[\w\-./]+\.(js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|md|json|yaml|yml)/i);
      if (pathMatch) {
        return pathMatch[0];
      }
    }
    
    // Check tool name for file-related operations
    if (msg.tool_name && ['readFile', 'writeFile', 'editFile', 'edit'].includes(msg.tool_name)) {
      // Try to parse args if available
      try {
        const args = JSON.parse(msg.tool_args || '{}');
        return args.filePath || args.path || args.file;
      } catch {
        return null;
      }
    }

    return null;
  }

  _generateSummaryText(stagnation) {
    const parts = [];

    // What was completed
    if (this.state.completedTasks.length > 0) {
      parts.push(`Completed: ${this.state.completedTasks.length} tasks.`);
    }

    // What's pending
    if (this.state.pendingTasks.length > 0) {
      parts.push(`Pending: ${this.state.pendingTasks.length} tasks.`);
    }

    // What's in progress
    if (this.state.inProgressTasks.length > 0) {
      parts.push(`In progress: ${this.state.inProgressTasks.length} tasks.`);
    }

    // Why stopped
    parts.push(`Stopped: Limit of ${this.state.currentMaxIterations} iterations reached.`);

    // Stagnation warning
    if (stagnation.isStagnant) {
      parts.push(`Nota: ${stagnation.message}`);
    }

    return parts.join(' ');
  }
}

module.exports = { ProgressTracker };
