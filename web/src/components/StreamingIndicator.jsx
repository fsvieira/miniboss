import React from 'react';
import { Box, Typography, CircularProgress, LinearProgress } from '@mui/material';

function ThinkingIndicator() {
  return (
    <Box sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1,
      p: 2,
      bgcolor: 'background.paper',
      borderRadius: 1,
      mb: 1
    }}>
      <CircularProgress size={16} />
      <Typography variant="body2" color="text.secondary">
        AI is thinking...
      </Typography>
    </Box>
  );
}

function StreamingMessage({ content }) {
  return (
    <Box sx={{
      display: 'flex',
      justifyContent: 'flex-start',
      mb: 1
    }}>
      <Box sx={{
        maxWidth: '70%',
        p: 2,
        borderRadius: 2,
        bgcolor: '#f1f1f1',
        position: 'relative'
      }}>
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
          {content}
        </Typography>
        <Box sx={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5
        }}>
          <Typography variant="caption" color="text.secondary">
            streaming
          </Typography>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor: 'primary.main',
              animation: 'pulse 1.5s infinite'
            }}
          />
        </Box>
      </Box>
    </Box>
  );
}

export default function StreamingIndicator({ isVisible, streamingMessage = '' }) {
  if (!isVisible) return null;

  return (
    <Box>
      <ThinkingIndicator />
      {streamingMessage && <StreamingMessage content={streamingMessage} />}
    </Box>
  );
}