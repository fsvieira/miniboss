import React, { useState, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { Box, Typography } from '@mui/material';
import chatStore from '../stores/chatStore';
import FocusCard from './FocusCard';



const TOOL_NAMES = {
  read_file: { shortName: 'read_file', icon: '📖' },
  write_to_file: { shortName: 'write_to_file', icon: '📝' },
  replace_in_file: { shortName: 'replace_in_file', icon: '🔍' },
  search_files: { shortName: 'search_files', icon: '🔎' },
  list_files: { shortName: 'list_files', icon: '📂' },
  list_code_definition_names: { shortName: 'list_code_definition_names', icon: '📋' },
  execute_command: { shortName: 'execute_command', icon: '⚡' },
  ask_followup_question: { shortName: 'ask_followup_question', icon: '❓' },
  attempt_completion: { shortName: 'attempt_completion', icon: '✅' },
  use_mcp_tool: { shortName: 'use_mcp_tool', icon: '🔧' },
  access_mcp_resource: { shortName: 'access_mcp_resource', icon: '🔗' },
};

const DEFAULT_ICON = '🔧';

function getToolIcon(toolName) {
  const info = TOOL_NAMES[toolName];
  return info ? info.icon : DEFAULT_ICON;
}

function getToolDisplayName(toolName) {
  return toolName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function ToolExecution({
  tool,
  args,
  result,
  focusId: focusIdProp,
  status: messageStatus = ''
}) {
  // Extract focusId from result if not provided as prop (e.g., from DB tool messages)
  let focusId = focusIdProp;
  if (tool === 'investigate' && !focusId && result) {
    try {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed.focusId) {
        focusId = parsed.focusId;
      }
    } catch (_) {}
  }

  // investigate calls render as a FocusCard that updates with the global focus state
  if (tool === 'investigate' && focusId) {
    const focusState = chatStore.getFocusState(focusId) || {
      status: 'running',
      title: args?.title || `Investigation #${focusId}`,
      goal: args?.goal || ''
    };
    return (
      <FocusCard
        focusId={focusId}
        focusData={focusState}
        onOpen={(focusId) => {
          chatStore.pushFocusView({
            id: focusId,
            type: 'focus',
            title: focusState.title || `Investigation #${focusId}`
          });
        }}
      />
    );
  }

  // Determinar estado baseado no status field da DB ou no result string (fallback)
  const isPending = messageStatus === 'pending' || result === 'Pending...';
  const isProcessing = messageStatus === 'processing' || result === 'Processing...' || result === 'Running...';
  const isError = messageStatus === 'error';
  const isDone = messageStatus === 'processed' || (!isPending && !isProcessing && !isError && result && result !== 'null');
  const isRunning = isPending || isProcessing;
  const [expanded, setExpanded] = useState(true);

  // Keep expanded when running; collapse toggle is manual
  useEffect(() => {
    if (isRunning) {
      setExpanded(true);
    }
  }, [isRunning]);

  const icon = getToolIcon(tool);
  const displayName = getToolDisplayName(tool);

  const handleToggle = () => {
    setExpanded(prev => !prev);
  };

  // Format args for display
  let argsDisplay = '';
  if (args) {
    if (typeof args === 'string') {
      argsDisplay = args;
    } else if (typeof args === 'object') {
      argsDisplay = Object.entries(args)
        .map(([key, value]) => {
          const displayValue = typeof value === 'string' ? value : JSON.stringify(value);
          return `${key}: ${displayValue}`;
        })
        .join(', ');
    }
  }

  return (
    <Box sx={{
      display: 'flex',
      justifyContent: 'flex-start',
      mb: 0.75
    }}>
      <Box sx={{
        width: '90%',
        p: 1.25,
        borderRadius: '8px',
        backgroundColor: isRunning ? '#f0f4ff' : '#f9f9f9',
        border: '1px solid',
        borderColor: isRunning ? '#cce5ff' : '#e0e0e0',
        wordWrap: 'break-word',
        transition: 'all 0.2s ease'
      }}>
        {/* Header: Clickable to toggle expand/collapse */}
        <Box
          onClick={handleToggle}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            cursor: 'pointer',
            userSelect: 'none',
            '&:hover': { opacity: 0.8 }
          }}
        >
          <Typography variant="body2" sx={{ fontSize: '1.1em', lineHeight: 1 }}>
            {icon}
          </Typography>
          <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
            {displayName}
          </Typography>

          {/* Expand/Collapse indicator */}
          <Typography variant="caption" sx={{
            color: 'text.disabled',
            fontWeight: 400,
            fontSize: '0.7rem',
            mr: 0.5
          }}>
            {expanded ? '▼' : '▶'}
          </Typography>

          {isRunning ? (
            <Typography variant="caption" sx={{
              color: '#1976d2',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 0.5
            }}>
              <span style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: '#1976d2',
                animation: 'pulse 1.5s ease-in-out infinite'
              }} />
              Running...
            </Typography>
          ) : (
            <Typography variant="caption" sx={{ color: '#4caf50', fontWeight: 500 }}>
              ✔ Done
            </Typography>
          )}
        </Box>

        {/* Expanded content: Args + Result */}
        {expanded && (
          <Box sx={{ mt: 0.75 }}>
            {/* Args */}
            {argsDisplay && (
              <Typography variant="caption" sx={{
                color: 'text.secondary',
                display: 'block',
                mb: 0.5,
                fontFamily: 'monospace',
                fontSize: '0.7rem',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>
                {argsDisplay}
              </Typography>
            )}

            {/* Result (only show if not running and result exists) */}
            {!isRunning && result && result !== 'null' && (
              <Typography variant="body2" sx={{
                fontFamily: 'monospace',
                fontSize: '0.7rem',
                bgcolor: 'grey.50',
                p: 0.75,
                borderRadius: '4px',
                whiteSpace: 'pre-wrap',
                maxHeight: 80,
                overflowY: 'auto',
                border: '1px solid',
                borderColor: 'grey.200',
                color: 'text.secondary'
              }}>
                {typeof result === 'string' && result.length > 300 ? result.substring(0, 300) + '...' : JSON.stringify(result)}
              </Typography>
            )}
          </Box>
        )}
      </Box>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </Box>
  );
}

const ToolIndicator = observer(function ToolIndicator({ tools = [] }) {
  if (tools.length === 0) return null;

  return (
    <>
      {tools.map((tool, index) => (
        <ToolExecution
          key={tool.id || `tool-${index}`}
          tool={tool.name}
          args={tool.args}
          result={tool.result}
          focusId={tool.focusId}
        />
      ))}
    </>
  );
});

export default ToolIndicator;
