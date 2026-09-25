const MAX_PREVIEW_CHARS = 6000;
const DEFAULT_CHUNK_LIMIT = 4000;
const DEFAULT_LINES_SLICE = 120;
const MAX_SEARCH_RESULTS = 120;
const MAX_SEARCH_PREVIEW_CHARS = 6000;

function buildFilePreview({
  relativePath,
  content,
  maxPreviewChars = MAX_PREVIEW_CHARS
}) {
  const totalChars = content.length;
  const truncated = totalChars > maxPreviewChars;
  const preview = truncated ? content.slice(0, maxPreviewChars) : content;

  const previewLineCount = preview.split('\n').length;

  const decoratedPreview = truncated
    ? `${preview}\n\n[TRUNCATED — ${totalChars} chars total]`
    : preview;

  const nextCommands = truncated
    ? [
        {
          tool: 'readFileLines',
          args: {
            relativePath,
            startLine: previewLineCount + 1,
            numLines: DEFAULT_LINES_SLICE
          },
          description: `Read the next ${DEFAULT_LINES_SLICE} lines starting at line ${previewLineCount + 1}.`
        },
        {
          tool: 'readFileChunk',
          args: {
            relativePath,
            offset: maxPreviewChars,
            limit: DEFAULT_CHUNK_LIMIT
          },
          description: `Read the next ${DEFAULT_CHUNK_LIMIT} characters starting at byte offset ${maxPreviewChars}.`
        }
      ]
    : [
        {
          tool: 'readFileLines',
          args: {
            relativePath,
            startLine: 1,
            numLines: Math.min(previewLineCount, DEFAULT_LINES_SLICE)
          },
          description: 'Use targeted line windows when you only need a slice of this file.'
        }
      ];

  return {
    path: relativePath,
    totalChars,
    truncated,
    preview: decoratedPreview,
    nextCommands
  };
}

function buildMultiFilePreview(entries) {
  return {
    files: entries,
    truncatedEntries: entries.filter(entry => entry?.truncated).length,
    note: entries.some(entry => entry?.truncated)
      ? 'One or more previews truncated. Follow the suggested nextCommands per file to continue reading in slices.'
      : 'All previews fit within the 6k character window.'
  };
}

function buildSearchPreview({
  pattern,
  filePattern,
  matches,
  truncated,
  totalMatches,
  filesScanned,
  limitReached
}) {
  const limitedMatches = matches.slice(0, MAX_SEARCH_RESULTS);
  let preview = limitedMatches.join('\n');
  let previewTruncated = truncated;

  if (preview.length > MAX_SEARCH_PREVIEW_CHARS) {
    preview = `${preview.slice(0, MAX_SEARCH_PREVIEW_CHARS)}\n\n[TRUNCATED — ${preview.length} chars sampled]`;
    previewTruncated = true;
  }

  return {
    pattern,
    filePattern: filePattern || '**/*',
    filesScanned,
    totalMatches,
    truncated: previewTruncated,
    preview,
    note: limitReached
      ? 'Search stopped after reaching the sampling limit. Narrow filePattern or refine the regex to continue.'
      : 'Preview limited to first matches. Use readFileLines or readFileChunk on specific files for context.'
  };
}

module.exports = {
  MAX_PREVIEW_CHARS,
  DEFAULT_CHUNK_LIMIT,
  DEFAULT_LINES_SLICE,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_PREVIEW_CHARS,
  buildFilePreview,
  buildMultiFilePreview,
  buildSearchPreview
};
