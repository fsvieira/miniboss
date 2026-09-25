/**
 * Shared set of read-only tools (investigation subbot / chat).
 */
const READ_ONLY_TOOLS = [
  'readFile', 'readFileChunk', 'readFileLines', 'readMultipleFiles',
  'listDirectory', 'getFileTree', 'searchFiles', 'searchInFiles',
  'grepInFile', 'semanticSearch', 'getFileInfo', 'copyFile'
];

/**
 * Creates file system tools scoped to a project's workingDir
 * @param {string} workingDir - The working directory for the project
 * @param {string|null} conversationId - The conversation ID
 * @param {string} conversationType - The conversation type ('chat', 'main', 'focus')
 * @param {Object|null} dbApi - Optional DatabaseAPI instance (to avoid race conditions from separate connections)
 * @returns {Array} OpenAI-compatible tools array
 */
function createTools(workingDir, conversationId = null, conversationType = 'chat', dbApi = null) {
  const db = require('../database');
  if (!dbApi) {
    const { DatabaseAPI, DatabaseConnection } = require('../services/db');
    const connection = new DatabaseConnection();
    dbApi = new DatabaseAPI(connection);
  }
  
  // If conversationId provided, get actual conversation type and mode from DB
  let conversationMode = null;
  if (conversationId) {
    try {
      const conv = dbApi.getConversation(conversationId);
      if (conv && conv.conversation_type) {
        conversationType = conv.conversation_type;
      }
      if (conv && conv.mode) {
        conversationMode = conv.mode;
      }
    } catch (_) {}
  }
  
  const tools = [
    {
      type: "function",
      function: {
        name: "readFile",
        description: "Read the contents of a file. Returns a structured preview (first ~6000 chars) plus recommended follow-up commands (readFileLines/readFileChunk) when truncated. You MUST provide only relative paths inside the project working directory. Absolute paths and parent-directory traversal (`..`) are forbidden.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "writeFile",
        description: "Write content to a file. Creates intermediate directories if needed. Overwrites the file if it already exists. Response includes existed/overwritten flags. You MUST provide only relative paths inside the project working directory. Absolute paths and parent-directory traversal (`..`) are forbidden.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            },
            content: {
              type: "string",
              description: "The content to write to the file"
            }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "editFile",
        description: "Edit a file by replacing a specific string. More precise and efficient than writeFile for small changes. Replaces the first occurrence of old_string with new_string. You MUST provide only relative paths inside the project working directory. Absolute paths and parent-directory traversal (`..`) are forbidden.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            },
            old_string: {
              type: "string",
              description: "The exact text to find and replace"
            },
            new_string: {
              type: "string",
              description: "The new text to replace it with"
            },
            replace_all: {
              type: "boolean",
              description: "If true, replace all occurrences. Default: false"
            }
          },
          required: ["path", "old_string", "new_string"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listDirectory",
        description: "List entries in a directory. Returns a list of files and subdirectories with prefixes 'file:' or 'dir:'. You MUST provide only relative paths inside the project working directory. Absolute paths and parent-directory traversal (`..`) are forbidden. Use '.' for the project root.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the directory inside the project working directory. Do NOT use absolute paths or `..`."
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "searchFiles",
        description: "Find and list file paths in the project workspace using glob patterns. Use this to discover the project structure or locate specific files by extension/name. All results are scoped to the project working directory.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Relative glob pattern (e.g., '**/*.js', '*.json', 'src/**/*.ts'). Matches are always scoped to the project working directory."
            }
          },
          required: ["pattern"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "searchInFiles",
        description: "Search for a regex pattern inside files. Returns a structured sample of matching lines (capped) with guidance to refine filePattern/regex when truncated. Maximum 200 files scanned per call. All file access is scoped to the project working directory.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "The regex pattern to search for in file contents"
            },
            filePattern: {
              type: "string",
              description: "Optional glob pattern to filter which files to search (e.g., '**/*.js'). Defaults to '**/*' if not provided."
            }
          },
          required: ["pattern"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "moveFile",
        description: "Move or rename a file. Creates intermediate directories for the destination if needed. All paths must remain inside the project working directory. Absolute paths and parent-directory traversal (`..`) are forbidden.",
        parameters: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Relative source path inside the project working directory. Do NOT use absolute paths or `..`."
            },
            to: {
              type: "string",
              description: "Relative destination path inside the project working directory. Do NOT use absolute paths or `..`."
            }
          },
          required: ["from", "to"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "deleteFile",
        description: "Delete a file. The path must remain inside the project working directory. Absolute paths and parent-directory traversal (`..`) are forbidden.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getFileTree",
        description: "Recursively list the directory structure as an indented tree string. Ignores node_modules, .git, dist, .next, build, and coverage directories. Path must remain inside the project working directory.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the starting directory inside the project working directory. Do NOT use absolute paths or `..`."
            },
            maxDepth: {
              type: "number",
              description: "Maximum recursion depth. Defaults to 4."
            }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "readMultipleFiles",
        description: "Read several files in one call. Supports glob patterns (e.g. src/**/*.ts). Returns structured previews per file (first ~6000 chars) with follow-up commands when truncated. Maximum 20 files. All paths must remain inside the project working directory.",
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of relative file paths inside the project working directory. Maximum 20 items. Do NOT use absolute paths or `..`."
            }
          },
          required: ["paths"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "getFileInfo",
        description: "Return metadata for a file without reading its content. Includes size, last modified time, whether it's a directory or binary, and file extension. The path must remain inside the project working directory.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "createDirectory",
        description: "Create a directory and all intermediate directories (like mkdir -p). The path must remain inside the project working directory. Absolute paths and parent-directory traversal (`..`) are forbidden.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the directory to create inside the project working directory. Do NOT use absolute paths or `..`."
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "readFileChunk",
        description: "Read a specific chunk of a file with offset and limit. Returns the file content starting from the specified byte offset with the given length limit. The path must remain inside the project working directory.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            },
            offset: {
              type: "number",
              description: "The byte offset to start reading from (0-indexed). Defaults to 0.",
              default: 0
            },
            limit: {
              type: "number",
              description: "The maximum number of bytes to read. Defaults to 20000.",
              default: 20000
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "copyFile",
        description: "Copy a file to another path inside the project working directory. Creates intermediate directories at destination if needed. Absolute paths and parent-directory traversal (`..`) are forbidden.",
        parameters: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Relative source path inside the project working directory. Do NOT use absolute paths or `..`."
            },
            to: {
              type: "string",
              description: "Relative destination path inside the project working directory. Do NOT use absolute paths or `..`."
            }
          },
          required: ["from", "to"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "readFileLines",
        description: "Read a specific range of lines from a file by line number (1-based). Shows line numbers. Ideal for reading specific sections of a file when you already know the structure. Returns max 200 lines per call. The path must remain inside the project working directory.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            },
            startLine: {
              type: "number",
              description: "The 1-based line number to start reading from. Defaults to 1.",
              default: 1
            },
            numLines: {
              type: "number",
              description: "The number of lines to read. Maximum 200. Defaults to 50.",
              default: 50
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "grepInFile",
        description: "Search for a regex pattern inside a single file. Returns matching lines with context lines around each match + totalMatches count. Faster and more focused than searchInFiles when you know which file to inspect. The path must remain inside the project working directory.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "The regex pattern to search for in the file contents"
            },
            path: {
              type: "string",
              description: "Relative path to the file inside the project working directory. Do NOT use absolute paths or `..`."
            },
            contextLines: {
              type: "number",
              description: "Number of context lines to show before and after each match. Defaults to 0.",
              default: 0
            }
          },
          required: ["pattern", "path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "semanticSearch",
        description: "Search code semantically using natural language. Uses embeddings to find relevant code by meaning rather than exact text matches. Returns file path, line numbers, content, and similarity score.\n\nPREFER this tool when starting a task or when you don't know which file contains what you need.\n\nUse searchInFiles instead when you know the exact text or function name.\nUse readFile/readFileChunk when you already know the exact file and lines.\n\nAll returned paths are relative to the project working directory.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural language description of what code to find (e.g., 'database connection setup', 'error handling middleware', 'authentication logic')"
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 5.",
              default: 5
            }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "runCommand",
        description: `Execute a shell command. CWD = "${workingDir}". PREFER ABSOLUTE PATHS to avoid ambiguity — use the CWD above as your base. Relative paths work (resolved from CWD) but avoid relative path traversal (e.g. '../data/chat.db' might leave the worktree). Runs inside a bubblewrap (bwrap) sandbox when available. Supports optional timeout (ms). Use this for running tests, builds, lints, or other development tasks. The command output will be returned as the result.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: `The shell command to execute. PREFER ABSOLUTE PATHS. CWD = "${workingDir}". Relative paths are resolved from CWD. Avoid relative path traversal (e.g. '../data/chat.db' might leave the worktree).`
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds. Default: no timeout.",
              default: 0
            }
          },
          required: ["command"]
        }
      }
    }
  ];

  if (conversationId) {
    const { createTaskTreeTools } = require('./taskTreeTools');
    const taskTools = createTaskTreeTools(conversationId);
    // Add task tree tools definitions only for MAIN
    if (conversationType === 'main') {
      Object.values(taskTools).forEach(tool => {
        tools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        });
      });
    }
  }

  // Add focus tools based on conversation type
  if (conversationId && conversationType) {
    const { createFocusTools } = require('./focusTools');
    const focusTools = createFocusTools(conversationId);
    const { createTaskTreeTools } = require('./taskTreeTools');
    const taskTools = createTaskTreeTools(conversationId);

    // MAIN conversations get ALL tools + investigate + TODO/task tree tools + plan tools
    // In 'plan' mode (read-only): only read + todo + plan + investigate tools are exposed
    if (conversationType === 'main') {
      const isPlanMode = conversationMode === 'plan';
      if (isPlanMode) {
        const writeTools = [
          'writeFile', 'editFile', 'moveFile', 'deleteFile', 'createDirectory', 'copyFile', 'runCommand'
        ];
        for (let i = tools.length - 1; i >= 0; i--) {
          if (writeTools.includes(tools[i].function.name)) {
            tools.splice(i, 1);
          }
        }
      }
      const { createPlanTools } = require('./planTools');
      const planTools = createPlanTools(conversationId);
      for (const name of ['updatePlan', 'getPlan']) {
        const tool = planTools[name];
        if (!tool) continue;
        tools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        });
      }
      tools.push({
        type: 'function',
        function: {
          name: focusTools.investigate.name,
          description: focusTools.investigate.description,
          parameters: focusTools.investigate.parameters
        }
      });
    }

    // FOCUS conversations (investigation subbot): read-only tools + runCommand +
    // investigate (can create sub-investigations) + submitFindings + task tree tools
    if (conversationType === 'focus') {
      for (let i = tools.length - 1; i >= 0; i--) {
        if (!READ_ONLY_TOOLS.includes(tools[i].function.name)) {
          tools.splice(i, 1);
        }
      }
      // Add runCommand (read-only sandbox)
      tools.push({
        type: 'function',
        function: {
          name: 'runCommand',
          description: 'Execute a shell command in a read-only sandbox. Use for inspection, tests, builds, or lint. Writes to the worktree are blocked by the sandbox.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The shell command to execute. CWD = the project worktree.' },
              timeout: { type: 'number', description: 'Timeout in milliseconds. Default: no timeout.' }
            },
            required: ['command']
          }
        }
      });
      // Add investigate (can create sub-investigations)
      tools.push({
        type: 'function',
        function: {
          name: focusTools.investigate.name,
          description: focusTools.investigate.description,
          parameters: focusTools.investigate.parameters
        }
      });
      // Add submitFindings
      tools.push({
        type: 'function',
        function: {
          name: focusTools.submitFindings.name,
          description: focusTools.submitFindings.description,
          parameters: focusTools.submitFindings.parameters
        }
      });
      // Add task tree tools
      Object.values(taskTools).forEach(tool => {
        tools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        });
      });

      // Add getPlan (read-only) — o subbot pode consultar o plano da conversa pai
      try {
        const { createPlanTools } = require('./planTools');
        const planTools = createPlanTools(conversationId);
        const getPlan = planTools.getPlan;
        if (getPlan) {
          tools.push({
            type: 'function',
            function: {
              name: getPlan.name,
              description: getPlan.description,
              parameters: getPlan.parameters
            }
          });
        }
      } catch (_) {}
    }

    // CHAT conversations (read-only sub-conversations): keep only read tools
    if (conversationType === 'chat') {
      for (let i = tools.length - 1; i >= 0; i--) {
        if (!READ_ONLY_TOOLS.includes(tools[i].function.name)) {
          tools.splice(i, 1);
        }
      }
    }

    // PROJECT conversations (Project Memory): read-only sobre a pasta real do
    // projeto (sandbox read-only) + runCommand + plan tools + knowledge tools.
    // Sem tools de escrita, sem copyFile (escreve), sem investigate, sem task tree.
    if (conversationType === 'project') {
      for (let i = tools.length - 1; i >= 0; i--) {
        const name = tools[i].function.name;
        const isReadOnly = READ_ONLY_TOOLS.includes(name) && name !== 'copyFile';
        const isRunCommand = name === 'runCommand' && !!workingDir;
        // No associated folder (workingDir null): only memory/plan tools are kept
        if (!workingDir) {
          const isKnowledgeOrPlan = ['updatePlan', 'getPlan', 'saveNote', 'updateNote', 'listNotes', 'searchNotes', 'getNote', 'listProjectConversations', 'requestConversationReport'].includes(name);
          if (!isKnowledgeOrPlan) {
            tools.splice(i, 1);
          }
          continue;
        }
        if (!isReadOnly && !isRunCommand) {
          tools.splice(i, 1);
        }
      }
      const runCommandIdx = tools.findIndex(t => t?.function?.name === 'runCommand');
      if (runCommandIdx !== -1) {
        tools[runCommandIdx].function.description = 'Execute a shell command in a read-only sandbox (the project folder is mounted read-only). Use for inspection, tests, builds, or lint. Writes are blocked by the sandbox.';
      }
      const { createPlanTools } = require('./planTools');
      const planTools = createPlanTools(conversationId);
      for (const name of ['updatePlan', 'getPlan']) {
        const tool = planTools[name];
        if (!tool) continue;
        // Avoid duplicates when there is no workingDir (already kept in the filter)
        if (tools.some(t => t?.function?.name === name)) continue;
        tools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        });
      }
      const { createProjectTools } = require('./projectTools');
      const projectTools = createProjectTools(conversationId);
      for (const name of ['saveNote', 'updateNote', 'listNotes', 'searchNotes', 'getNote', 'listProjectConversations', 'requestConversationReport']) {
        const tool = projectTools[name];
        if (!tool) continue;
        if (tools.some(t => t?.function?.name === name)) continue;
        tools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        });
      }
    }
  }

  return tools;
}

module.exports = {
  createTools,
  READ_ONLY_TOOLS
};
