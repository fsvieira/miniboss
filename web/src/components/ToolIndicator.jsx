import React, { useState, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { Box, Typography, Button } from '@mui/material';
import { CheckCircle, Cancel } from '@mui/icons-material';
import socketService from '../socketService';
import chatStore from '../stores/chatStore';
import AutoApproveModal from './AutoApproveModal';
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
  approvalPending,
  toolCallId,
  conversationId,
  command,
  cwd,
  parsedCommand,
  autoApprovalRuleCount,
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
  const isDone = messageStatus === 'processed' || (!isPending && !isProcessing && !isError && result && result !== 'null' && result !== 'Waiting for approval...');
  const isWaitingApproval = approvalPending || result === 'Waiting for approval...';
  const isRunning = isPending || isProcessing || isWaitingApproval;
  const [expanded, setExpanded] = useState(true);
  const [autoApproveModalOpen, setAutoApproveModalOpen] = useState(false);

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
            approvalPending ? (
              <Typography variant="caption" sx={{
                color: '#ff9800',
                fontWeight: 500
              }}>
                Waiting for approval...
              </Typography>
            ) : (
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
            )
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

            {/* Approval UI */}
            {approvalPending && (
              <Box sx={{
                mt: 1.5,
                p: 1.5,
                borderRadius: '8px',
                backgroundColor: '#fff3cd',
                border: '1px solid #ffeaa7',
                color: '#856404'
              }}>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  The AI wants to execute the following command:
                </Typography>
                <Box sx={{
                  bgcolor: '#f8f9fa',
                  borderRadius: 1,
                  p: 1,
                  mb: 1.5,
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  border: '1px solid #dee2e6'
                }}>
                  {command || args?.command || 'Command details not available'}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center' }}>
                  <Button
                    variant="contained"
                    color="success"
                    startIcon={<CheckCircle />}
                     onClick={() => {
                       console.log('Approving command', { toolCallId, approved: true, conversationId });
                       socketService.emitToServer('command_approval_response', {
                         toolCallId,
                         approved: true,
                         conversationId
                       });
                       chatStore.removeApprovalMessage(conversationId, toolCallId);
                     }}
                    size="small"
                  >
                    Approve
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<Cancel />}
                     onClick={() => {
                       console.log('Denying command', { toolCallId, approved: false, conversationId });
                       socketService.emitToServer('command_approval_response', {
                         toolCallId,
                         approved: false,
                         conversationId
                       });
                       chatStore.removeApprovalMessage(conversationId, toolCallId);
                     }}
                    size="small"
                  >
                    Deny
                  </Button>
                  <Button
                    variant="outlined"
                    color="warning"
                    onClick={() => setAutoApproveModalOpen(true)}
                    size="small"
                    disabled={!parsedCommand?.ok}
                  >
                    Auto-Approve
                  </Button>
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Box>
      <AutoApproveModal
        open={autoApproveModalOpen}
        command={command || args?.command || 'Command details not available'}
        cwd={cwd || args?.cwd || ''}
        parsedCommand={parsedCommand || args?._parsedCommand || null}
        existingRuleCount={autoApprovalRuleCount || args?._autoApprovalRuleCount || 0}
        onClose={() => setAutoApproveModalOpen(false)}
        onSubmit={(template) => {
          socketService.emitToServer('command_auto_approve', {
            toolCallId,
            conversationId,
            template
          });
          setAutoApproveModalOpen(false);
        }}
      />
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
          approvalPending={tool.approvalPending}
          toolCallId={tool.toolCallId}
          conversationId={tool.conversationId}
          command={tool.command}
          cwd={tool.cwd}
          parsedCommand={tool.parsedCommand}
          autoApprovalRuleCount={tool.autoApprovalRuleCount}
          focusId={tool.focusId}
        />
      ))}
    </>
  );
});

export default ToolIndicator;
