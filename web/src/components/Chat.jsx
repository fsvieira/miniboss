import React, { useRef, useState, useEffect, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Box, IconButton, useTheme, useMediaQuery, Typography, Chip, Breadcrumbs, Link } from '@mui/material';
import { Menu, MoreVert, ListAlt, ArrowBack, Lock, Checklist, Restore } from '@mui/icons-material';

import { clearConversationMessages, cancelConversationAI } from '../api/settings';
import chatStore from '../stores/chatStore';
import { useConversation } from '../hooks/useConversation';
import { useStreaming } from '../hooks/useStreaming';
import ConversationSettingsPanel from './ConversationSettingsPanel';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import ContextIndicator from './ContextIndicator';
import ConversationModelModal from './ConversationModelModal';
import TaskTreePanel from './TaskTreePanel';
import PlanPanel from './PlanPanel';
import { fetchTaskTree, getPlan, setConversationMode, setConversationModel, executePlan } from '../api/conversations';
import { getFocusConversations } from '../api/focus';
import socketService from '../socketService';


const Chat = observer(function Chat({ conversation, onConversationUpdated, onConversationDeleted, onToggleSidebar, onOpenConversation, onConversationsChanged }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [taskTreeVisible, setTaskTreeVisible] = useState(true);
  const [planVisible, setPlanVisible] = useState(true);
  const [taskTree, setTaskTree] = useState([]);
  const [plan, setPlan] = useState(null);
  const [insertTaskText, setInsertTaskText] = useState('');
  const summaryAbortRef = useRef(null);

  const effectiveConversationId = conversation?.id;

  // Use conversation hooks para a tab ativa
  const { messages, contextInfo, loadMessages, reloadContextInfo } = useConversation(
    effectiveConversationId ? { id: effectiveConversationId } : null
  );
  const { isLoading, streamingMessage, toolIndicators, streamMessage, cancelStream } = useStreaming(effectiveConversationId);
  const isBusy = isLoading;

  const isFocusMode = chatStore.isFocusView && !!chatStore.currentFocusView;
  const currentFocusView = chatStore.currentFocusView;
  const focusStack = chatStore.focusViewStack;
  const [focusSubFocuses, setFocusSubFocuses] = useState([]);

  const focusState = isFocusMode ? chatStore.getConversationState(currentFocusView?.id) : null;

  const focusBreadcrumbs = [
    { id: 'main', title: conversation?.title || 'Main', type: 'main', isMain: true },
    ...focusStack.map((entry, index) => ({
      ...entry,
      isLast: index === focusStack.length - 1
    }))
  ];

  useEffect(() => {
    if (isFocusMode && currentFocusView?.id) {
      const convId = currentFocusView.id;
      chatStore.observeConversation(convId);
      chatStore.loadConversation(convId);
      getFocusConversations(convId).then(subs => setFocusSubFocuses(subs || [])).catch(() => setFocusSubFocuses([]));
    } else {
      setFocusSubFocuses([]);
    }
  }, [isFocusMode, currentFocusView?.id]);

  const handleFocusBreadcrumbClick = (index) => {
    if (index === 0) {
      chatStore.clearFocusView();
      return;
    }
    const stackIndex = index - 1;
    if (stackIndex >= focusStack.length - 1) return;
    while (chatStore.focusViewStack.length > stackIndex + 1) {
      chatStore.popFocusView();
    }
  };

  const handleFocusSubClick = (focusId, focusTitle) => {
    chatStore.pushFocusView({ id: focusId, type: 'focus', title: focusTitle || `Investigation #${focusId}` });
  };

  const handleFocusGoBack = () => {
    if (focusStack.length <= 1) {
      chatStore.clearFocusView();
    } else {
      chatStore.popFocusView();
    }
  };

  const hasRunningFocus = effectiveConversationId ? 
    chatStore.hasRunningFocus(effectiveConversationId) : false;

  const handleSendMessage = async (messageText) => {
    if (!effectiveConversationId || isBusy || hasRunningFocus) return;

    const userMessage = { role: 'user', content: messageText };

    try {
      await streamMessage(effectiveConversationId, userMessage, {
        onError: (error) => {
          console.error('Streaming error:', error);
          loadMessages(effectiveConversationId);
        }
      });
    } catch (error) {
      console.error('Send message error:', error);
      loadMessages(effectiveConversationId);
    }
  };

  const handleClear = async () => {
    if (!effectiveConversationId) return;

    if (!confirm('Clear all messages in this conversation?')) return;

    try {
      await clearConversationMessages(effectiveConversationId);
      chatStore.clearConversationTools(effectiveConversationId);
      loadMessages(effectiveConversationId);
    } catch (error) {
      console.error('Clear error:', error);
    }
  };

  const handleModelSave = async ({ providerId, model, thinkingMode }) => {
    if (!effectiveConversationId) return;

    try {
      await setConversationModel(effectiveConversationId, providerId, model, thinkingMode);
      onConversationUpdated({ ...conversation, provider_id: providerId, model, thinking_mode: thinkingMode });
      reloadContextInfo(effectiveConversationId);
    } catch (error) {
      console.error('Model save error:', error);
    }
  };

  const handleToggleMode = async () => {
    if (!effectiveConversationId) return;

    const nextMode = conversation?.mode === 'exec' ? 'plan' : 'exec';
    try {
      const updated = await setConversationMode(effectiveConversationId, nextMode);
      onConversationUpdated({ ...conversation, mode: updated.mode });
      reloadContextInfo(effectiveConversationId);
    } catch (error) {
      console.error('Mode toggle error:', error);
    }
  };

  const isProjectMemory = conversation?.conversation_type === 'project';

  const handleExecutePlan = async () => {
    if (!effectiveConversationId || isBusy) return;

    try {
      const { executionConversationId } = await executePlan(effectiveConversationId);
      onConversationsChanged?.();
      onOpenConversation?.({ id: executionConversationId });
    } catch (error) {
      console.error('Execute plan error:', error);
      alert(`Could not execute the plan: ${error.message}`);
    }
  };

  const handleWhereWasI = () => {
    handleSendMessage(
      'Do a recap of the project state: current focus, what was being done, recent decisions, discoveries, related ideas, ongoing executions and next steps.'
    );
  };

  const loadTaskTree = async () => {
    if (!effectiveConversationId) return;
    try {
      const tree = await fetchTaskTree(effectiveConversationId);
      setTaskTree(tree);
    } catch (_) {}
  };

  const loadPlan = async () => {
    if (!effectiveConversationId) return;
    try {
      const data = await getPlan(effectiveConversationId);
      setPlan(data?.plan || null);
    } catch (_) {}
  };

  useEffect(() => {
    if (effectiveConversationId) {
      socketService.joinConversation(effectiveConversationId);
      loadTaskTree();
      loadPlan();
    }
    // Socket listener for live updates
    const handler = (data) => {
      if (data?.conversationId && String(data.conversationId) !== String(effectiveConversationId)) return;
      if (data?.tree) {
        setTaskTree(data.tree);
      } else {
        loadTaskTree();
      }
    };
    socketService.on('taskTreeUpdated', handler);

    const planHandler = (data) => {
      if (data?.conversationId && String(data.conversationId) !== String(effectiveConversationId)) return;
      if (data && 'plan' in data) {
        setPlan(data.plan || null);
      } else {
        loadPlan();
      }
    };
    socketService.on('planUpdated', planHandler);

    // Also listen to raw 'message' events for task tools
    const messageHandler = (msg) => {
      if (msg?.role === 'tool' && ['addTodo', 'updateTodo', 'removeTodo'].includes(msg.tool_name)) {
        try {
          const p = JSON.parse(msg.tool_result || msg.content || '{}');
          if (p.task_updated) loadTaskTree();
        } catch {
          loadTaskTree();
        }
      }
      if (msg?.role === 'tool' && msg.tool_name === 'updatePlan') {
        loadPlan();
      }
    };
    socketService.on('message', messageHandler);

    return () => {
      socketService.off('taskTreeUpdated', handler);
      socketService.off('planUpdated', planHandler);
      socketService.off('message', messageHandler);
    };
  }, [effectiveConversationId]);

  // Reliable task tree refresh
  useEffect(() => {
    if (!messages.length) return;

    const recent = messages.slice(-3);
    const hasTaskUpdate = recent.some(msg => {
      if (msg.role !== 'tool') return false;
      if (!['addTodo', 'updateTodo', 'removeTodo'].includes(msg.tool_name)) return false;
      try {
        const p = JSON.parse(msg.tool_result || msg.content || '{}');
        return !!p.task_updated;
      } catch {
        return true;
      }
    });

    if (hasTaskUpdate) {
      loadTaskTree();
    }
  }, [messages]);

  const handleStop = async () => {
    if (!effectiveConversationId) return;

    summaryAbortRef.current?.abort();
    cancelStream(effectiveConversationId);

    try {
      await cancelConversationAI(effectiveConversationId);
    } catch (error) {
      console.error('Stop error:', error);
    }
  };

  const handleSettingsOpen = () => setSettingsPanelOpen(true);

  const activeContextInfo = isFocusMode ? focusState?.contextInfo : contextInfo;
  const contextBusy = isFocusMode ? focusState?.isLoading : isBusy;
  const contextClearHandler = !isFocusMode ? handleClear : undefined;
  const contextModelChangeHandler = !isFocusMode ? () => setModelModalOpen(true) : undefined;

  // Compute conversation state indicator from authoritative status (Fase E)
  const rawConversationState = isFocusMode
    ? focusState?.conversationState
    : chatStore.getConversationState(effectiveConversationId)?.conversationState;
  const conversationState = rawConversationState || {};
  const status = conversationState?.status || 'completed';
  const showRetryChip = conversationState?.command === 'RETRY' && conversationState?.retryable;
  const isTerminal = ['completed', 'error'].includes(status);
  const statusMeta = {
    running: { label: 'A processar', color: 'warning' },
    waiting: { label: 'A aguardar', color: 'warning' },
    error: { label: 'Erro', color: 'error' },
    completed: { label: 'Completed', color: 'success' },
  }[status] || { label: 'Completed', color: 'success' };
  const isProcessing = isBusy || status === 'running' || status === 'waiting' || hasRunningFocus;

  return (
    <Box sx={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      bgcolor: 'background.default'
    }}>
      {/* Header */}
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        p: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper'
      }}>
        {isMobile && (
          <IconButton onClick={onToggleSidebar} sx={{ mr: 1 }}>
            <Menu />
          </IconButton>
        )}
        <Box sx={{ flex: 1 }}>
          {isFocusMode ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <IconButton onClick={handleFocusGoBack} size="small" title="Voltar">
                <ArrowBack />
              </IconButton>
              <Breadcrumbs aria-label="focus-navigation" sx={{ flex: 1 }}>
                {focusBreadcrumbs.map((crumb, index) => (
                  <Link
                    key={`${crumb.id}-${index}`}
                    component="button"
                    variant="body2"
                    underline={crumb.isLast ? 'none' : 'hover'}
                    color={crumb.isLast ? 'text.primary' : 'primary'}
                    onClick={() => handleFocusBreadcrumbClick(index)}
                    sx={{ cursor: crumb.isLast ? 'default' : 'pointer', fontWeight: crumb.isLast ? 600 : 400 }}
                  >
                    {crumb.title?.substring(0, 40) || (crumb.isMain ? 'Main' : 'Investigation')}
                  </Link>
                ))}
              </Breadcrumbs>
              <Chip
                icon={<Lock fontSize="small" />}
                label="Read Only"
                size="small"
                color="warning"
                variant="outlined"
                sx={{ fontSize: '0.7rem' }}
              />
            </Box>
          ) : (
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              {conversation?.title || 'Select a conversation'}
              {isProjectMemory && (
                <Chip label="Project Memory" size="small" color="secondary" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
              )}
              {isProjectMemory && (
                <Chip
                  icon={<Lock fontSize="small" />}
                  label="Read Only"
                  size="small"
                  color="warning"
                  variant="outlined"
                  sx={{ fontSize: '0.65rem', height: 20 }}
                />
              )}
              {conversation?.conversation_type === 'main' && (
                <Chip label="MAIN" size="small" color="primary" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
              )}
              {conversation?.conversation_type === 'main' && (
                <Chip
                  label={conversation?.mode === 'exec' ? 'Exec Mode' : 'Plan Mode'}
                  size="small"
                  color={conversation?.mode === 'exec' ? 'success' : 'secondary'}
                  variant="outlined"
                  onClick={handleToggleMode}
                  clickable
                  sx={{ fontSize: '0.65rem', height: 20, cursor: 'pointer' }}
                />
              )}
            </h3>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {isProjectMemory && (
            <Chip
              icon={<Restore fontSize="small" />}
              label="Onde estava?"
              size="small"
              color="info"
              variant="outlined"
              onClick={handleWhereWasI}
              clickable
              sx={{ fontSize: '0.7rem', height: 24, cursor: 'pointer' }}
            />
          )}
          <Chip
            icon={status === 'error' ? <span>🔴</span> : status === 'running' || status === 'waiting' ? <span>🟡</span> : <span>🟢</span>}
            label={statusMeta.label}
            size="small"
            color={statusMeta.color}
            sx={{ fontSize: '0.7rem', height: 20 }}
          />
          {showRetryChip && (
            <Chip label="Retrying…" size="small" color="warning" sx={{ fontSize: '0.7rem', height: 20 }} />
          )}
        </Box>
        <IconButton onClick={() => setTaskTreeVisible(v => !v)} title="Toggle Task Tree">
          <ListAlt />
        </IconButton>
        <IconButton onClick={() => setPlanVisible(v => !v)} title="Toggle Plan">
          <Checklist />
        </IconButton>
        <IconButton onClick={handleSettingsOpen}>
          <MoreVert />
        </IconButton>
      </Box>

      {/* Header actions */}

      {/* Context Indicator */}
      <ContextIndicator
        contextInfo={activeContextInfo}
        onClear={contextClearHandler}
        busy={contextBusy}
        conversation={conversation}
        onModelChange={contextModelChangeHandler}
        hideClear={isFocusMode}
      />

      {/* Chat area + optional Task Tree panel */}
      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {isFocusMode && focusState ? (
          /* Focus mode: show focus messages + sub-focuses footer */
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Box sx={{ flex: 1, overflow: 'auto', pt: 2, px: 2 }}>
              {focusState.isLoadingConversation && !focusState.hasLoaded ? (
                <Typography variant="body2" sx={{ p: 2, textAlign: 'center', color: 'text.secondary' }}>
                  Loading focus thread...
                </Typography>
              ) : (
              <MessageList
                  messages={focusState.messages}
                  isLoading={focusState.isLoading}
                  streamingMessage={focusState.streamingMessage}
                  toolIndicators={focusState.toolIndicators}
                  isFocusView={true}
                  currentFocusId={currentFocusView?.id || null}
                />
              )}
            </Box>
            {focusSubFocuses.length > 0 && (
              <Box sx={{
                p: 2,
                borderTop: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper'
              }}>
                <Typography variant="caption" fontWeight={600} sx={{ mb: 1, display: 'block' }}>
                  Sub-investigations:
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {focusSubFocuses.map((sub) => {
                    const subFocusState = chatStore.getFocusState(sub.id);
                    const status = subFocusState?.status || 'created';
                    return (
                      <Link
                        key={sub.id}
                        component="button"
                        variant="body2"
                        onClick={() => handleFocusSubClick(sub.id, sub.title)}
                        sx={{
                          textAlign: 'left',
                          cursor: 'pointer',
                          p: 0.5,
                          borderRadius: 1,
                          '&:hover': { bgcolor: 'action.hover' }
                        }}
                      >
                        {sub.title}
                        {' '}
                        <Chip
                          label={status}
                          size="small"
                          variant="outlined"
                          sx={{ fontSize: '0.65rem', height: 18 }}
                        />
                      </Link>
                    );
                  })}
                </Box>
              </Box>
            )}
          </Box>
        ) : (
          /* Regular chat view */
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <MessageList
              messages={messages}
              isLoading={isLoading}
              streamingMessage={streamingMessage}
              toolIndicators={toolIndicators}
            />
            <MessageInput
              onSend={handleSendMessage}
              onStop={handleStop}
              disabled={!effectiveConversationId || isProcessing}
              isProcessing={isProcessing}
              insertText={insertTaskText}
            />
            {conversationState?.command === 'RETRY' && conversationState?.retryable && !isTerminal && (
              <Box sx={{ py: 1, px: 2, textAlign: 'center' }}>
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  onClick={() => {
                    const reason = conversationState?.reason || 'retry';
                    socketService.emit('retry_conversation', { conversationId: effectiveConversationId, reason });
                  }}
                >
                  Tentar novamente
                </Button>
              </Box>
            )}
            {chatStore.hasRunningFocus(effectiveConversationId) && (
              <Box sx={{ py: 1, px: 2, textAlign: 'center' }}>
                <Chip label="Investigation in progress — Awaiting report" size="small" color="primary" variant="outlined" sx={{ fontSize: '0.7rem' }} />
              </Box>
            )}
          </Box>
        )}
        {/* Only show TaskTreePanel when NOT in focus view and NOT in project memory */}
        {!chatStore.isFocusView && !isProjectMemory && (
          <TaskTreePanel
            tasks={taskTree}
            visible={taskTreeVisible}
            onInsertId={(text) => setInsertTaskText(text)}
          />
        )}

        {/* Plan panel — sticky: MAIN (plan/exec) e Project Memory (com Executar) */}
        {!chatStore.isFocusView && (conversation?.conversation_type === 'main' || isProjectMemory) && (
          <PlanPanel
            plan={plan}
            visible={planVisible}
            onExecute={isProjectMemory ? handleExecutePlan : null}
          />
        )}
      </Box>

      {/* Modals */}
      <ConversationModelModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        conversation={conversation}
        onSave={handleModelSave}
      />

      <ConversationSettingsPanel
        open={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
        conversation={conversation}
        onConversationUpdated={onConversationUpdated}
        onConversationDeleted={onConversationDeleted}
      />
    </Box>
  );
});

export default Chat;
