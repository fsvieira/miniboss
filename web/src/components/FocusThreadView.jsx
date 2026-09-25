import React, { useState, useEffect, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Box, Typography, IconButton, Breadcrumbs, Link, Chip } from '@mui/material';
import { ArrowBack, Lock } from '@mui/icons-material';
import { getFocusConversations, getParentConversation } from '../api/focus';
import chatStore from '../stores/chatStore';
import MessageList from './MessageList';
import ContextIndicator from './ContextIndicator';

const FocusThreadView = observer(function FocusThreadView({ conversationId, onClose }) {


  const stack = chatStore.focusViewStack;
  const breadcrumbs = [
    { id: 'main', title: 'Main', type: 'main', isMain: true },
    ...stack.map((entry, index) => ({
      ...entry,
      isLast: index === stack.length - 1
    }))
  ];

  const state = chatStore.getConversationState(conversationId);

  const loadFocusData = useCallback(async (convId) => {
    if (!convId) return;
    try {
      chatStore.observeConversation(convId);
      await chatStore.loadConversation(convId);

      try {
        const parent = await getParentConversation(convId);
        setParentConv(parent);
      } catch (_) {
        setParentConv(null);
      }

      const { getConversation } = await import('../api/conversations');
      try {
        const conv = await getConversation(convId);
        setCurrentConv(conv);
      } catch (_) {}
    } catch (error) {
      console.error('Failed to load focus thread:', error);
    }
  }, []);

  useEffect(() => {
    if (conversationId) {
      loadFocusData(conversationId);
    }
  }, [conversationId, loadFocusData]);

  const handleBreadcrumbClick = (index) => {
    if (index === 0) {
      // Clicked Main - close focus view entirely
      onClose?.();
      return;
    }

    // Pop back to that level (offset by 1 because index 0 is Main)
    const stackIndex = index - 1;
    if (stackIndex >= stack.length - 1) return; // Already here
    while (chatStore.focusViewStack.length > stackIndex + 1) {
      chatStore.popFocusView();
    }
  };

  const handleSubFocusClick = (focusId, focusTitle) => {
    chatStore.pushFocusView({
      id: focusId,
      type: 'focus',
      title: focusTitle || `Investigation #${focusId}`
    });
  };

  const handleGoBack = () => {
    if (stack.length <= 1) {
      onClose?.();
    } else {
      chatStore.popFocusView();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header with breadcrumbs */}
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        p: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        gap: 1
      }}>
        <IconButton onClick={handleGoBack} size="small" title="Voltar">
          <ArrowBack />
        </IconButton>
        <Breadcrumbs aria-label="focus-navigation" sx={{ flex: 1, ml: 1 }}>
          {breadcrumbs.map((crumb, index) => (
            <Link
              key={`${crumb.id}-${index}`}
              component="button"
              variant="body2"
              underline={crumb.isLast ? 'none' : 'hover'}
              color={crumb.isLast ? 'text.primary' : 'primary'}
              onClick={() => handleBreadcrumbClick(index)}
              sx={{ cursor: crumb.isLast ? 'default' : 'pointer', fontWeight: crumb.isLast ? 600 : 400 }}
            >
              {crumb.title?.substring(0, 40) || (crumb.type === 'main' ? 'Main' : 'Investigation')}
            </Link>
          ))}
        </Breadcrumbs>
        <Chip
          icon={<Lock fontSize="small" />}
          label="Investigation — Read Only"
          size="small"
          color="warning"
          variant="outlined"
          sx={{ fontSize: '0.7rem' }}
        />
      </Box>

      {/* Messages */}
      <ContextIndicator
        contextInfo={state.contextInfo}
        busy={state.isLoading}
        hideClear={true}
        onClear={undefined}
        onModelChange={undefined}
      />

      <Box sx={{ flex: 1, overflow: 'auto', pt: 2, px: 2 }}>
        {state.isLoadingConversation && !state.hasLoaded ? (
          <Typography variant="body2" sx={{ p: 2, textAlign: 'center', color: 'text.secondary' }}>
            Loading focus thread...
          </Typography>
        ) : (
          <MessageList
            messages={state.messages}
            isLoading={state.isLoading}
            streamingMessage={state.streamingMessage}
            toolIndicators={state.toolIndicators}
            isFocusView={true}
            currentFocusId={conversationId}
          />
        )}
      </Box>

      {/* No input field - this is read-only */}
    </Box>
  );
});

export default FocusThreadView;
