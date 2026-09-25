const fs = require('fs');
const path = require('path');
const { glob } = require('glob');
const { buildFilePreview, buildMultiFilePreview } = require('./helpers/previewUtils');

/**
 * Validates that a resolved path is within the workingDir
 * Prevents path traversal attacks
 */
function validatePath(resolvedPath, workingDir) {
  const normalizedWorkingDir = path.resolve(workingDir);
  const normalizedPath = path.resolve(resolvedPath);

  if (!normalizedPath.startsWith(normalizedWorkingDir)) {
    throw new Error(`Path traversal detected: ${resolvedPath} is outside working directory`);
  }

  return normalizedPath;
}

/**
 * Resolves a relative path against workingDir and validates it
 */
function resolvePath(relativePath, workingDir) {
  const resolved = path.resolve(workingDir, relativePath);
  return validatePath(resolved, workingDir);
}

async function readMultipleFiles(paths, workingDir) {
  if (!Array.isArray(paths)) {
    throw new Error('paths must be an array');
  }

  // Expand globs if any path contains wildcard chars
  let expandedPaths = [];
  for (const p of paths) {
    if (p.includes('*') || p.includes('?') || p.includes('[')) {
      const matches = await glob(p, { cwd: workingDir, nodir: true, ignore: ['node_modules/**'] });
      expandedPaths.push(...matches);
    } else {
      expandedPaths.push(p);
    }
  }
  paths = expandedPaths;

  if (paths.length > 20) {
    throw new Error('Maximum 20 files allowed');
  }

  const results = [];

  for (const relativePath of paths) {
    try {
      const fullPath = resolvePath(relativePath, workingDir);

      if (!fs.existsSync(fullPath)) {
        results.push({ path: relativePath, error: 'File not found' });
        continue;
      }

      if (!fs.statSync(fullPath).isFile()) {
        results.push({ path: relativePath, error: 'Not a file' });
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const preview = buildFilePreview({ relativePath, content });
      if (preview.truncated) {
        console.log(`[Tool:readMultipleFiles] Preview truncated for ${relativePath}: ${preview.totalChars} chars`);
      }
      results.push(preview);
    } catch (error) {
      results.push({ path: relativePath, error: error.message });
    }
  }

  return buildMultiFilePreview(results);
}

async function getFileInfo(relativePath, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  const stats = fs.statSync(fullPath);

  let isBinary = false;
  if (stats.isFile()) {
    // Check for null bytes in first 512 bytes to detect binary files
    const buffer = Buffer.alloc(512);
    const fd = fs.openSync(fullPath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        isBinary = true;
        break;
      }
    }
  }

  // Count lines for text files
  let lineCount = null;
  let charCount = stats.size;
  if (stats.isFile() && !isBinary) {
    const content = fs.readFileSync(fullPath, 'utf-8');
    charCount = content.length;
    lineCount = content.split('\n').length;
  }

  const info = {
    path: relativePath,
    sizeBytes: stats.size,
    charCount,
    lineCount,
    lastModified: stats.mtime.toISOString(),
    isDirectory: stats.isDirectory(),
    isBinary,
    extension: path.extname(relativePath)
  };

  return JSON.stringify(info, null, 2);
}

module.exports = {
  validatePath,
  resolvePath,
  readMultipleFiles,
  getFileInfo
};
