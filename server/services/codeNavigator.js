'use strict';

/**
 * Code Navigator service.
 *
 * Read-only navigation and search over the git-tracked files of a project
 * repository. All file access is validated against the `git ls-files` list, so
 * untracked files and path traversal are never reachable.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 1 * 1024 * 1024; // ~1 MB
const BINARY_PROBE_BYTES = 8000; // NUL byte anywhere in the first bytes => binary
const MAX_SEARCH_RESULTS = 200;
const TRACKED_CACHE_TTL_MS = 30 * 1000; // 30s

/**
 * Typed error that maps cleanly to an HTTP status in the route layer.
 */
class CodeNavigatorError extends Error {
  constructor(message, code = 'internal') {
    super(message);
    this.code = code;
  }
}

// In-memory cache of tracked file lists, keyed by project id.
const trackedCache = new Map();

/**
 * Lists the git-tracked files of a repository.
 * @param {string} repoRoot - resolved repo root (from `project.folder_path`).
 * @returns {Promise<string[]>} relative paths (never include `.git`).
 */
async function runGitLsFiles(repoRoot) {
  const { stdout } = await execFileAsync('git', ['ls-files'], {
    cwd: repoRoot,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      // Skip submodule entries, which git lists with a trailing slash.
      return !line.endsWith('/');
    });
}

/**
 * Cached wrapper around `runGitLsFiles`. Falls back to a live fetch when the
 * cache is missing or stale.
 * @param {number} projectId
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
async function getTrackedFiles(projectId, repoRoot) {
  const entry = trackedCache.get(projectId);
  if (entry && Date.now() - entry.timestamp < TRACKED_CACHE_TTL_MS) {
    return entry.files;
  }
  const files = await runGitLsFiles(repoRoot);
  trackedCache.set(projectId, { files, timestamp: Date.now() });
  return files;
}

/**
 * Invalidates the tracked-files cache for a project. Call after a project's
 * `folder_path` changes.
 * @param {number} projectId
 */
function invalidateCache(projectId) {
  trackedCache.delete(projectId);
}

/**
 * Detects whether a buffer looks like a binary file (NUL byte in the probe).
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isBinary(buf) {
  const probe = buf.length > BINARY_PROBE_BYTES ? buf.subarray(0, BINARY_PROBE_BYTES) : buf;
  return probe.includes(0);
}

/**
 * Validates a relative path against the tracked-file list and resolves it to an
 * absolute path inside `repoRoot`. Rejects absolute paths and `..` segments.
 * @param {string} repoRoot
 * @param {string} relpath
 * @param {string[]} trackedFiles
 * @returns {string} resolved absolute path
 */
function resolveTrackedFile(repoRoot, relpath, trackedFiles) {
  const raw = String(relpath || '').replace(/\\/g, '/');
  if (!raw) {
    throw new CodeNavigatorError('A file path is required', 'not-found');
  }
  if (path.isAbsolute(raw) || raw.includes('..')) {
    throw new CodeNavigatorError('Invalid file path', 'not-found');
  }

  // Normalize separators, leading slashes and dot segments before lookup.
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized.startsWith('.') || normalized.startsWith('/')) {
    throw new CodeNavigatorError('Invalid file path', 'not-found');
  }

  const set = new Set(trackedFiles);
  if (!set.has(normalized)) {
    throw new CodeNavigatorError('File is not in the tracked repository', 'not-found');
  }

  return path.resolve(repoRoot, normalized);
}

/**
 * Reads and decodes a tracked text file, enforcing the size cap and binary
 * detection.
 * @param {string} repoRoot
 * @param {string} relpath
 * @param {string[]} trackedFiles
 * @returns {{ content: string, lineCount: number, path: string }}
 */
function readTextFile(repoRoot, relpath, trackedFiles) {
  const resolved = resolveTrackedFile(repoRoot, relpath, trackedFiles);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    throw new CodeNavigatorError('File is not in the tracked repository', 'not-found');
  }
  if (!stat.isFile()) {
    throw new CodeNavigatorError('Not a regular file', 'not-found');
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new CodeNavigatorError(`File exceeds the ${Math.round(MAX_FILE_BYTES / 1024)} KB limit`, 'too-large');
  }

  let buf;
  try {
    buf = fs.readFileSync(resolved);
  } catch (_) {
    throw new CodeNavigatorError('Could not read the file', 'not-found');
  }

  if (isBinary(buf)) {
    throw new CodeNavigatorError('Binary file cannot be previewed', 'binary');
  }

  const content = buf.toString('utf8');
  const lineCount = content.split('\n').length;
  return { content, lineCount, path: relpath };
}

/**
 * Searches file contents with `git grep`. Exit code 1 (no matches) is treated
 * as empty results. `-I` skips binary files; `-F` treats the query literally.
 * @param {string} repoRoot
 * @param {string} q
 * @returns {Promise<Array<{file: string, line: number, text: string}>>}
 */
async function searchContent(repoRoot, q) {
  const term = String(q || '').trim();
  if (!term) return [];

  let stdout;
  try {
    const result = await execFileAsync('git', ['grep', '-n', '-i', '-I', '-F', term, '--', '.'], {
      cwd: repoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    // Exit code 1 means "no matches"; anything else is a real failure.
    if (err && err.code === 1) {
      return [];
    }
    const message = err?.stderr?.trim() || err?.message || 'Search failed';
    throw new CodeNavigatorError(message, 'search-error');
  }

  const results = [];
  for (const line of stdout.split('\n')) {
    if (!line || results.length >= MAX_SEARCH_RESULTS) break;
    // git grep -n emits `file:line:content`; content may itself contain colons.
    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) continue;
    const lineSep = line.indexOf(':', sepIndex + 1);
    if (lineSep === -1) continue;
    const file = line.slice(0, sepIndex);
    const lineNo = Number(line.slice(sepIndex + 1, lineSep));
    const text = line.slice(lineSep + 1);
    results.push({ file, line: Number.isFinite(lineNo) ? lineNo : 0, text });
  }
  return results;
}

module.exports = {
  getTrackedFiles,
  invalidateCache,
  isBinary,
  resolveTrackedFile,
  readTextFile,
  searchContent,
  CodeNavigatorError,
  MAX_FILE_BYTES,
  MAX_SEARCH_RESULTS,
};
