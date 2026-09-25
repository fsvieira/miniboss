const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { DatabaseConnection, DatabaseAPI } = require('./db');
const { getWorktreesRoot } = require('../config/paths');

// Singleton instance of the database API
const db = new DatabaseAPI(new DatabaseConnection());

const execFileAsync = promisify(execFile);

function slugify(value, fallback = 'conversation') {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

async function runGit(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    const message = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(message || `Git command failed: git ${args.join(' ')}`);
  }
}

function getConversationRecord(conversationId) {
  return db.getConversationWithProject(conversationId);
}

function normalizeTrackedPaths(paths) {
  if (!Array.isArray(paths)) {
    return [];
  }

  const uniquePaths = new Set();
  for (const value of paths) {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized || normalized === '.') {
      continue;
    }
    uniquePaths.add(normalized);
  }

  return Array.from(uniquePaths);
}

function readTouchedFiles(conversation) {
  if (!conversation?.ai_touched_files) {
    return [];
  }

  try {
    return normalizeTrackedPaths(JSON.parse(conversation.ai_touched_files));
  } catch (_) {
    return [];
  }
}

function writeTouchedFiles(conversationId, paths) {
  const normalizedPaths = normalizeTrackedPaths(paths);
  db.updateConversation(conversationId, { ai_touched_files: JSON.stringify(normalizedPaths) });
  return normalizedPaths;
}

function ensureGitignore(worktreePath) {
  const gitignorePath = path.join(worktreePath, '.gitignore');
  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (_) {}

  const entries = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );

  let changed = false;
  if (!entries.has('package-lock.json')) {
    entries.add('package-lock.json');
    changed = true;
  }

  if (changed) {
    const newContent = Array.from(entries).join('\n') + '\n';
    fs.writeFileSync(gitignorePath, newContent, 'utf8');
  }
}

async function validateProjectRepository(projectPath) {
  if (!projectPath || !String(projectPath).trim()) {
    throw new Error('Project folder is required to create a conversation worktree');
  }

  const resolvedPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Project folder does not exist: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error(`Project folder is not a directory: ${resolvedPath}`);
  }

  const repoRoot = (await runGit(['rev-parse', '--show-toplevel'], resolvedPath)).stdout;
  if (!repoRoot) {
    throw new Error(`Project folder is not inside a Git repository: ${resolvedPath}`);
  }

  return path.resolve(repoRoot);
}

async function getBaseBranch(repoRoot) {
  const branch = (await runGit(['branch', '--show-current'], repoRoot)).stdout;
  if (!branch) {
    throw new Error('Repository is in detached HEAD state. Please checkout a branch before using conversation worktrees.');
  }

  return branch;
}

function getWorktreeBaseDir(repoRoot) {
  const repoName = slugify(path.basename(repoRoot), 'repo');
  return path.join(getWorktreesRoot(), repoName);
}

async function findExistingWorktreeForBranch(repoRoot, branchName) {
  const output = (await runGit(['worktree', 'list', '--porcelain'], repoRoot)).stdout;
  const lines = output.split('\n');
  let currentPath = null;
  let currentBranch = null;

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
      currentBranch = null;
      continue;
    }

    if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).trim().replace('refs/heads/', '');
    }

    if (!line.trim() && currentPath && currentBranch === branchName) {
      return currentPath;
    }
  }

  if (currentPath && currentBranch === branchName) {
    return currentPath;
  }

  return null;
}

async function branchExists(repoRoot, branchName) {
  const output = (await runGit(['branch', '--list', branchName], repoRoot)).stdout;
  return Boolean(output);
}

async function updateConversationGitFields(conversationId, values) {
  return db.updateConversation(conversationId, values);
}

async function ensureConversationWorktree(conversationId) {
  const conversation = getConversationRecord(conversationId);
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  // A conversa global do projeto nunca tem worktree: trabalha diretamente na
  // pasta real (read-only). Criar/remover worktree aqui seria perigoso.
  if (conversation.conversation_type === 'project') {
    throw new Error(`Project Memory conversation ${conversationId} has no worktree: it works directly on the project folder (read-only).`);
  }

  const repoRoot = await validateProjectRepository(conversation.folder_path);
  const baseBranch = conversation.base_branch || await getBaseBranch(repoRoot);
  const branchPrefix = process.env.WORKTREE_BRANCH_PREFIX || 'conversation';
  const branchName = conversation.git_branch || `${branchPrefix}/${conversation.id}-${slugify(conversation.title)}`;
  const worktreeBaseDir = getWorktreeBaseDir(repoRoot);
  const desiredWorktreePath = conversation.worktree_path || path.join(
    worktreeBaseDir,
    `${conversation.id}-${slugify(conversation.title)}`
  );

  fs.mkdirSync(worktreeBaseDir, { recursive: true });

  const existingWorktree = await findExistingWorktreeForBranch(repoRoot, branchName);
  const targetWorktreePath = existingWorktree ? path.resolve(existingWorktree) : path.resolve(desiredWorktreePath);

  if (existingWorktree && existingWorktree !== desiredWorktreePath) {
    await updateConversationGitFields(conversationId, {
      repo_root: repoRoot,
      base_branch: baseBranch,
      git_branch: branchName,
      worktree_path: targetWorktreePath,
    });

    return {
      ...getConversationRecord(conversationId),
      repo_root: repoRoot,
      base_branch: baseBranch,
      git_branch: branchName,
      worktree_path: targetWorktreePath,
    };
  }

  if (!fs.existsSync(targetWorktreePath)) {
    const branchAlreadyExists = await branchExists(repoRoot, branchName);

    if (branchAlreadyExists) {
      await runGit(['worktree', 'add', targetWorktreePath, branchName], repoRoot);
    } else {
      await runGit(['worktree', 'add', '-b', branchName, targetWorktreePath, baseBranch], repoRoot);
    }
  }

  await updateConversationGitFields(conversationId, {
    repo_root: repoRoot,
    base_branch: baseBranch,
    git_branch: branchName,
    worktree_path: targetWorktreePath,
  });

  return {
    ...getConversationRecord(conversationId),
    repo_root: repoRoot,
    base_branch: baseBranch,
    git_branch: branchName,
    worktree_path: targetWorktreePath,
  };
}

function parseStatusLine(line) {
  const staged = line[0];
  const unstaged = line[1];
  const rawPath = line.slice(3);
  const pathValue = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath;

  return {
    path: pathValue,
    staged,
    unstaged,
    raw: line,
  };
}

function parseNameStatusLine(line) {
  const parts = line.split('\t');
  const statusCode = parts[0] || '';
  const status = statusCode[0] || 'M';

  if (status === 'R' || status === 'C') {
    return {
      status,
      oldPath: parts[1] || '',
      path: parts[2] || parts[1] || '',
    };
  }

  return {
    status,
    oldPath: null,
    path: parts[1] || '',
  };
}

function parseNumstatLine(line) {
  const parts = line.split('\t');
  return {
    additions: parts[0] === '-' ? null : Number(parts[0]) || 0,
    deletions: parts[1] === '-' ? null : Number(parts[1]) || 0,
    path: parts[2] || '',
  };
}

function buildDiffArgs(baseArgs, formatArgs, pathArg) {
  const args = ['diff', '--find-renames', '--unified=8', '--no-color', ...formatArgs, ...baseArgs];
  if (pathArg) {
    args.push('--', pathArg);
  }
  return args;
}

async function getDiffSnapshot({ cwd, comparisonArgs, patchCwd }) {
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(buildDiffArgs(comparisonArgs, ['--name-status'], null), cwd),
    runGit(buildDiffArgs(comparisonArgs, ['--numstat'], null), cwd),
  ]);

  const files = nameStatusOutput.stdout
    ? nameStatusOutput.stdout.split('\n').filter(Boolean).map(parseNameStatusLine)
    : [];

  const numstatMap = new Map(
    (numstatOutput.stdout ? numstatOutput.stdout.split('\n').filter(Boolean).map(parseNumstatLine) : [])
      .map((entry) => [entry.path, entry])
  );

  let totalAdditions = 0;
  let totalDeletions = 0;

  const filesWithPatches = await Promise.all(files.map(async (file) => {
    const numstat = numstatMap.get(file.path) || numstatMap.get(file.oldPath) || {
      additions: 0,
      deletions: 0,
    };

    totalAdditions += numstat.additions || 0;
    totalDeletions += numstat.deletions || 0;

    const patchOutput = await runGit(
      buildDiffArgs(comparisonArgs, ['--patch'], file.path),
      patchCwd || cwd
    );

    return {
      ...file,
      additions: numstat.additions,
      deletions: numstat.deletions,
      patch: patchOutput.stdout || '',
    };
  }));

  return {
    files: filesWithPatches,
    summary: {
      filesChanged: filesWithPatches.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
  };
}

async function getConversationGitState(conversationId) {
  const conversation = getConversationRecord(conversationId);
  const isProjectMemory = conversation?.conversation_type === 'project';

  let worktreePath = null;
  let repoRoot = conversation?.repo_root || null;

  if (!isProjectMemory) {
    const worktreeConversation = await ensureConversationWorktree(conversationId);
    worktreePath = worktreeConversation.worktree_path;
    repoRoot = worktreeConversation.repo_root;
  }

  if (!repoRoot) {
    throw new Error('Conversation repository root is not available');
  }

  const cwd = worktreePath || repoRoot;

  let baseBranch = conversation.base_branch;
  let gitBranch = conversation.git_branch;

  if (isProjectMemory && (!baseBranch || !gitBranch)) {
    try {
      const currentBranch = (await runGit(['branch', '--show-current'], repoRoot)).stdout;
      if (!baseBranch) baseBranch = currentBranch || null;
      if (!gitBranch) gitBranch = currentBranch || null;
    } catch (_) {
      // keep nulls if repo is detached/HEADless
    }
  }

  const comparison = baseBranch && gitBranch ? `${baseBranch}...${gitBranch}` : null;
  const aheadBehindPromise = comparison
    ? runGit(['rev-list', '--left-right', '--count', comparison], repoRoot)
    : Promise.resolve({ stdout: '' });

  const [statusOutput, diffStatOutput, cachedDiffStatOutput, aheadBehindOutput] = await Promise.all([
    runGit(['status', '--short'], cwd),
    runGit(['diff', '--stat'], cwd),
    runGit(['diff', '--cached', '--stat'], cwd),
    aheadBehindPromise,
  ]);

  const changedFiles = statusOutput.stdout
    ? statusOutput.stdout.split('\n').filter(Boolean).map(parseStatusLine)
    : [];

  const trackedChangedFiles = changedFiles.filter((file) => {
    const staged = String(file.staged || '').trim();
    const unstaged = String(file.unstaged || '').trim();
    return !(staged === '?' && unstaged === '?');
  });

  const [behindRaw = '0', aheadRaw = '0'] = aheadBehindOutput.stdout.split(/\s+/);
  const isClean = trackedChangedFiles.length === 0;

  return {
    conversationId,
    repoRoot,
    worktreePath,
    folderPath: worktreePath || repoRoot,
    branch: gitBranch,
    baseBranch,
    changedFiles,
    diffStat: diffStatOutput.stdout || '',
    stagedDiffStat: cachedDiffStatOutput.stdout || '',
    ahead: Number(aheadRaw) || 0,
    behind: Number(behindRaw) || 0,
    isClean,
    hasUncommittedChanges: !isClean,
    hasCommitsToMerge: (Number(aheadRaw) || 0) > 0,
    aiTouchedFiles: readTouchedFiles(conversation),
    isProjectMemory,
  };
}

async function getConversationGitDiff(conversationId) {
  const conversation = getConversationRecord(conversationId);
  const isProjectMemory = conversation?.conversation_type === 'project';
  const repoRoot = conversation?.repo_root;

  if (!repoRoot) {
    throw new Error('Conversation repository root is not available');
  }

  let branchReview = null;
  const baseBranch = conversation.base_branch;
  const gitBranch = conversation.git_branch;
  const branchComparison = baseBranch && gitBranch ? `${baseBranch}...${gitBranch}` : null;

  if (branchComparison) {
    try {
      branchReview = await getDiffSnapshot({
        cwd: repoRoot,
        patchCwd: repoRoot,
        comparisonArgs: [branchComparison],
      });
    } catch (error) {
      branchReview = null;
    }
  }

  let workingTreeReview = null;
  if (!isProjectMemory) {
    const worktreeConversation = await ensureConversationWorktree(conversationId);
    const worktreePath = worktreeConversation.worktree_path;
    try {
      workingTreeReview = await getDiffSnapshot({
        cwd: worktreePath,
        patchCwd: worktreePath,
        comparisonArgs: ['HEAD'],
      });
    } catch (error) {
      workingTreeReview = null;
    }
  }

  return {
    conversationId,
    branchReview,
    workingTreeReview,
  };
}

async function commitConversationChanges(conversationId, message) {
  const conversation = await ensureConversationWorktree(conversationId);
  const worktreePath = conversation.worktree_path;
  const commitMessage = String(message || '').trim();

  if (!commitMessage) {
    throw new Error('Commit message is required');
  }

  const status = await getConversationGitState(conversationId);
  if (status.isClean) {
    throw new Error('No changes to commit');
  }

  ensureGitignore(worktreePath);
  await runGit(['commit', '-a', '-m', commitMessage], worktreePath);
  writeTouchedFiles(conversationId, []);

  return getConversationGitState(conversationId);
}

async function mergeConversationBranch(conversationId) {
  const conversation = await ensureConversationWorktree(conversationId);
  const status = await getConversationGitState(conversationId);

  if (status.hasUncommittedChanges) {
    throw new Error('Please commit your conversation changes before merging');
  }

  if (!status.hasCommitsToMerge) {
    throw new Error('No committed changes to merge');
  }

  const currentBaseBranch = (await runGit(['branch', '--show-current'], conversation.repo_root)).stdout;
  if (currentBaseBranch !== conversation.base_branch) {
    throw new Error(`Repository root must be on branch "${conversation.base_branch}" before merging`);
  }

  const repoRootStatus = (await runGit(['status', '--porcelain', '--untracked-files=no'], conversation.repo_root)).stdout;
  if (repoRootStatus) {
    throw new Error('Repository root has tracked local changes. Please clean or commit them before merging conversation changes.');
  }

  await runGit(['merge', '--no-ff', '--no-edit', conversation.git_branch], conversation.repo_root);

  return getConversationGitState(conversationId);
}

async function resetConversationWorktree(conversationId) {
  const conversation = await ensureConversationWorktree(conversationId);
  const worktreePath = conversation.worktree_path;

  await runGit(['reset', '--hard', 'HEAD'], worktreePath);
  await runGit(['clean', '-fd'], worktreePath);
  writeTouchedFiles(conversationId, []);

  return getConversationGitState(conversationId);
}

async function trackConversationTouchedFiles(conversationId, paths) {
  const conversation = getConversationRecord(conversationId);
  if (!conversation) {
    throw new Error('Conversation not found');
  }

  const currentPaths = readTouchedFiles(conversation);
  return writeTouchedFiles(conversationId, [...currentPaths, ...paths]);
}

async function stageConversationTouchedFiles(conversationId, paths) {
  const conversation = await ensureConversationWorktree(conversationId);
  const normalizedPaths = normalizeTrackedPaths(paths);

  if (normalizedPaths.length === 0) {
    return;
  }

  await runGit(['add', '--', ...normalizedPaths], conversation.worktree_path);
}

async function getUntrackedFiles(repoPath) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim() ? stdout.trim().split('\n') : [];
  } catch {
    return [];
  }
}

async function copyExtraFilesToWorktree(conversationId) {
  const conversation = getConversationRecord(conversationId);
  if (!conversation) return;

  // 'project' conversation has no worktree — nothing to copy.
  if (conversation.conversation_type === 'project') return;

  const project = db.getProject(conversation.project_id);
  if (!project || !project.folder_path || !conversation.worktree_path) return;

  const selectedFiles = db.getExtraFilesForProject(project.id);
  if (!selectedFiles.length) return;

  for (const relPath of selectedFiles) {
    const src = path.join(project.folder_path, relPath);
    const dest = path.join(conversation.worktree_path, relPath);
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    } catch (e) {
      console.error('[gitService] Failed to copy extra file', relPath, e.message);
    }
  }
}

async function deleteConversationWorktree(conversationId) {
  const conversation = getConversationRecord(conversationId);
  if (!conversation) return;

  // Never remove worktrees for 'project' conversations — worktree_path is null and
  // the real project folder must not be targeted by 'git worktree remove'.
  if (conversation.conversation_type === 'project') return;

  if (!conversation?.repo_root || !conversation?.worktree_path || !conversation?.git_branch) {
    return;
  }

  if (fs.existsSync(conversation.worktree_path)) {
    try {
      await runGit(['worktree', 'remove', '--force', conversation.worktree_path], conversation.repo_root);
    } catch (error) {
      const message = error.message || '';
      if (!message.includes('is not a working tree') && !message.includes('does not exist')) {
        throw error;
      }
    }
  }

  try {
    const branchExistsNow = await branchExists(conversation.repo_root, conversation.git_branch);
    if (branchExistsNow) {
      await runGit(['branch', '-D', conversation.git_branch], conversation.repo_root);
    }
  } catch (error) {
    const message = error.message || '';
    if (!message.includes('not found')) {
      throw error;
    }
  }
}

module.exports = {
  validateProjectRepository,
  ensureConversationWorktree,
  getConversationGitState,
  getConversationGitDiff,
  commitConversationChanges,
  mergeConversationBranch,
  resetConversationWorktree,
  trackConversationTouchedFiles,
  stageConversationTouchedFiles,
  deleteConversationWorktree,
  getUntrackedFiles,
  copyExtraFilesToWorktree,
};
