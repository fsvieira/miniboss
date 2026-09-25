function getTouchedPaths(toolName, args) {
  switch (toolName) {
    case 'writeFile':
    case 'editFile':
      return [args.path];
    case 'copyFile':
      return [args.to];
    case 'moveFile':
      return [args.from, args.to];
    case 'deleteFile':
      return [args.path];
    default:
      return [];
  }
}

function getAutoStagePaths(toolName, args, result) {
  if (!result || typeof result !== 'object') {
    return [];
  }

  switch (toolName) {
    case 'writeFile':
    case 'editFile':
      return result.created ? [args.path] : [];
    case 'copyFile':
      return result.created ? [args.to] : [];
    default:
      return [];
  }
}

module.exports = {
  getTouchedPaths,
  getAutoStagePaths
};