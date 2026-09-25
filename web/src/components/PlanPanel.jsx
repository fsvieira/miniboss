import React, { useState } from 'react';
import { Box, Typography, IconButton, Button } from '@mui/material';
import { ExpandMore, ExpandLess, PlayArrow } from '@mui/icons-material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function PlanPanel({
  plan = null,
  visible = true,
  onExecute = null,
  executeLabel = 'Executar',
  executeDisabled = false,
}) {
  const [expanded, setExpanded] = useState(true);

  if (!visible) return null;

  const hasPlan = plan != null && String(plan).trim().length > 0;

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
      <Box
        sx={{
          p: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer'
        }}
        onClick={() => setExpanded(prev => !prev)}
      >
        <Typography variant="subtitle2">Plano</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {onExecute && hasPlan && (
            <Button
              size="small"
              variant="contained"
              startIcon={<PlayArrow fontSize="small" />}
              disabled={executeDisabled}
              onClick={(e) => {
                e.stopPropagation();
                onExecute();
              }}
            >
              {executeLabel}
            </Button>
          )}
          <IconButton size="small">
            {expanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
          </IconButton>
        </Box>
      </Box>

      {expanded && (
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          {!hasPlan ? (
            <Typography sx={{ color: 'text.secondary' }} variant="body2">
              Sem plano.
            </Typography>
          ) : (
            <Box sx={{ '& h1': { fontSize: '1.1rem', my: 1 }, '& h2': { fontSize: '1rem', my: 1 }, '& h3': { fontSize: '0.9rem', my: 1 }, '& ul, & ol': { pl: 2.5, my: 0.5 }, '& li': { mb: 0.25 }, '& p': { my: 0.5 } }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(plan)}</ReactMarkdown>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
