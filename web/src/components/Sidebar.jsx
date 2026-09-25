import React, { useState } from 'react';
import {
  Drawer,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  Box,
  Divider as MuiDivider,
  useMediaQuery,
  useTheme,
  CircularProgress,
  Button,
} from '@mui/material';
import {
  ExpandLess,
  ExpandMore,
  Folder,
  Settings,
  Menu,
  ChatBubbleOutline,
  Psychology,
  Add,
} from '@mui/icons-material';
import chatStore from '../stores/chatStore';

export default function Sidebar({
  projects,
  expanded,
  onToggleExpanded,
  onSelectProject,
  onAddConversation,
  onOpenProject,
  onLoadProjectConversations,
  onEditConversation,
  onDeleteConversation,
  onSelectConversation,
  selectedConversationId,
  aiGeneratingConversations = new Set(),
  pendingApprovalConversationIds = new Set(),
  conversationStatuses = {},
}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.between('sm', 'md'));

  // Controls which projects have the conversation list open
  const [openProjects, setOpenProjects] = useState({});

  const toggleProject = (project) => {
    const projectId = project.id;
    const isOpening = !openProjects[projectId];
    setOpenProjects((prev) => ({ ...prev, [projectId]: isOpening }));
    if (isOpening && !project.conversations?.length) {
      onLoadProjectConversations?.(projectId);
    }
  };

  const handleSelectConversation = (conv) => {
    onSelectConversation(conv);
    if (isMobile) {
      onToggleExpanded(false);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'running':
      case 'waiting':
        return '#f9a825'; // 🟡
      case 'error':
        return '#d32f2f'; // 🔴
      default:
        return '#4caf50'; // 🟢
    }
  };

  const getDrawerWidth = () => {
    if (isMobile) return 280;
    if (isTablet) return expanded ? 280 : 50;
    return expanded ? 300 : 60;
  };

  return (
    <Drawer
      variant={isMobile ? 'temporary' : 'permanent'}
      open={isMobile ? expanded : true}
      onClose={isMobile ? () => onToggleExpanded(false) : undefined}
      sx={{
        width: getDrawerWidth(),
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: getDrawerWidth(),
          transition: isMobile ? 'none' : 'width 0.3s',
          overflowX: 'hidden',
        },
      }}
    >
      {/* Sidebar header */}
      <Box sx={{ display: 'flex', alignItems: 'center', p: 1 }}>
        <IconButton onClick={() => onToggleExpanded(!expanded)} color="inherit">
          {isMobile ? <Menu /> : (expanded ? <ExpandLess /> : <ExpandMore />)}
        </IconButton>
        {(expanded || isMobile || isTablet) && <Box sx={{ ml: 1, fontWeight: 600 }}>Projects</Box>}
      </Box>

      <List>
        {projects.map((project) => (
          <React.Fragment key={project.id}>
            {/* ══ LINHA 1: projetos nome ══ */}
            <ListItem
              button
              onClick={() => onOpenProject(project)}
              sx={{ pl: (expanded || isMobile || isTablet) ? 2 : 0 }}
            >
              <ListItemIcon sx={{ minWidth: (expanded || isMobile || isTablet) ? 40 : 'auto' }}>
                <Folder />
              </ListItemIcon>
              {(expanded || isMobile || isTablet) && (
                <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
                  <ListItemText
                    primary={`${project.name} (${project.conversations?.length ?? 0})`}
                    primaryTypographyProps={{
                      noWrap: true,
                      title: project.name,
                    }}
                  />
                   <IconButton
                     size="small"
                     onClick={(e) => {
                       e.stopPropagation();
                       toggleProject(project);
                     }}
                     sx={{ ml: 'auto' }}
                   >
                    {openProjects[project.id] ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                  </IconButton>
                </Box>
              )}
            </ListItem>

            {/* ══ lista de conversas + Nova Conversa ══ */}
            {openProjects[project.id] && (
              <Box sx={{ pl: 4 }}>
                {/* Lista de conversas */}
                {project.conversations?.map((conv) => {
                  const hasPendingApproval = pendingApprovalConversationIds.has(conv.id);
                  const hasUnread = chatStore.unreadConversationIds.has(conv.id);
                  const isSelected = conv.id === selectedConversationId;
                  const status = conversationStatuses[conv.id] || conv.status || 'completed';
                  const statusColor = getStatusColor(status);

                  return (
                  <ListItem
                    key={conv.id}
                    button
                    onClick={() => handleSelectConversation(conv)}
                    sx={{
                      py: 0.5,
                      backgroundColor: isSelected
                        ? 'rgba(10, 31, 68, 0.08)'
                        : (hasPendingApproval ? '#ffebee' : (hasUnread ? '#fffde7' : 'transparent')),
                      borderLeft: isSelected ? '3px solid #0a1f44' : (hasPendingApproval ? '3px solid #d32f2f' : '3px solid transparent'),
                      '&:hover': {
                        backgroundColor: isSelected
                          ? 'rgba(10, 31, 68, 0.12)'
                          : (hasPendingApproval ? '#ffcdd2' : (hasUnread ? '#fff9c4' : 'rgba(0, 0, 0, 0.04)')),
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 30 }}>
                      {aiGeneratingConversations.has(conv.id) ? (
                        <CircularProgress size={16} color="primary" />
                      ) : conv.conversation_type === 'project' ? (
                        <Psychology fontSize="small" color="secondary" />
                      ) : (
                        <ChatBubbleOutline fontSize="small" />
                      )}
                    </ListItemIcon>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <ListItemText
                        primary={conv.title}
                        primaryTypographyProps={{
                          noWrap: true,
                          title: conv.title,
                          color: isSelected ? '#0a1f44' : (hasPendingApproval ? '#b71c1c' : 'inherit'),
                          fontWeight: isSelected || hasPendingApproval || conv.conversation_type === 'project' ? 600 : 400,
                        }}
                      />
                    </Box>
                    <Box
                      title={`Estado: ${status}`}
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        backgroundColor: statusColor,
                        flexShrink: 0,
                        ml: 0.5,
                      }}
                    />
                  </ListItem>
                  );
                })}

                {/* New Conversation button at the end of the sub-list */}
                <ListItem
                  button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddConversation(project.id);
                  }}
                  sx={{
                    py: 0.5,
                    color: 'primary.main',
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 30 }}>
                    <Add fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    primary="Nova Conversa"
                    primaryTypographyProps={{
                      variant: 'body2',
                      noWrap: true,
                    }}
                  />
                </ListItem>
              </Box>
            )}
          </React.Fragment>
        ))}

        <MuiDivider sx={{ my: 1 }} />

        {/* New project button */}
        <ListItem button onClick={() => onSelectProject('add')} sx={{ pl: (expanded || isMobile || isTablet) ? 2 : 0, color: 'error.main' }}>
          <ListItemIcon sx={{ minWidth: (expanded || isMobile || isTablet) ? 40 : 'auto', color: 'error.main' }}>
            <Add />
          </ListItemIcon>
          {(expanded || isMobile || isTablet) && (
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <ListItemText primary="New Project" />
            </Box>
          )}
        </ListItem>

        {/* Settings button */}
        <ListItem button onClick={() => onSelectProject('settings')} sx={{ pl: (expanded || isMobile || isTablet) ? 2 : 0 }}>
          <ListItemIcon sx={{ minWidth: (expanded || isMobile || isTablet) ? 40 : 'auto' }}>
            <Settings />
          </ListItemIcon>
          {(expanded || isMobile || isTablet) && (
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <ListItemText primary="Settings" />
            </Box>
          )}
        </ListItem>
      </List>
    </Drawer>
  );
}
