const path = require('path');
const { readFile } = require('./tools/fileOperations');
const { searchInFiles, grepInFile, searchFiles } = require('./tools/searchOperations');

const workingDir = path.resolve(__dirname, '..');

async function main() {
  const read = await readFile('README.md', workingDir);
  console.log('READ_FILE=' + JSON.stringify({
    tool: 'readFile',
    path: read.path,
    truncated: read.truncated,
    totalBytes: read.totalBytes,
    returnedBytes: read.returnedBytes,
    totalLines: read.totalLines,
    returnedLines: read.returnedLines,
    nextAction: read.nextAction
  }));

  const files = await searchFiles('**/*.js', workingDir);
  console.log('SEARCH_FILES=' + JSON.stringify({
    tool: 'searchFiles',
    totalFiles: files.totalFiles,
    nextAction: files.nextAction
  }));

  const search = await searchInFiles('MiniBoss', 'README.md', workingDir);
  const returnedMatches = typeof search.preview === 'string' ? search.preview.split('\n').filter(Boolean).length : null;
  console.log('SEARCH_IN_FILES=' + JSON.stringify({
    tool: 'searchInFiles',
    truncated: search.truncated,
    filesSearched: search.filesScanned,
    maxFiles: search.maxFiles,
    totalMatches: search.totalMatches,
    returnedMatches,
    maxResults: search.maxResults,
    nextAction: search.nextAction
  }));

  const grep = await grepInFile('MiniBoss', 'README.md', 0, workingDir);
  console.log('GREP_IN_FILE=' + JSON.stringify({
    tool: 'grepInFile',
    totalMatches: grep.totalMatches,
    truncated: grep.truncated,
    nextAction: grep.nextAction
  }));
}

main().catch((error) => {
  console.error('VERIFY_ERROR=' + JSON.stringify({ message: error.message, stack: error.stack }));
  process.exit(1);
});
