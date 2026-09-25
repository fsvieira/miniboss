// Safely serialize a tool result to a string that can be sent back to the LLM.
function safeSerializeToolResult(result) {
  try {
    if (result === null || result === undefined) return 'null';
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  } catch (_) {
    return 'null';
  }
}

const MAX_TOOL_RESULT_LENGTH = 3000;

function truncateToolResult(result, toolName) {
  if (typeof result !== 'string') return result;
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result;
  const truncated = result.substring(0, MAX_TOOL_RESULT_LENGTH);
  return `${truncated}\n\n[...truncated: ${result.length} chars total. Use the tool again to read specific sections if needed.]`;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.status === 499;
}

function getToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map(tool => tool?.function?.name)
    .filter(Boolean);
}

module.exports = {
  safeSerializeToolResult,
  truncateToolResult,
  isAbortError,
  getToolNames,
  MAX_TOOL_RESULT_LENGTH,
};