const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function buildBwrapArgs(repoRoot, worktreePath, extraPaths = [], options = {}) {
  const readOnlyWorktree = options.readOnlyWorktree === true;

  const worktreeFlag = readOnlyWorktree ? '--ro-bind' : '--bind';
  const args = [
    'bwrap',
    '--ro-bind', repoRoot, repoRoot,
  ];

  // When worktreePath === repoRoot (ex: 'project' conversation works directly
  // in the real folder), do not repeat the bind — bwrap would fail with duplicate mount.
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);
  if (resolvedRepoRoot !== resolvedWorktreePath) {
    args.push(worktreeFlag, worktreePath, worktreePath);
  }

  args.push(
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/run', '/run',
    '--share-net',
    '--die-with-parent',
  );

  // Add extra configured paths (e.g. ~/.nvm, ~/.npm, etc.)
  for (const entry of extraPaths || []) {
    const targetPath = entry.path || entry;
    const writable = entry.writable === true || entry.access_mode === 'write';
    const resolvedPath = path.resolve(targetPath);

    // Skip if path doesn't exist (bwrap would fail)
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`[shellExecutor] Skipping sandbox path (does not exist): ${resolvedPath}`);
      continue;
    }

    const flag = writable ? '--bind' : '--ro-bind';
    args.push(flag, resolvedPath, resolvedPath);
  }

  return args;
}

async function runShellCommand(command, cwd = '.', timeoutMs = 0, sandboxOpts = {}) {
  const { repoRoot, worktreePath, extraPaths, readOnlyWorktree } = sandboxOpts;

  if (!repoRoot || !worktreePath) {
    throw new Error('[shellExecutor] Sandbox requires repoRoot and worktreePath');
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedCwd = path.resolve(cwd);

  const relative = path.relative(resolvedWorktreePath, resolvedCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[shellExecutor] cwd "${resolvedCwd}" is outside worktree "${resolvedWorktreePath}"`);
  }

  const bwrapArgs = buildBwrapArgs(resolvedRepoRoot, resolvedWorktreePath, extraPaths, { readOnlyWorktree });
  const escapedCommand = command.replace(/'/g, "'\\''");
  const fullCommand = [...bwrapArgs, '--', '/bin/sh', '-c', `'${escapedCommand}'`].join(' ');

  console.log('[shellExecutor] Running command in sandbox', { cwd: resolvedCwd, command: command.slice(0, 100) });

  return runCommandDirect(fullCommand, cwd, timeoutMs);
}

function runCommandDirect(command, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
    };

    const doResolve = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const doReject = (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    };

    child.stdout?.on('data', (data) => {
      stdout += data;
    });

    child.stderr?.on('data', (data) => {
      stderr += data;
    });

    const timeoutId = timeoutMs > 0 ? setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (e) {}
    }, timeoutMs) : null;

    let killTimeoutId = null;
    const forceKill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (e) {}
    };

    child.on('close', (code, signal) => {
      if (killed && !killTimeoutId) {
        killTimeoutId = setTimeout(forceKill, 5000);
      }

      let exitCode = code;
      if (signal) {
        exitCode = 128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGKILL' ? 9 : 1);
      }
      if (killed && (code === null || code === 0)) {
        exitCode = 124;
      }

      const stderrTrimmed = stderr.trim();
      const stdoutTrimmed = stdout.trim();

      const isBwrapError = stderrTrimmed.startsWith('bwrap:') || 
                           stderrTrimmed.includes('bubblewrap') ||
                           stderrTrimmed.includes('Can\'t find source path') ||
                           stderrTrimmed.includes('Permission denied') && stderrTrimmed.includes('bwrap');

      const isSandboxBlocked = exitCode === 0 && (
        stderrTrimmed.includes('Permission denied') ||
        stderrTrimmed.includes('Read-only file system') ||
        stderrTrimmed.includes('Operation not permitted')
      );

      if (isBwrapError) {
        doReject(new Error(`Sandbox error: ${stderrTrimmed || 'bwrap failed to start sandbox'}`));
        return;
      }

      if (isSandboxBlocked) {
        doResolve({
          stdout: stdoutTrimmed,
          stderr: `Command blocked by sandbox: cannot write outside worktree\n${stderrTrimmed}`,
          exitCode: 1,
          failed: true
        });
        return;
      }

      doResolve({
        stdout: stdoutTrimmed,
        stderr: stderrTrimmed || (killed ? `Command timed out after ${timeoutMs}ms` : ''),
        exitCode: exitCode || 0,
        failed: exitCode !== 0 && !killed
      });
    });

    child.on('error', (err) => {
      doReject(err);
    });
  });
}

module.exports = { runShellCommand, buildBwrapArgs };