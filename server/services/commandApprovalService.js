const crypto = require('crypto');
const path = require('path');

function hashRule(rule) {
  return crypto.createHash('sha256').update(JSON.stringify(rule)).digest('hex');
}

function isInsideDirectory(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePathToken(token, cwd, worktreePath) {
  if (!token || !cwd || !worktreePath) {
    return { ok: false, reason: 'missing_path_context' };
  }

  const resolvedCwd = path.resolve(cwd);
  const resolvedWorktree = path.resolve(worktreePath);
  const resolvedToken = path.resolve(resolvedCwd, token);

  if (!isInsideDirectory(resolvedToken, resolvedWorktree)) {
    return {
      ok: false,
      reason: 'path_outside_worktree',
      resolvedPath: resolvedToken
    };
  }

  return {
    ok: true,
    resolvedPath: resolvedToken
  };
}

function tokenizeSimpleCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, reason: 'empty_command' };
  }

  const tokens = [];
  let current = '';
  let state = 'normal';

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];

    if (state === 'normal') {
      if (char === '\\') {
        if (i + 1 >= command.length) {
          return { ok: false, reason: 'dangling_escape' };
        }
        current += command[i + 1];
        i += 1;
        continue;
      }

      if (char === "'") {
        state = 'single';
        continue;
      }

      if (char === '"') {
        state = 'double';
        continue;
      }

      if (/\s/.test(char)) {
        flush();
        continue;
      }

      if (char === ';' || char === '|' || char === '&' || char === '>' || char === '<' || char === '`') {
        return { ok: false, reason: `unsupported_operator:${char}` };
      }

      if (char === '$' && next === '(') {
        return { ok: false, reason: 'unsupported_command_substitution' };
      }

      current += char;
      continue;
    }

    if (state === 'single') {
      if (char === "'") {
        state = 'normal';
      } else {
        current += char;
      }
      continue;
    }

    if (state === 'double') {
      if (char === '\\') {
        if (i + 1 >= command.length) {
          return { ok: false, reason: 'dangling_escape' };
        }
        current += command[i + 1];
        i += 1;
        continue;
      }

      if (char === '"') {
        state = 'normal';
      } else {
        current += char;
      }
    }
  }

  if (state !== 'normal') {
    return { ok: false, reason: 'unclosed_quote' };
  }

  flush();

  if (tokens.length === 0) {
    return { ok: false, reason: 'empty_command' };
  }

  return { ok: true, tokens };
}

function parseSimpleCommand(command, cwd, worktreePath) {
  const tokenized = tokenizeSimpleCommand(command);
  if (!tokenized.ok) {
    return {
      ok: false,
      type: 'unsupported',
      reason: tokenized.reason,
      command,
      cwd,
      worktreePath
    };
  }

  const tokens = tokenized.tokens;
  const parts = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const kind = token !== '-' && token.startsWith('-') ? 'flag' : 'arg';
    parts.push({
      index: i - 1,
      rawIndex: i,
      kind,
      value: token
    });
  }

  return {
    ok: true,
    type: 'simple',
    command,
    cwd,
    worktreePath,
    tokens,
    executable: tokens[0],
    parts
  };
}

function buildRuleFromTemplate(parsedCommand, template) {
  const normalizedTemplate = {
    version: 1,
    executable: parsedCommand.executable,
    cwdMode: template.cwdMode || 'literal',
    cwdValue: template.cwdMode === 'literal' ? (parsedCommand.cwd || null) : null,
    parts: parsedCommand.parts.map((part) => {
      const selected = template.parts?.find((candidate) => candidate.index === part.index);
      const mode = selected?.mode || (part.kind === 'flag' ? 'literal' : 'literal');
      return {
        index: part.index,
        kind: part.kind,
        mode,
        value: mode === 'literal' ? part.value : null
      };
    })
  };

  return normalizedTemplate;
}

function validateTemplate(parsedCommand, template) {
  if (!parsedCommand?.ok || parsedCommand.type !== 'simple') {
    return { ok: false, reason: 'unsupported_command' };
  }

  if (!template || !Array.isArray(template.parts)) {
    return { ok: false, reason: 'invalid_template' };
  }

  for (const part of parsedCommand.parts) {
    const selected = template.parts.find((candidate) => candidate.index === part.index);
    if (!selected) {
      return { ok: false, reason: `missing_part_${part.index}` };
    }

    if (part.kind === 'flag' && selected.mode !== 'literal') {
      return { ok: false, reason: `flag_${part.index}_must_be_literal` };
    }

    if (!['literal', 'path', 'value'].includes(selected.mode)) {
      return { ok: false, reason: `invalid_mode_${part.index}` };
    }
  }

  if (!['literal', 'worktree_path'].includes(template.cwdMode || 'literal')) {
    return { ok: false, reason: 'invalid_cwd_mode' };
  }

  return { ok: true };
}

function matchRule(parsedCommand, rule, context) {
  if (!parsedCommand?.ok || parsedCommand.type !== 'simple') {
    return false;
  }

  if (!rule || rule.executable !== parsedCommand.executable) {
    return false;
  }

  if (!Array.isArray(rule.parts) || rule.parts.length !== parsedCommand.parts.length) {
    return false;
  }

  const cwdInsideWorktree = resolvePathToken('.', parsedCommand.cwd, context.worktreePath);
  if (!cwdInsideWorktree.ok) {
    return false;
  }

  if ((rule.cwdMode || 'literal') === 'literal') {
    if ((rule.cwdValue || null) !== (parsedCommand.cwd || null)) {
      return false;
    }
  } else if (rule.cwdMode === 'worktree_path') {
    const cwdValidation = resolvePathToken('.', parsedCommand.cwd, context.worktreePath);
    if (!cwdValidation.ok) {
      return false;
    }
  } else {
    return false;
  }

  for (const rulePart of rule.parts) {
    const commandPart = parsedCommand.parts.find((part) => part.index === rulePart.index);
    if (!commandPart || commandPart.kind !== rulePart.kind) {
      return false;
    }

    if (rulePart.mode === 'literal') {
      if (rulePart.value !== commandPart.value) {
        return false;
      }
      continue;
    }

    if (rulePart.mode === 'value') {
      if (!commandPart.value) {
        return false;
      }
      continue;
    }

    if (rulePart.mode === 'path') {
      const validation = resolvePathToken(commandPart.value, parsedCommand.cwd, context.worktreePath);
      if (!validation.ok) {
        return false;
      }
      continue;
    }

    return false;
  }

  return true;
}

function findMatchingRule(db, parsedCommand, context) {
  if (!parsedCommand?.ok || parsedCommand.type !== 'simple') {
    return null;
  }

  const rules = db.getAutoApprovalRulesByCommand(parsedCommand.executable);
  for (const row of rules) {
    let parsedRule = null;
    try {
      parsedRule = JSON.parse(row.rule_json);
    } catch {
      parsedRule = null;
    }

    if (parsedRule && matchRule(parsedCommand, parsedRule, context)) {
      return row;
    }
  }

  return null;
}

/**
 * Check if sandbox mode is enabled and bwrap is available
 * This allows skipping authorization when running in a sandbox
 * @param {Object} sandboxOpts - Sandbox options { enabled, repoRoot, worktreePath }
 * @returns {boolean} True if sandbox is active and can skip auth
 */
function isSandboxed(sandboxOpts = {}) {
  const { enabled = false, repoRoot, worktreePath } = sandboxOpts;
  if (!enabled || !repoRoot || !worktreePath) {
    return false;
  }
  try {
    const { execSync } = require('child_process');
    execSync('which bwrap', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  buildRuleFromTemplate,
  findMatchingRule,
  hashRule,
  parseSimpleCommand,
  resolvePathToken,
  tokenizeSimpleCommand,
  validateTemplate,
  isSandboxed
};
