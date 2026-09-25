import React from 'react';
import { Box, Typography, List, ListItem, ListItemText, ListItemIcon, IconButton } from '@mui/material';
import {
  RadioButtonUnchecked as TodoIcon,
  PlayArrow as InProgressIcon,
  CheckCircle as DoneIcon,
  Block as BlockedIcon,
  ContentCopy as CopyIcon
} from '@mui/icons-material';

const statusIcons = {
  todo: <TodoIcon fontSize="small" />,
  in_progress: <InProgressIcon fontSize="small" color="primary" />,
  done: <DoneIcon fontSize="small" color="success" />,
  blocked: <BlockedIcon fontSize="small" color="error" />
};

function TaskNode({ node, level = 0, onInsertId }) {
  const handleCopy = () => {
    if (onInsertId) onInsertId(` <${node.id}> `);
  };
  return (
    <ListItem sx={{ pl: 2 + level * 2, py: 0.5 }}>
      <ListItemIcon sx={{ minWidth: 32 }}>
        {statusIcons[node.status] || <TodoIcon fontSize="small" />}
      </ListItemIcon>
      <ListItemText
        primary={node.description}
        secondary={node.notes ? node.notes : null}
        primaryTypographyProps={{ variant: 'body2' }}
        secondaryTypographyProps={{ variant: 'caption' }}
      />
      <IconButton size="small" onClick={handleCopy} title="Insert task id in chat">
        <CopyIcon fontSize="small" />
      </IconButton>
    </ListItem>
  );
}

function renderTree(nodes, level = 0, onInsertId) {
  return nodes.flatMap((node, idx) => [
    <TaskNode key={`${node.id}-${idx}`} node={node} level={level} onInsertId={onInsertId} />,
    ...(node.children && node.children.length > 0 ? renderTree(node.children, level + 1, onInsertId) : [])
  ]);
}

export default function TaskTreePanel({ tasks = [], visible = true, onInsertId }) {
  if (!visible) return null;

  return (
    <Box
      sx={{
        width: 448,
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >

      <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">Task Tree</Typography>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {tasks.length === 0 ? (
          <Typography sx={{ p: 2, color: 'text.secondary' }} variant="body2">No tasks yet.</Typography>
        ) : (
          <List dense>{renderTree(tasks, 0, onInsertId)}</List>
        )}
      </Box>
    </Box>
  );
}
