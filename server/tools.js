const { createTools: createToolDefinitions } = require('./tools/definitions');
const { getTouchedPaths, getAutoStagePaths } = require('./tools/tracker');
const { readFile, readFileChunk, readFileLines, writeFile, editFile, moveFile, deleteFile, copyFile } = require('./tools/fileOperations');
const { listDirectory, getFileTree, createDirectory } = require('./tools/directoryOperations');
const { searchFiles, searchInFiles, grepInFile } = require('./tools/searchOperations');
const { readMultipleFiles, getFileInfo } = require('./tools/utilityOperations');
const { createTaskTreeTools } = require('./tools/taskTreeTools');
const gitService = require('./services/gitService');
const { semanticSearch } = require('./indexer');

/**
 * Creates file system tools scoped to a project's workingDir
 * @param {string} workingDir - The working directory for the project
 * @param {number|null} conversationId - Conversation ID for task and focus tools
 * @param {string} [conversationType='chat'] - Conversation type for tool filtering
 * @returns {Array} OpenAI-compatible tools array
 */
function createTools(workingDir, conversationId = null, conversationType = 'chat') {
  return createToolDefinitions(workingDir, conversationId, conversationType);
}

async function executeTool(toolName, args, workingDir, context = {}, conversationId = null) {
  try {
    let result;

    console.log(`[TOOL EXECUTE] Starting tool: ${toolName}`, { args });

    switch (toolName) {
      case 'readFile':
        result = await readFile(args.path, workingDir);
        break;

      case 'writeFile':
        result = await writeFile(args.path, args.content, workingDir);
        break;

      case 'editFile':
        result = await editFile(args.path, args.old_string, args.new_string, args.replace_all || false, workingDir);
        break;

      case 'listDirectory':
        result = await listDirectory(args.path, workingDir);
        break;

      case 'searchFiles':
        result = await searchFiles(args.pattern, workingDir);
        break;

      case 'searchInFiles':
        result = await searchInFiles(args.pattern, args.filePattern, workingDir);
        break;

      case 'moveFile':
        result = await moveFile(args.from, args.to, workingDir);
        break;

      case 'deleteFile':
        result = await deleteFile(args.path, workingDir);
        break;

      case 'getFileTree':
        result = await getFileTree(args.path, args.maxDepth, workingDir);
        break;

      case 'readMultipleFiles':
        result = await readMultipleFiles(args.paths, workingDir);
        break;

      case 'getFileInfo':
        result = await getFileInfo(args.path, workingDir);
        break;

      case 'createDirectory':
        result = await createDirectory(args.path, workingDir);
        break;

      case 'readFileChunk':
        result = await readFileChunk(args.path, args.offset, args.limit, workingDir);
        break;

      case 'copyFile':
        result = await copyFile(args.from, args.to, workingDir);
        break;

      case 'readFileLines':
        result = await readFileLines(args.path, args.startLine, args.numLines, workingDir);
        break;

      case 'grepInFile':
        result = await grepInFile(args.pattern, args.path, args.contextLines, workingDir);
        break;

      case 'semanticSearch':
        result = await semanticSearch(args.query, args.maxResults || 5, context.conversationId);
        break;

      case 'runCommand':
        // This will be handled specially in aiController with user validation
        result = { requiresApproval: true, command: args.command, cwd: workingDir, timeout: args.timeout || 0 };
        break;

      case 'investigate':
        if (conversationId) {
          const { createFocusTools } = require('./tools/focusTools');
          const focusTools = createFocusTools(conversationId);
          const tool = focusTools.investigate;
          if (tool) {
            result = await tool.handler(args);
            break;
          }
        }
        throw new Error(`investigate requires conversationId`);

      case 'submitFindings':
        if (conversationId) {
          const { createFocusTools } = require('./tools/focusTools');
          const focusTools = createFocusTools(conversationId);
          const tool = focusTools.submitFindings;
          if (tool) {
            result = await tool.handler(args);
            break;
          }
        }
        throw new Error(`submitFindings requires conversationId`);

      case 'updatePlan':
      case 'getPlan':
        if (conversationId) {
          const { createPlanTools } = require('./tools/planTools');
          const planTools = createPlanTools(conversationId);
          const tool = planTools[toolName];
          if (tool) {
            result = await tool.handler(args);
            break;
          }
        }
        throw new Error(`${toolName} requires conversationId`);

      default:
        if (conversationId && ['addTodo', 'updateTodo', 'removeTodo', 'getTaskTree'].includes(toolName)) {
          const taskTools = createTaskTreeTools(conversationId);
          const tool = taskTools[toolName];
          if (tool) {
            result = await tool.handler(args);
            break;
          }
        }
        if (conversationId && ['saveNote', 'updateNote', 'listNotes', 'searchNotes', 'getNote', 'listProjectConversations', 'requestConversationReport'].includes(toolName)) {
          const { createProjectTools } = require('./tools/projectTools');
          const projectTools = createProjectTools(conversationId);
          const tool = projectTools[toolName];
          if (tool) {
            result = await tool.handler(args);
            break;
          }
        }
        throw new Error(`Unknown tool: ${toolName}`);
    }

    console.log(`[TOOL EXECUTE] Completed tool: ${toolName}`, { resultPreview: typeof result === 'string' ? result.substring(0, 200) + (result.length > 200 ? '...' : '') : JSON.stringify(result).substring(0, 200) });

    if (context.conversationId) {
      const touchedPaths = getTouchedPaths(toolName, args);
      if (touchedPaths.length > 0) {
        await gitService.trackConversationTouchedFiles(context.conversationId, touchedPaths);
      }

      const autoStagePaths = getAutoStagePaths(toolName, args, result);
      if (autoStagePaths.length > 0) {
        await gitService.stageConversationTouchedFiles(context.conversationId, autoStagePaths);
      }
    }

    return result;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

module.exports = {
  createTools,
  executeTool
};
