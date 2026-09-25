import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Box } from '@mui/material';

export default function ProjectModal({ open, onClose, onSave, project }) {
  const [name, setName] = useState(project?.name || '');
  const [folderPath, setFolderPath] = useState(project?.folder_path || '');

  const handleSubmit = async () => {
    if (!name.trim()) return;
    await onSave(name.trim(), folderPath.trim() || null);
    setName('');
    setFolderPath('');
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{project ? 'Editar Projeto' : 'Novo Projeto'}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          <TextField
            autoFocus
            label="Nome do Projeto"
            fullWidth
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <TextField
            label="Pasta Associada"
            fullWidth
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            placeholder="/caminho/absoluto/para/a/pasta"
            helperText="Cole o caminho absoluto da pasta associada ao projeto"
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancelar</Button>
        <Button onClick={handleSubmit} variant="contained">
          {project ? 'Salvar' : 'Criar'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
