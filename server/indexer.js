require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('./database');
const { getDatabasePath } = require('./config/paths');

// Embeddings DB path — same directory as chat.db
const embeddingsDbPath = path.join(path.dirname(getDatabasePath()), 'embeddings.db');
let embeddingsDb = null;

// ── Local embeddings (Xenova/multilingual-e5-small) ───────────────────────────

const { pipeline } = require('@huggingface/transformers');

let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  }
  return extractor;
}

function getEmbeddingsConfig() {
  const model = process.env.EMBEDDINGS_MODEL || 'Xenova/multilingual-e5-small';
  return { model, dimensions: 384 };
}

function isEmbeddingsConfigured() {
  return true; // local model always available
}

// ── Embeddings DB management ──────────────────────────────────────────────────

function getEmbeddingsDb() {
  if (embeddingsDb) return embeddingsDb;

  const dbDir = path.dirname(embeddingsDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  embeddingsDb = new Database(embeddingsDbPath);
  embeddingsDb.pragma('journal_mode = WAL');
  embeddingsDb.pragma('foreign_keys = ON');

  embeddingsDb.exec(`
    CREATE TABLE IF NOT EXISTS project_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      embeddings_model TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES project_chunks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worktree_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      embeddings_model TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worktree_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES worktree_chunks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_chunks_project_file ON project_chunks(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_worktree_chunks_conversation_file ON worktree_chunks(conversation_id, file_path);
  `);

  return embeddingsDb;
}

function closeEmbeddingsDb() {
  if (embeddingsDb) {
    embeddingsDb.close();
    embeddingsDb = null;
  }
}

// ── Git exec helper (must be before any functions that use it) ────────────────

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// ── Local embedding generation ───────────────────────────────────────────────

async function getEmbedding(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

async function getEmbeddingSafe(text) {
  try {
    return await getEmbedding(text);
  } catch (error) {
    console.error(`[SEMANTIC SEARCH] getEmbeddingSafe failed: ${error.message}`);
    return null;
  }
}

// ── File scanning utilities ──────────────────────────────────────────────────

const MAX_FILE_SIZE = 500 * 1024; // 500 KB
const BINARY_CHECK_SIZE = 512;
const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;

function isBinaryFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(BINARY_CHECK_SIZE);
    const bytesRead = fs.readSync(fd, buffer, 0, BINARY_CHECK_SIZE, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true; // treat unreadable as binary
  }
}

/**
 * Get files tracked by git via `git ls-files`.
 * Only returns files that are actually tracked by git, respecting .gitignore.
 * Returns absolute paths resolved against repoRoot.
 */
async function getGitTrackedFiles(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean).map(f => path.resolve(repoRoot, f));
  } catch (error) {
    console.error(`[SEMANTIC SEARCH] git ls-files failed for ${repoRoot}: ${error.message}`);
    return [];
  }
}

function getFileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

// ── File chunking ────────────────────────────────────────────────────────────

function chunkFileContent(content, filePath) {
  const lines = content.split('\n');
  // Remove trailing empty line
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const chunks = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;

  if (lines.length === 0) return chunks;

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const chunkContent = lines.slice(start, end).join('\n');
    chunks.push({
      file_path: filePath,
      start_line: start + 1, // 1-based
      end_line: end,         // 1-based, inclusive
      content: chunkContent,
    });
    if (end >= lines.length) break;
  }

  return chunks;
}

// ── Conversation / project helpers ───────────────────────────────────────────

function getConversationRecord(conversationId) {
  return db.prepare(`
    SELECT c.*, p.folder_path, p.id AS project_id, p.name AS project_name
    FROM conversations c
    JOIN projects p ON p.id = c.project_id
    WHERE c.id = ?
  `).get(conversationId);
}

async function getProjectFiles(repoRoot) {
  const allFiles = await getGitTrackedFiles(repoRoot);
  console.log(`[SEMANTIC SEARCH] Found ${allFiles.length} git-tracked files in ${repoRoot}`);
  return allFiles.filter((filePath) => {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return false;
    if (isBinaryFile(filePath)) return false;
    return true;
  });
}

// ── Indexing: Project (repo root) ────────────────────────────────────────────

async function indexProject(projectId, repoRoot, onProgress) {
  console.log(`[SEMANTIC SEARCH] Starting project indexing for project ${projectId} at ${repoRoot}`);
  const eDb = getEmbeddingsDb();
  const { model } = getEmbeddingsConfig();

  // Delete existing project chunks
  const deleteChunks = eDb.prepare('DELETE FROM project_chunks WHERE project_id = ?');
  const deleteEmbeddings = eDb.prepare(`
    DELETE FROM project_embeddings WHERE chunk_id IN (
      SELECT id FROM project_chunks WHERE project_id = ?
    )
  `);

  const insertChunk = eDb.prepare(`
    INSERT INTO project_chunks (project_id, file_path, start_line, end_line, content, embeddings_model, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEmbedding = eDb.prepare(`
    INSERT INTO project_embeddings (chunk_id, embedding) VALUES (?, ?)
  `);

  const files = await getProjectFiles(repoRoot);
  const totalFiles = files.length;
  console.log(`[SEMANTIC SEARCH] Found ${totalFiles} files to index for project ${projectId}`);

  // ── Phase 1: Read all files and pre-count total chunks ──────────────
  // As each file generates multiple chunks (50 lines + 10 overlap),
  // the number of chunks is much larger than the number of files.
  // Para que a barra de progresso chegue a exatamente 100% no fim,
  // usamos o total de chunks como denominador fixo.
  const fileChunkMap = [];
  let totalChunks = 0;

  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue; // skip unreadable files
    }
    const relativePath = path.relative(repoRoot, filePath);
    const chunks = chunkFileContent(content, relativePath);
    const chunksWithContent = chunks.filter(c => c.content.trim());
    fileChunkMap.push({ relativePath, chunks: chunksWithContent });
    totalChunks += chunksWithContent.length;
  }

  console.log(`[SEMANTIC SEARCH] Pre-counted ${totalChunks} chunks across ${fileChunkMap.length} indexable files`);

  // Sends 'totalChunks' right at the start — it is the fixed 'denominator' of the bar
  if (onProgress) {
    onProgress(null, 0, fileChunkMap.length, totalChunks, 0);
  }

  // ── Fase 2: Limpar dados antigos ─────────────────────────────────────────────
  console.log(`[SEMANTIC SEARCH] Clearing existing project chunks for project ${projectId}`);
  eDb.transaction(() => {
    deleteEmbeddings.run(projectId);
    deleteChunks.run(projectId);
  })();

  // ── Fase 3: Indexar e reportar progresso por chunks ─────────────────────────
  let chunksIndexed = 0;

  for (const { relativePath, chunks } of fileChunkMap) {
    for (const chunk of chunks) {
      const embedding = await getEmbeddingSafe(chunk.content);
      if (!embedding) continue; // skip if embeddings server unavailable

      const now = Date.now();

      eDb.transaction(() => {
        const result = insertChunk.run(
          projectId,
          chunk.file_path,
          chunk.start_line,
          chunk.end_line,
          chunk.content,
          model,
          now
        );
        insertEmbedding.run(result.lastInsertRowid, Buffer.from(new Float32Array(embedding).buffer));
      })();

      chunksIndexed++;
      if (onProgress) {
        onProgress(relativePath, null, fileChunkMap.length, totalChunks, chunksIndexed);
      }
    }
  }

  return { totalFiles: fileChunkMap.length, totalChunks };
}

// ── Indexing: Worktree (diff files for a conversation) ───────────────────────

async function indexConversation(conversationId, workingDir, onProgress) {
  console.log(`[SEMANTIC SEARCH] Starting worktree indexing for conversation ${conversationId}`);
  const eDb = getEmbeddingsDb();
  const { model } = getEmbeddingsConfig();
  const conversation = getConversationRecord(conversationId);
  if (!conversation) throw new Error('Conversation not found');

  const repoRoot = conversation.folder_path;
  const worktreePath = workingDir || conversation.worktree_path;

  if (!worktreePath || !fs.existsSync(worktreePath)) {
    console.error(`[SEMANTIC SEARCH] Worktree path does not exist: ${worktreePath}`);
    throw new Error('Worktree path does not exist');
  }

  // Get files that differ in the worktree
  const diffFiles = await getWorktreeDiffFiles(repoRoot, worktreePath, conversation);

  // Also get uncommitted changes
  const uncommittedFiles = await getUncommittedFiles(worktreePath);

  const allChangedFiles = [...new Set([...diffFiles, ...uncommittedFiles])];
  console.log(`[SEMANTIC SEARCH] Found ${allChangedFiles.length} changed files to index for conversation ${conversationId}: ${allChangedFiles.join(', ')}`);

  // Delete existing worktree chunks for this conversation
  const deleteChunks = eDb.prepare('DELETE FROM worktree_chunks WHERE conversation_id = ?');
  const deleteEmbeddings = eDb.prepare(`
    DELETE FROM worktree_embeddings WHERE chunk_id IN (
      SELECT id FROM worktree_chunks WHERE conversation_id = ?
    )
  `);

  const insertChunk = eDb.prepare(`
    INSERT INTO worktree_chunks (conversation_id, file_path, start_line, end_line, content, embeddings_model, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEmbedding = eDb.prepare(`
    INSERT INTO worktree_embeddings (chunk_id, embedding) VALUES (?, ?)
  `);

  // ── Phase 1: Read all files and pre-count total chunks ──────────────
  const fileChunkMap = [];
  let totalChunks = 0;

  for (const filePath of allChangedFiles) {
    const fullPath = path.resolve(worktreePath, filePath);

    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
    if (isBinaryFile(fullPath)) continue;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const chunks = chunkFileContent(content, filePath);
    const chunksWithContent = chunks.filter(c => c.content.trim());
    fileChunkMap.push({ filePath, chunks: chunksWithContent });
    totalChunks += chunksWithContent.length;
  }

  console.log(`[SEMANTIC SEARCH] Pre-counted ${totalChunks} chunks across ${fileChunkMap.length} indexable files for conversation ${conversationId}`);

  // Sends 'totalChunks' right at the start — fixed denominator of the bar
  if (onProgress) {
    onProgress(null, 0, fileChunkMap.length, totalChunks, 0);
  }

  // Clear existing worktree data
  console.log(`[SEMANTIC SEARCH] Clearing existing worktree chunks for conversation ${conversationId}`);
  eDb.transaction(() => {
    deleteEmbeddings.run(conversationId);
    deleteChunks.run(conversationId);
  })();

  // ── Fase 2: Indexar e reportar progresso por chunks ─────────────────────────
  let chunksIndexed = 0;

  for (const { filePath, chunks } of fileChunkMap) {
    for (const chunk of chunks) {
      const embedding = await getEmbeddingSafe(chunk.content);
      if (!embedding) continue;

      const now = Date.now();

      eDb.transaction(() => {
        const result = insertChunk.run(
          conversationId,
          chunk.file_path,
          chunk.start_line,
          chunk.end_line,
          chunk.content,
          model,
          now
        );
        insertEmbedding.run(result.lastInsertRowid, Buffer.from(new Float32Array(embedding).buffer));
      })();

      chunksIndexed++;
      if (onProgress) {
        onProgress(filePath, null, fileChunkMap.length, totalChunks, chunksIndexed);
      }
    }
  }

  return { totalFiles: fileChunkMap.length, totalChunks };
}

// ── Git diff helpers ─────────────────────────────────────────────────────────

async function runGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    return '';
  }
}

async function getWorktreeDiffFiles(repoRoot, worktreePath, conversation) {
  // Get files changed between base_branch and the conversation branch
  const baseBranch = conversation.base_branch;
  const gitBranch = conversation.git_branch;

  if (baseBranch && gitBranch) {
    // Diff between base branch and conversation branch at the repo root level
    const diffOutput = await runGit(
      ['diff', '--name-only', `${baseBranch}...${gitBranch}`],
      repoRoot
    );
    if (diffOutput) {
      return diffOutput.split('\n').filter(Boolean);
    }
  }

  // Fallback: use working tree diff against HEAD
  return getUncommittedFiles(worktreePath);
}

async function getUncommittedFiles(worktreePath) {
  // Unstaged changes (working tree diff vs index)
  const diffOutput = await runGit(['diff', '--name-only'], worktreePath);
  // Staged changes (index diff vs HEAD)
  const stagedOutput = await runGit(['diff', '--cached', '--name-only'], worktreePath);
  // Untracked files (not ignored by .gitignore)
  const untrackedOutput = await runGit(
    ['ls-files', '--others', '--exclude-standard'],
    worktreePath
  );

  const files = new Set();
  if (diffOutput) {
    diffOutput.split('\n').filter(Boolean).forEach((f) => files.add(f));
  }
  if (stagedOutput) {
    stagedOutput.split('\n').filter(Boolean).forEach((f) => files.add(f));
  }
  if (untrackedOutput) {
    untrackedOutput.split('\n').filter(Boolean).forEach((f) => files.add(f));
  }

  return Array.from(files);
}

// ── Re-index changed files ───────────────────────────────────────────────────

async function reindexChangedFiles(conversationId, workingDir) {
  const conversation = getConversationRecord(conversationId);
  if (!conversation) throw new Error('Conversation not found');

  const repoRoot = conversation.folder_path;
  const worktreePath = workingDir || conversation.worktree_path;

  if (!worktreePath || !fs.existsSync(worktreePath)) {
    throw new Error('Worktree path does not exist');
  }

  // Get changed files in worktree
  const changedFiles = await getUncommittedFiles(worktreePath);
  const staleFiles = [];

  for (const filePath of changedFiles) {
    const fullPath = path.resolve(worktreePath, filePath);
    const mtime = getFileMtime(fullPath);
    if (mtime === null) continue;

    // Check if any chunks exist and are up-to-date
    const eDb = getEmbeddingsDb();
    const latestChunk = eDb.prepare(`
      SELECT MAX(indexed_at) AS max_indexed_at
      FROM worktree_chunks
      WHERE conversation_id = ? AND file_path = ?
    `).get(conversationId, filePath);

    if (!latestChunk || !latestChunk.max_indexed_at || latestChunk.max_indexed_at < mtime) {
      staleFiles.push(filePath);
    }
  }

  if (staleFiles.length === 0) {
    return { reindexed: 0 };
  }

  // Re-index stale files
  const { model } = getEmbeddingsConfig();
  const eDb = getEmbeddingsDb();

  const deleteChunksForFile = eDb.prepare(`
    DELETE FROM worktree_embeddings WHERE chunk_id IN (
      SELECT id FROM worktree_chunks WHERE conversation_id = ? AND file_path = ?
    )
  `);
  const deleteChunks = eDb.prepare(
    'DELETE FROM worktree_chunks WHERE conversation_id = ? AND file_path = ?'
  );
  const insertChunk = eDb.prepare(`
    INSERT INTO worktree_chunks (conversation_id, file_path, start_line, end_line, content, embeddings_model, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEmbedding = eDb.prepare(`
    INSERT INTO worktree_embeddings (chunk_id, embedding) VALUES (?, ?)
  `);

  let reindexedCount = 0;

  for (const filePath of staleFiles) {
    const fullPath = path.resolve(worktreePath, filePath);
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
    if (isBinaryFile(fullPath)) continue;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const chunks = chunkFileContent(content, filePath);

    // Delete old chunks for this file
    eDb.transaction(() => {
      deleteChunksForFile.run(conversationId, filePath);
      deleteChunks.run(conversationId, filePath);
    })();

    for (const chunk of chunks) {
      const embedding = await getEmbeddingSafe(chunk.content);
      if (!embedding) continue;

      const now = Date.now();

      eDb.transaction(() => {
        const result = insertChunk.run(
          conversationId,
          chunk.file_path,
          chunk.start_line,
          chunk.end_line,
          chunk.content,
          model,
          now
        );
        insertEmbedding.run(result.lastInsertRowid, Buffer.from(new Float32Array(embedding).buffer));
      })();

      reindexedCount++;
    }
  }

  console.log(`[SEMANTIC SEARCH] Re-index completed: ${reindexedCount} chunks from ${staleFiles.length} stale files`);

  return { reindexed: reindexedCount, totalFiles: staleFiles.length, totalChunks: reindexedCount };
}

// ── Status queries ───────────────────────────────────────────────────────────

function getIndexStatus(conversationId) {
  const conversation = getConversationRecord(conversationId);
  if (!conversation) {
    return { indexed: false, chunkCount: 0, lastIndexed: null, model: null };
  }

  const eDb = getEmbeddingsDb();

  // Check project chunks
  const projectChunkCount = eDb.prepare(
    'SELECT COUNT(*) AS count FROM project_chunks WHERE project_id = ?'
  ).get(conversation.project_id);

  // Check worktree chunks
  const worktreeChunkCount = eDb.prepare(
    'SELECT COUNT(*) AS count FROM worktree_chunks WHERE conversation_id = ?'
  ).get(conversationId);

  const totalChunks = (projectChunkCount?.count || 0) + (worktreeChunkCount?.count || 0);

  // Get last indexed time
  const lastProjectIndex = eDb.prepare(
    'SELECT MAX(indexed_at) AS max_ts FROM project_chunks WHERE project_id = ?'
  ).get(conversation.project_id);
  const lastWorktreeIndex = eDb.prepare(
    'SELECT MAX(indexed_at) AS max_ts FROM worktree_chunks WHERE conversation_id = ?'
  ).get(conversationId);

  const lastIndexed = Math.max(
    lastProjectIndex?.max_ts || 0,
    lastWorktreeIndex?.max_ts || 0
  );

  // Get model used
  const projectModel = eDb.prepare(
    'SELECT embeddings_model FROM project_chunks WHERE project_id = ? LIMIT 1'
  ).get(conversation.project_id);

  return {
    indexed: totalChunks > 0,
    chunkCount: totalChunks,
    lastIndexed: lastIndexed > 0 ? new Date(lastIndexed).toISOString() : null,
    model: projectModel?.embeddings_model || null,
  };
}

function isModelChanged(conversationId) {
  const { model } = getEmbeddingsConfig();
  const status = getIndexStatus(conversationId);
  return status.model !== null && status.model !== model;
}

function isProjectIndexed(projectId) {
  const eDb = getEmbeddingsDb();
  const count = eDb.prepare(
    'SELECT COUNT(*) AS count FROM project_chunks WHERE project_id = ?'
  ).get(projectId);
  return (count?.count || 0) > 0;
}

// ── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Semantic Search ──────────────────────────────────────────────────────────

async function semanticSearch(query, maxResults = 5, conversationId) {
  console.log(`[SEMANTIC SEARCH] Starting semantic search for conversation ${conversationId}, query: "${query}"`);
  if (!isEmbeddingsConfigured()) {
    console.log('[SEMANTIC SEARCH] Embeddings not configured');
    return 'Semantic search unavailable — embeddings server not configured';
  }

  const conversation = getConversationRecord(conversationId);
  if (!conversation) {
    console.log(`[SEMANTIC SEARCH] Conversation ${conversationId} not found`);
    return 'Conversation not found';
  }

  const worktreePath = conversation.worktree_path;
  const repoRoot = conversation.folder_path;

  if (!repoRoot || !fs.existsSync(repoRoot)) {
    console.log(`[SEMANTIC SEARCH] Project repository not found: ${repoRoot}`);
    return 'Project repository not found';
  }

  // Ensure project is indexed (lazy)
  if (!isProjectIndexed(conversation.project_id)) {
    console.log(`[SEMANTIC SEARCH] Project not indexed, starting lazy indexing`);
    try {
      await indexProject(conversation.project_id, repoRoot);
    } catch (error) {
      console.error(`[SEMANTIC SEARCH] Failed to index project: ${error.message}`);
      return `Failed to index project: ${error.message}`;
    }
  }

  // Ensure worktree is indexed (lazy)
  if (worktreePath && fs.existsSync(worktreePath)) {
    const eDb = getEmbeddingsDb();
    const worktreeCount = eDb.prepare(
      'SELECT COUNT(*) AS count FROM worktree_chunks WHERE conversation_id = ?'
    ).get(conversationId);
    if ((worktreeCount?.count || 0) === 0) {
      console.log(`[SEMANTIC SEARCH] Worktree not indexed, starting lazy indexing`);
      try {
        await indexConversation(conversationId, worktreePath);
      } catch (error) {
        console.error(`[SEMANTIC SEARCH] Failed to index worktree: ${error.message}`);
        // Non-fatal — we can still search project chunks
      }
    }
  }

  // Re-index if model changed
  if (isModelChanged(conversationId)) {
    console.log(`[SEMANTIC SEARCH] Model changed, re-indexing changed files`);
    try {
      await reindexChangedFiles(conversationId, worktreePath);
    } catch (error) {
      console.error(`[SEMANTIC SEARCH] Failed to re-index changed files: ${error.message}`);
      // Non-fatal
    }
  }

  // Get query embedding
  console.log(`[SEMANTIC SEARCH] Getting embedding for query`);
  const queryEmbedding = await getEmbeddingSafe(query);
  if (!queryEmbedding) {
    console.log('[SEMANTIC SEARCH] Failed to get query embedding');
    return 'Semantic search unavailable — embeddings server not responding';
  }

  const eDb = getEmbeddingsDb();

  // Load all project chunks + embeddings for this project
  const projectRows = eDb.prepare(`
    SELECT c.id, c.file_path, c.start_line, c.end_line, c.content, e.embedding
    FROM project_chunks c
    JOIN project_embeddings e ON e.chunk_id = c.id
    WHERE c.project_id = ?
  `).all(conversation.project_id);

  // Load all worktree chunks + embeddings for this conversation
  const worktreeRows = eDb.prepare(`
    SELECT c.id, c.file_path, c.start_line, c.end_line, c.content, e.embedding
    FROM worktree_chunks c
    JOIN worktree_embeddings e ON e.chunk_id = c.id
    WHERE c.conversation_id = ?
  `).all(conversationId);

  // Build lookup of worktree file paths to override project chunks
  const worktreeFiles = new Set();
  const worktreeResults = worktreeRows.map((row) => {
    worktreeFiles.add(row.file_path);
    return row;
  });

  // Filter out project chunks whose file_path exists in worktree
  const projectResults = projectRows.filter((row) => !worktreeFiles.has(row.file_path));

  // Merge and compute similarities
  const allResults = [...projectResults, ...worktreeResults];
  const scoredResults = [];

  for (const row of allResults) {
    const embeddingArray = new Float32Array(row.embedding.buffer.slice(
      row.embedding.byteOffset,
      row.embedding.byteOffset + row.embedding.byteLength
    ));
    // Convert to regular number array for comparison
    const embedding = Array.from(embeddingArray);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    scoredResults.push({
      file: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      similarity,
    });
  }

  // Sort by similarity descending
  scoredResults.sort((a, b) => b.similarity - a.similarity);

  // Return top N
  const topResults = scoredResults.slice(0, maxResults);
  console.log(`[SEMANTIC SEARCH] Search completed, found ${topResults.length} results`);

  if (topResults.length === 0) {
    console.log('[SEMANTIC SEARCH] No relevant code found');
    return 'No relevant code found';
  }

  return topResults;
}

// ── Ensure index (called from routes for lazy init) ──────────────────────────

async function ensureConversationIndexed(conversationId, workingDir) {
  const conversation = getConversationRecord(conversationId);
  if (!conversation) throw new Error('Conversation not found');

  const repoRoot = conversation.folder_path;
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    throw new Error('Project repository not found');
  }

  // Index project if not yet indexed
  if (!isProjectIndexed(conversation.project_id)) {
    await indexProject(conversation.project_id, repoRoot);
  }

  // Index worktree if not yet indexed
  const worktreePath = workingDir || conversation.worktree_path;
  if (worktreePath && fs.existsSync(worktreePath)) {
    const eDb = getEmbeddingsDb();
    const worktreeCount = eDb.prepare(
      'SELECT COUNT(*) AS count FROM worktree_chunks WHERE conversation_id = ?'
    ).get(conversationId);
    if ((worktreeCount?.count || 0) === 0) {
      await indexConversation(conversationId, worktreePath);
    }
  }

  // 'totalFiles'/'totalChunks' are not available here (not returned by the
  // sub-chamadas). Usamos o status do banco como valor de retorno.
  const finalStatus = getIndexStatus(conversationId);
  console.log(`[SEMANTIC SEARCH] Indexing ensured for conversation ${conversationId}: ${finalStatus.chunkCount} chunks`);
  return finalStatus;
}

module.exports = {
  indexProject,
  indexConversation,
  reindexChangedFiles,
  getIndexStatus,
  isModelChanged,
  isEmbeddingsConfigured,
  semanticSearch,
  ensureConversationIndexed,
  closeEmbeddingsDb,
};