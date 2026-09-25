import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography
} from '@mui/material';

function buildInitialTemplate(parsedCommand, cwd) {
  return {
    cwdMode: 'literal',
    parts: (parsedCommand?.parts || []).map((part) => ({
      index: part.index,
      mode: part.kind === 'flag' ? 'literal' : 'literal'
    }))
  };
}

export default function AutoApproveModal({
  open,
  command,
  cwd,
  parsedCommand,
  existingRuleCount = 0,
  onClose,
  onSubmit
}) {
  const initialTemplate = useMemo(
    () => buildInitialTemplate(parsedCommand, cwd),
    [parsedCommand, cwd]
  );
  const [template, setTemplate] = useState(initialTemplate);

  useEffect(() => {
    if (open) {
      setTemplate(buildInitialTemplate(parsedCommand, cwd));
    }
  }, [open, parsedCommand, cwd]);

  const handlePartModeChange = (index, mode) => {
    setTemplate((current) => ({
      ...current,
      parts: current.parts.map((part) => (
        part.index === index ? { ...part, mode } : part
      ))
    }));
  };

  const handleSubmit = () => {
    onSubmit?.(template);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Auto-Approve Template</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Cria uma regra global para auto-aprovar este comando simples no futuro.
        </Typography>
        <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
          Existing rules for this executable: {existingRuleCount}
        </Typography>

        <Box sx={{
          bgcolor: '#f8f9fa',
          borderRadius: 1,
          p: 1.5,
          mb: 2,
          fontFamily: 'monospace',
          fontSize: '0.85rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          border: '1px solid #dee2e6'
        }}>
          {command}
        </Box>

        <FormControl fullWidth size="small" sx={{ mb: 2 }}>
          <InputLabel id="cwd-mode-label">Working Directory</InputLabel>
          <Select
            labelId="cwd-mode-label"
            label="Working Directory"
            value={template.cwdMode}
            onChange={(event) => setTemplate((current) => ({
              ...current,
              cwdMode: event.target.value
            }))}
          >
            <MenuItem value="literal">Exact match</MenuItem>
            <MenuItem value="worktree_path">Any directory inside worktree</MenuItem>
          </Select>
        </FormControl>

        <Typography variant="caption" sx={{ display: 'block', mb: 2, color: 'text.secondary' }}>
          Current cwd: {cwd || '(default)'}
        </Typography>

        {(parsedCommand?.parts || []).map((part) => {
          const selected = template.parts.find((candidate) => candidate.index === part.index);
          return (
            <Box
              key={part.index}
              sx={{
                display: 'grid',
                gridTemplateColumns: '120px 1fr 200px',
                gap: 1.5,
                alignItems: 'center',
                mb: 1.5
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {part.kind === 'flag' ? 'Flag' : 'Argument'}
              </Typography>
              <Box sx={{
                bgcolor: '#f8f9fa',
                borderRadius: 1,
                p: 1,
                fontFamily: 'monospace',
                fontSize: '0.82rem',
                border: '1px solid #dee2e6'
              }}>
                {part.value}
              </Box>
              <FormControl size="small" fullWidth disabled={part.kind === 'flag'}>
                <InputLabel id={`token-mode-${part.index}`}>Mode</InputLabel>
                <Select
                  labelId={`token-mode-${part.index}`}
                  label="Mode"
                  value={selected?.mode || 'literal'}
                  onChange={(event) => handlePartModeChange(part.index, event.target.value)}
                >
                  <MenuItem value="literal">Literal</MenuItem>
                  <MenuItem value="path">Path inside worktree</MenuItem>
                  <MenuItem value="value">Any value</MenuItem>
                </Select>
              </FormControl>
            </Box>
          );
        })}

        {!parsedCommand?.ok && (
          <Typography variant="body2" color="error.main">
            This command cannot be auto-approved in V1.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!parsedCommand?.ok}
        >
          Save Rule And Approve
        </Button>
      </DialogActions>
    </Dialog>
  );
}
