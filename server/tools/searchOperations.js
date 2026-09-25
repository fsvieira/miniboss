const fs = require('fs');
const path = require('path');
const { glob } = require('glob');
const { buildSearchPreview, MAX_SEARCH_RESULTS } = require('./helpers/previewUtils');

async function searchFiles(pattern, workingDir) {
  const files = await glob(pattern, {
    cwd: workingDir,
    ignore: ['node_modules/**', '.git/**'],
    nodir: true
  });

  if (files.length === 0) {
    return 'No files found matching the pattern.';
  }

  return files.join('\n');
}

async function searchInFiles(pattern, filePattern, workingDir) {
  const regex = new RegExp(pattern, 'gi');
  const globPattern = filePattern || '**/*';

  const files = await glob(globPattern, {
    cwd: workingDir,
    ignore: ['node_modules/**', '.git/**'],
    nodir: true
  });

  const formattedMatches = [];
  let filesSearched = 0;
  let totalMatches = 0;
  let truncated = false;

  const MAX_FILES = 200;
  for (const file of files) {
    if (filesSearched >= MAX_FILES) {
      truncated = true;
      break;
    }

    const fullPath = path.join(workingDir, file);

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        if (regex.test(lines[index])) {
          totalMatches++;
          formattedMatches.push(`${file}:${index + 1}  ${lines[index].trim()}`);
          if (formattedMatches.length >= MAX_SEARCH_RESULTS) {
            truncated = true;
            break;
          }
        }
      }

      filesSearched++;
      if (truncated) {
        break;
      }
    } catch (error) {
      // Skip files that can't be read (binary, permissions, etc.)
      continue;
    }
  }

  if (formattedMatches.length === 0) {
    return 'No matches found.';
  }

  const payload = buildSearchPreview({
    pattern,
    filePattern,
    matches: formattedMatches,
    truncated,
    totalMatches,
    filesScanned: filesSearched,
    limitReached: truncated || filesSearched >= MAX_FILES
  });

  if (payload.truncated) {
    console.log(`[Tool:searchInFiles] Preview truncated for pattern "${pattern}": sampled ${formattedMatches.length} matches across ${filesSearched} files`);
  }

  return payload;
}

async function grepInFile(pattern, relativePath, contextLines = 0, workingDir) {
  const { resolvePath } = require('./utilityOperations');
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    return `File not found: ${relativePath}`;
  }

  if (!fs.statSync(fullPath).isFile()) {
    return `Not a file: ${relativePath}`;
  }

  const regex = new RegExp(pattern, 'gi');
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const matches = [];
  let totalMatches = 0;

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      totalMatches++;
      // Reset regex lastIndex after test (needed with 'g' flag)
      regex.lastIndex = 0;

      const startCtx = Math.max(0, i - contextLines);
      const endCtx = Math.min(lines.length, i + contextLines + 1);

      // If there's context, show a header
      if (contextLines > 0 && startCtx > 0 && matches.length > 0) {
        matches.push(`   ...`);
      }

      for (let j = startCtx; j < endCtx; j++) {
        const prefix = j === i ? '  >' : '   ';
        matches.push(`${prefix} ${relativePath}:${j + 1}  ${lines[j]}`);
      }

      if (contextLines > 0 && endCtx < lines.length) {
        matches.push(`   ...`);
      }
    }
  }

  if (totalMatches === 0) {
    return `No matches found for pattern "${pattern}" in ${relativePath}.`;
  }

  return `totalMatches: ${totalMatches}\n` + matches.join('\n');
}

module.exports = {
  searchFiles,
  searchInFiles,
  grepInFile
};
