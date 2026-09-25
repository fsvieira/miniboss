const fs = require('fs');
const path = require('path');
const { resolvePath } = require('./utilityOperations');
const { buildFilePreview } = require('./helpers/previewUtils');

async function readFile(relativePath, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const preview = buildFilePreview({ relativePath, content });

  if (preview.truncated) {
    console.log(`[Tool:readFile] Preview truncated for ${relativePath}: ${preview.totalChars} chars`);
  }

  return preview;
}

async function readFileChunk(relativePath, offset = 0, limit = 20000, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  const stats = fs.statSync(fullPath);
  const fileSize = stats.size;

  if (offset >= fileSize) {
    return 'Offset is beyond file size. File is empty or offset is too large.';
  }

  const actualLimit = Math.min(limit, fileSize - offset);
  const buffer = Buffer.alloc(actualLimit);
  const fd = fs.openSync(fullPath, 'r');
  const bytesRead = fs.readSync(fd, buffer, 0, actualLimit, offset);
  fs.closeSync(fd);

  const content = buffer.toString('utf-8', 0, bytesRead);

  return content;
}

async function writeFile(relativePath, content, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);
  const dirPath = path.dirname(fullPath);
  const existedBeforeWrite = fs.existsSync(fullPath);

  // Create intermediate directories
  fs.mkdirSync(dirPath, { recursive: true });

  fs.writeFileSync(fullPath, content, 'utf-8');

  return {
    message: `File written successfully: ${relativePath}`,
    path: relativePath,
    existed: existedBeforeWrite,
    overwritten: existedBeforeWrite,
    created: !existedBeforeWrite,
  };
}

async function editFile(relativePath, oldString, newString, replaceAll = false, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf-8');

  let newContent;
  let occurrences = 0;

  if (replaceAll) {
    const regex = new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    newContent = content.replace(regex, () => {
      occurrences++;
      return newString;
    });
  } else {
    const index = content.indexOf(oldString);
    if (index === -1) {
      throw new Error(`String not found in file: "${oldString.substring(0, 50)}${oldString.length > 50 ? '...' : ''}"`);
    }
    newContent = content.substring(0, index) + newString + content.substring(index + oldString.length);
    occurrences = 1;
  }

  if (occurrences === 0) {
    throw new Error('No replacements made');
  }

  fs.writeFileSync(fullPath, newContent, 'utf-8');

  return {
    message: `File edited successfully: ${relativePath} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`,
    path: relativePath,
    replacements: occurrences,
  };
}

async function moveFile(fromPath, toPath, workingDir) {
  const fullFromPath = resolvePath(fromPath, workingDir);
  const fullToPath = resolvePath(toPath, workingDir);

  if (!fs.existsSync(fullFromPath)) {
    throw new Error(`Source file not found: ${fromPath}`);
  }

  // Create intermediate directories for destination
  const toDirPath = path.dirname(fullToPath);
  fs.mkdirSync(toDirPath, { recursive: true });

  fs.renameSync(fullFromPath, fullToPath);

  return `File moved successfully: ${fromPath} → ${toPath}`;
}

async function deleteFile(relativePath, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  fs.unlinkSync(fullPath);

  return `File deleted successfully: ${relativePath}`;
}

async function copyFile(fromPath, toPath, workingDir) {
  const fullFromPath = resolvePath(fromPath, workingDir);
  const fullToPath = resolvePath(toPath, workingDir);
  const existedBeforeCopy = fs.existsSync(fullToPath);

  if (!fs.existsSync(fullFromPath)) {
    throw new Error(`Source file not found: ${fromPath}`);
  }

  if (!fs.statSync(fullFromPath).isFile()) {
    throw new Error(`Source is not a file: ${fromPath}`);
  }

  // Create intermediate directories for destination
  const toDirPath = path.dirname(fullToPath);
  fs.mkdirSync(toDirPath, { recursive: true });

  fs.copyFileSync(fullFromPath, fullToPath);

  return {
    message: `File copied successfully: ${fromPath} → ${toPath}`,
    path: toPath,
    created: !existedBeforeCopy,
  };
}

async function readFileLines(relativePath, startLine = 1, numLines = 50, workingDir) {
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Convert 1-based startLine to 0-based index
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(totalLines, startIndex + numLines);

  if (startIndex >= totalLines) {
    return `Start line ${startLine} exceeds file length (${totalLines} lines).`;
  }

  const selectedLines = lines.slice(startIndex, endIndex);
  let result = `File: ${relativePath} (${totalLines} lines total)\n`;
  result += `Showing lines ${startIndex + 1}-${endIndex}:\n\n`;

  result += selectedLines.map((line, i) => {
    const lineNum = startIndex + i + 1;
    return `${String(lineNum).padStart(6, ' ')} | ${line}`;
  }).join('\n');

  if (endIndex < totalLines) {
    result += `\n\n[... ${totalLines - endIndex} more lines. Use readFileLines with startLine=${endIndex + 1} to continue ...]`;
  }

  return result;
}

module.exports = {
  readFile,
  readFileChunk,
  readFileLines,
  writeFile,
  editFile,
  moveFile,
  deleteFile,
  copyFile
};
