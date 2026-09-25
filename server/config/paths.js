const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config();

const APP_NAME = 'miniboss';

function getProjectRoot() {
  return path.resolve(__dirname, '..', '..');
}

function resolveConfiguredDataFolder() {
  const configuredDataFolder = process.env.DATA_FOLDER?.trim();
  if (configuredDataFolder) {
    return path.resolve(configuredDataFolder);
  }

  // Default to ./data relative to project root
  return path.join(getProjectRoot(), 'data');
}

function ensureDirectoryExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

function getDataFolder() {
  const dataFolder = resolveConfiguredDataFolder();
  ensureDirectoryExists(dataFolder);
  return dataFolder;
}

function getDatabasePath() {
  const explicitDatabasePath = process.env.DATABASE_PATH?.trim();
  if (explicitDatabasePath) {
    const resolvedDatabasePath = path.resolve(explicitDatabasePath);
    ensureDirectoryExists(path.dirname(resolvedDatabasePath));
    return resolvedDatabasePath;
  }

  return path.join(getDataFolder(), 'chat.db');
}

function getWorktreesRoot() {
  const worktreesRoot = path.join(getDataFolder(), 'worktrees');
  ensureDirectoryExists(worktreesRoot);
  return worktreesRoot;
}

module.exports = {
  APP_NAME,
  getDataFolder,
  getDatabasePath,
  getWorktreesRoot,
};
