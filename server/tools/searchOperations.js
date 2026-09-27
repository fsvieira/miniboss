const fs = require('fs');
const path = require('path');
const { glob } = require('glob');
const {
  buildSearchPreview,
  MAX_SEARCH_RESULTS,
  MAX_FILES
} = require('./helpers/previewUtils');

async function searchFiles(pattern, workingDir) {
  const files = await glob(pattern, {
    cwd: workingDir,
    ignore: ['node_modules/**', '.git/**'],
    nodir: true
  });

  return {
    tool: 'searchFiles',
    pattern,
    files,
    totalFiles: files.length
  };
}

async function searchInFiles(pattern, filePattern, workingDir) {
  const regex = new RegExp(pattern, 'gi');
  const globPattern = filePattern || '**/*';

  const files = await glob(globPattern, {
    cwd: workingDir,
    ignore: ['node_modules/**', '.git/**'],
    nodir: true
  });

  const matches = [];
  let filesSearched = 0;
  let totalMatches = 0;
  let truncated = false;

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
          matches.push(`${file}:${index + 1}  ${lines[index].trim()}`);
          if (matches.length >= MAX_SEARCH_RESULTS) {
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
      continue;
    }
  }

  const payload = buildSearchPreview({
    pattern,
    filePattern,
    matches,
    truncated,
    totalMatches,
    filesSearched,
    limitReached: truncated || filesSearched >= MAX_FILES
  });

  if (payload.truncated) {
    console.log(`[Tool:searchInFiles] Preview truncated for pattern "${pattern}": sampled ${matches.length} matches across ${filesSearched} files`);
  }

  return payload;
}

async function grepInFile(pattern, relativePath, contextLines = 0, workingDir) {
  const { resolvePath } = require('./utilityOperations');
  const fullPath = resolvePath(relativePath, workingDir);

  if (!fs.existsSync(fullPath)) {
    return {
      tool: 'grepInFile',
      pattern,
      path: relativePath,
      totalMatches: 0,
      matches: [],
      truncated: false,
      nextAction: 'File not found'
    };
  }

  if (!fs.statSync(fullPath).isFile()) {
    return {
      tool: 'grepInFile',
      pattern,
      path: relativePath,
      totalMatches: 0,
      matches: [],
      truncated: false,
      nextAction: 'Target is not a file'
    };
  }

  const regex = new RegExp(pattern, 'gi');
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const matches = [];
  let totalMatches = 0;

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      totalMatches++;
      regex.lastIndex = 0;

      const startCtx = Math.max(0, i - contextLines);
      const endCtx = Math.min(lines.length, i + contextLines + 1);

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

  return {
    tool: 'grepInFile',
    pattern,
    path: relativePath,
    totalMatches,
    matches,
    truncated: false,
    nextAction:
      totalMatches === 0
        ? 'Broaden the regex or inspect the file with readFile/readFileLines'
        : 'Inspect specific matches or use readFileLines to read surrounding context'
  };
}

module.exports = {
  searchFiles,
  searchInFiles,
  grepInFile
};
