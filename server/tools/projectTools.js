const { DatabaseAPI } = require('../services/db/api');
const { computeConversationStatus } = require('../services/conversationStatus');
const { generateConversationReport, buildLinkageMap } = require('../services/conversationReport');

const MAX_CONVERSATIONS_DEFAULT = 50;
const MAX_CONVERSATIONS_CAP = 200;

/**
 * Project Memory tools — conhecimento estruturado da conversa global do projeto.
 *
 * Resolvem o project_id a partir da conversa (conversation_type='project').
 * Fase 1: notas simples (idea/note/decision/discovery/open_question) sem
 * auto dedup — assistant uses searchNotes/listNotes before saving
 * e atualiza em vez de duplicar.
 *
 * @param {number} conversationId - conversa global ('project').
 * @param {Object} [options] - Injection points (tests).
 * @param {Object} [options.db] - DatabaseAPI alternativo.
 * @param {Object} [options.reportOptions] - options for generateConversationReport (ex: aiClientFactory).
 */
function createProjectTools(conversationId, options = {}) {
  const db = options.db || new DatabaseAPI(require('../database'));

  let projectId = null;
  try {
    const conv = db.getConversation(conversationId);
    projectId = conv ? conv.project_id : null;
  } catch (_) {}

  const assertProject = () => {
    if (!projectId) {
      throw new Error('saveNote/updateNote require a Project Memory conversation');
    }
  };

  const toConversationRow = (row, linkageMap) => {
    const link = linkageMap.get(Number(row.id)) || null;
    const entry = {
      id: row.id,
      title: row.title || null,
      conversationType: row.conversation_type || null,
      mode: row.mode || null,
      phase: row.phase || null,
      processingState: row.processing_state || null,
      status: computeConversationStatus(row, db),
      parentId: row.parent_id || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      linkedToExecution: Boolean(link),
      isProjectMemory: row.conversation_type === 'project',
    };
    if (link) entry.executionStatus = link.status || null;
    return entry;
  };

  return {

    saveNote: {
      name: 'saveNote',
      description: `Save a structured piece of project knowledge (idea, note, decision, discovery, or open question) into the project memory database.

Before saving, search existing notes (searchNotes/listNotes) to avoid duplicates — update the related note instead of creating a new one.
kind: idea | note | decision | discovery | open_question.
Record the reasoning/context (the "why"), not only the conclusion.`,
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['idea', 'note', 'decision', 'discovery', 'open_question'],
            description: 'Type of knowledge being stored.',
            default: 'note'
          },
          title: {
            type: 'string',
            description: 'Short descriptive title. Optional.'
          },
          content: {
            type: 'string',
            description: 'The knowledge content, including the reasoning/context.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for later retrieval.'
          }
        },
        required: ['content']
      },
      handler: async ({ kind, title, content, tags }) => {
        assertProject();
        return db.createProjectNote({
          project_id: projectId,
          kind,
          title: title || null,
          content: String(content || ''),
          tags,
          source_conversation_id: conversationId,
        });
      }
    },

    updateNote: {
      name: 'updateNote',
      description: `Update an existing project memory note (change kind, title, content, status, or tags).

Use this instead of saveNote when the note already exists (e.g. the topic was already covered and evolved).`,
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'The note id returned by saveNote/listNotes/searchNotes/getNote.'
          },
          kind: {
            type: 'string',
            enum: ['idea', 'note', 'decision', 'discovery', 'open_question']
          },
          title: { type: 'string' },
          content: { type: 'string' },
          status: {
            type: 'string',
            enum: ['active', 'archived'],
            description: 'Archive keeps the note for reference but removes it from the active memory.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['id']
      },
      handler: async ({ id, kind, title, content, status, tags }) => {
        assertProject();
        const note = db.getProjectNote(id);
        if (!note) throw new Error(`Project note ${id} not found`);
        if (Number(note.project_id) !== Number(projectId)) {
          throw new Error(`Project note ${id} does not belong to this project`);
        }
        return db.updateProjectNote(id, { kind, title, content, status, tags });
      }
    },

    listNotes: {
      name: 'listNotes',
      description: 'List project memory notes (optionally filtered by kind and status). Returns the most recently updated notes first.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['idea', 'note', 'decision', 'discovery', 'open_question']
          },
          status: {
            type: 'string',
            enum: ['active', 'archived'],
            description: 'Defaults to active notes.'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of notes. Defaults to 20.'
          }
        }
      },
      handler: async ({ kind, status, limit }) => {
        assertProject();
        return db.getProjectNotes(projectId, {
          kind,
          status: status || 'active',
          limit: limit || 20,
        });
      }
    },

    searchNotes: {
      name: 'searchNotes',
      description: 'Search project memory notes by text (matched against title and content). Use this before saving to avoid duplicates.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The text to search for.'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results. Defaults to 10.'
          }
        },
        required: ['query']
      },
      handler: async ({ query, limit }) => {
        assertProject();
        return db.searchProjectNotes(projectId, query, limit || 10);
      }
    },

    getNote: {
      name: 'getNote',
      description: 'Get a single project memory note by id.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'The note id.'
          }
        },
        required: ['id']
      },
      handler: async ({ id }) => {
        assertProject();
        const note = db.getProjectNote(id);
        if (!note) throw new Error(`Project note ${id} not found`);
        if (Number(note.project_id) !== Number(projectId)) {
          throw new Error(`Project note ${id} does not belong to this project`);
        }
        return note;
      }
    },

    listProjectConversations: {
      name: 'listProjectConversations',
      description: `List the project's conversations (roots + optional descendants) with their derived status, execution linkage, and untracked roots.

Deterministic (no AI call). Use this to build a map of the project before deciding which conversation to inspect with requestConversationReport.
- untracked lists root conversations that have no plan_execution recorded.
- includeChildren also walks focus/sub-conversations of each root.
- types filters by conversation_type (e.g. ['main','focus']).`,
      parameters: {
        type: 'object',
        properties: {
          includeChildren: {
            type: 'boolean',
            description: 'Include descendant sub-conversations. Defaults to false.'
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only return these conversation_type values.'
          },
          limit: {
            type: 'number',
            description: 'Maximum rows to return (default 50, max 200).'
          }
        }
      },
      handler: async ({ includeChildren, types, limit } = {}) => {
        assertProject();

        const roots = db.getConversationsByProject(projectId) || [];
        const linkageMap = buildLinkageMap(db, projectId);
        const typeFilter = Array.isArray(types) && types.length > 0
          ? new Set(types.map(String))
          : null;

        const rows = [];
        for (const root of roots) {
          if (!typeFilter || typeFilter.has(String(root.conversation_type))) {
            rows.push(root);
          }
          if (!includeChildren) continue;

          let subtreeIds = [];
          try {
            subtreeIds = db.getConversationSubtreeIds(root.id) || [];
          } catch (_) {
            subtreeIds = [];
          }
          for (const childId of subtreeIds) {
            if (Number(childId) === Number(root.id)) continue;
            let child = null;
            try {
              child = db.getConversation(childId);
            } catch (_) {
              child = null;
            }
            if (!child) continue;
            if (typeFilter && !typeFilter.has(String(child.conversation_type))) continue;
            rows.push(child);
          }
        }

        // untracked = non-global roots without plan_execution (decision #2).
        const untrackedIds = roots
          .filter(row => row.conversation_type !== 'project')
          .filter(row => !linkageMap.has(Number(row.id)))
          .map(row => row.id);

        const requestedLimit = Number(limit) > 0 ? Number(limit) : MAX_CONVERSATIONS_DEFAULT;
        const maxRows = Math.min(requestedLimit, MAX_CONVERSATIONS_CAP);
        const limited = rows.slice(0, maxRows);

        return {
          conversations: limited.map(row => toConversationRow(row, linkageMap)),
          total: rows.length,
          untracked: { count: untrackedIds.length, conversationIds: untrackedIds },
          truncated: rows.length > limited.length,
        };
      }
    },

    requestConversationReport: {
      name: 'requestConversationReport',
      description: `Generate a read-only AI status report for one conversation of this project (objective, done, in progress, blockers/risks, next steps).

Costs one AI call. Nothing is written to the target conversation.
For a focus conversation that already has a stored report, the stored report is returned without an AI call.
Use listProjectConversations first to choose the conversation.`,
      parameters: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'number',
            description: 'Conversation id to report on.'
          },
          maxMessages: {
            type: 'number',
            description: 'Maximum history messages to read (default 100).'
          }
        },
        required: ['conversationId']
      },
      handler: async ({ conversationId: targetConversationId, maxMessages } = {}) => {
        assertProject();
        const target = db.getConversation(targetConversationId);
        if (!target) {
          return { report: null, error: 'Conversation not found', meta: null };
        }
        if (Number(target.project_id) !== Number(projectId)) {
          return { report: null, error: 'Conversation does not belong to this project', meta: null };
        }
        const reportOptions = { ...(options.reportOptions || {}) };
        if (Number(maxMessages) > 0) reportOptions.maxMessages = Number(maxMessages);
        return generateConversationReport({
          targetConversationId,
          projectConversationId: conversationId,
          db,
          options: reportOptions,
        });
      }
    }
  };
}

module.exports = { createProjectTools };