const fs = require('fs');
const path = require('path');
const { resolvePath } = require('./utilityOperations');

async function listDirectory(relativePath, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Directory not found: ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isDirectory()) {
    throw new Error(`Not a directory: ${relativePath}`);
  }

  const entries = fs.readdirSync(fullPath);
  const results = [];

  for (const entry of entries) {
    const entryPath = path.join(fullPath, entry);
    const stats = fs.statSync(entryPath);
    const prefix = stats.isDirectory() ? 'dir:' : 'file:';
    results.push(`${prefix} ${entry}`);
  }

  return results.join('\n');
}

async function getFileTree(relativePath = '.', maxDepth = 4, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Directory not found: ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isDirectory()) {
    throw new Error(`Not a directory: ${relativePath}`);
  }

  const ignoreDirs = ['node_modules', '.git', 'dist', '.next', 'build', 'coverage'];
  const results = [];

  function buildTree(currentPath, depth, indent) {
    if (depth > maxDepth) {
      return;
    }

    const entries = fs.readdirSync(currentPath);

    for (const entry of entries) {
      if (ignoreDirs.includes(entry)) {
        continue;
      }

      const entryPath = path.join(currentPath, entry);
      const stats = fs.statSync(entryPath);

      if (stats.isDirectory()) {
        results.push(`${indent}${entry}/`);
        buildTree(entryPath, depth + 1, indent + '  ');
      } else {
        results.push(`${indent}${entry}`);
      }
    }
  }

  buildTree(fullPath, 1, '');

  return results.join('\n');
}

async function createDirectory(relativePath, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  fs.mkdirSync(fullPath, { recursive: true });

  return `Directory created successfully: ${relativePath}`;
}

module.exports = {
  listDirectory,
  getFileTree,
  createDirectory
};