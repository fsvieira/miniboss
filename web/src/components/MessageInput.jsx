import React, { useState, useEffect } from 'react';
import { TextField, Button, Box } from '@mui/material';
import { Send, Stop } from '@mui/icons-material';

export default function MessageInput({
  onSend,
  onStop,
  disabled = false,
  isProcessing = false,
  placeholder = "Type your message...",
  insertText = ''
}) {
  const [input, setInput] = useState('');

  useEffect(() => {
    if (insertText) {
      setInput(prev => (prev ? prev + ' ' : '') + insertText);
    }
  }, [insertText]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      onSend(input.trim());
      setInput('');
    }
  };



  return (
    <Box
      component="form"
      onSubmit={handleSubmit}
      sx={{
        display: 'flex',
        gap: 1,
        p: 2,
        borderTop: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper'
      }}
    >
      <TextField
        fullWidth
        multiline
        maxRows={4}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        sx={{
          '& .MuiOutlinedInput-root': {
            borderRadius: 2
          }
        }}
      />
      <Button
        type={isProcessing ? 'button' : 'submit'}
        variant="contained"
        onClick={isProcessing ? onStop : undefined}
        disabled={isProcessing ? false : disabled || !input.trim()}
        sx={{ minWidth: 48, px: 2 }}
      >
        {isProcessing ? <Stop /> : <Send />}
      </Button>
    </Box>
  );
}
