import React, { useState, useEffect } from 'react';
import { API_URL } from '../api/config';
import {
  Box,
  Typography,
  Tabs,
  Tab,
  TextField,
  Button,
  IconButton,
  Divider as MuiDivider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Checkbox,
  CircularProgress,
  Snackbar,
  Alert,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  ChatBubbleOutline as ChatIcon,
  Psychology as PsychologyIcon,
  Save as SaveIcon,
} from '@mui/icons-material';
import {
  createConversation,
  deleteConversation,
  updateConversation,
  getConversations,
} from '../api/conversations';

function TabPanel({ value, index, children }) {
  if (value !== index) return null;
  return (
    <Box role="tabpanel" sx={{ py: 2 }}>
      {children}
    </Box>
  );
}

export default function ProjectPage({
  project,
  onClose,
  onDeleteProject,
  onProjectUpdated,
  onAddConversation,
  onEditConversation,
  onDeleteConversation,
  onSelectConversation,
  selectedConversationId,
  aiGeneratingConversations = new Set(),
}) {
  const [tabValue, setTabValue] = useState(0);
  const [projectName, setProjectName] = useState(project?.name || '');
  const [projectFolderPath, setProjectFolderPath] = useState(project?.folder_path || '');
  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState(null); // { message, severity }
  const [extraSearchResults, setExtraSearchResults] = useState([]);
  const [selectedExtraFiles, setSelectedExtraFiles] = useState([]);
  const [extraSearchTerm, setExtraSearchTerm] = useState('');
  const [loadingExtraSearch, setLoadingExtraSearch] = useState(false);

  // Sincronizar estado local quando o projecto muda (evita ficar com dados do projecto anterior)
  useEffect(() => {
    setProjectName(project?.name || '');
    setProjectFolderPath(project?.folder_path || '');
    setConversations(project?.conversations || []);
    setTabValue(0);

    // Reset Extra Files UI state (not persisted in memory)
    setExtraSearchTerm('');
    setExtraSearchResults([]);
    setSelectedExtraFiles([]);
  }, [project?.id]);

  // Manter conversas actualizadas quando o project prop muda (ex: nova conversa adicionada pela sidebar)
  useEffect(() => {
    if (project?.conversations) {
      setConversations(project.conversations);
    }
  }, [project?.conversations]);

  // Carregar conversas quando muda para a aba de Conversations
  useEffect(() => {
    if (tabValue === 1 && project?.id) {
      loadConversations();
    }
  }, [tabValue, project?.id]);

  // Carregar ficheiros extra selecionados quando muda para a aba Extra Files
  useEffect(() => {
    if (tabValue === 2 && project?.id) {
      loadSelectedExtraFiles();
    }
  }, [tabValue, project?.id]);

  const loadSelectedExtraFiles = async () => {
    try {
      const res = await fetch(`${API_URL}/projects/${project.id}/extra-files/selected`);
      const files = await res.json();
      setSelectedExtraFiles(files || []);
    } catch (error) {
      console.error('Failed to load selected extra files:', error);
    }
  };

  const handleExtraSearch = async () => {
    if (!extraSearchTerm.trim() || !project?.id) return;
    setLoadingExtraSearch(true);
    try {
      const res = await fetch(`${API_URL}/projects/${project.id}/extra-files/search?q=${encodeURIComponent(extraSearchTerm.trim())}`);
      const files = await res.json();
      setExtraSearchResults(files || []);
    } catch (error) {
      console.error('Failed to search extra files:', error);
      setExtraSearchResults([]);
    }
    setLoadingExtraSearch(false);
  };

  const handleSaveExtraFiles = async () => {
    try {
      await fetch(`${API_URL}/projects/${project.id}/extra-files/selected`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: selectedExtraFiles })
      });
      setToast({ message: 'Ficheiros extra guardados!', severity: 'success' });
    } catch (error) {
      setToast({ message: 'Erro ao guardar ficheiros extra: ' + error.message, severity: 'error' });
    }
  };

  const loadConversations = async () => {
    setLoadingConvs(true);
    try {
      const convs = await getConversations(project.id);
      setConversations(convs || []);
    } catch (error) {
      console.error('Failed to load conversations:', error);
      setToast({ message: 'Erro ao carregar conversas: ' + error.message, severity: 'error' });
    }
    setLoadingConvs(false);
  };

  const handleSaveSettings = async () => {
    if (!projectName.trim()) {
      setToast({ message: 'The project name cannot be empty.', severity: 'warning' });
      return;
    }
    setSaving(true);
    try {
      const { updateProject } = await import('../api/projects');
      const updated = await updateProject(project.id, projectName.trim(), projectFolderPath.trim() || null);
      setToast({ message: 'Project updated successfully!', severity: 'success' });
      onProjectUpdated(updated);
    } catch (error) {
      setToast({ message: 'Error saving: ' + error.message, severity: 'error' });
    }
    setSaving(false);
  };

  const handleDeleteProject = async () => {
    if (
      !window.confirm(
        `Are you sure you want to delete the project "${project.name}" and all its conversations?`
      )
    )
      return;

    setDeleting(true);
    try {
      await onDeleteProject(project);
      setToast({ message: 'Project deleted.', severity: 'info' });
    } catch (error) {
      setToast({ message: 'Error deleting project: ' + error.message, severity: 'error' });
    }
    setDeleting(false);
  };

  const handleAddConversation = async () => {
    const title = prompt('Name of the new conversation', 'New Conversation');
    if (!title) return;
    try {
      const conv = await createConversation(project.id, title.trim());
      setConversations((prev) => [conv, ...prev]);
      setToast({ message: 'Conversation created!', severity: 'success' });
    } catch (error) {
      setToast({ message: 'Error creating conversation: ' + error.message, severity: 'error' });
    }
  };

  const handleEditConversation = async (conv) => {
    const newTitle = prompt('New conversation name', conv.title);
    if (!newTitle || newTitle === conv.title) return;
    try {
      const updated = await updateConversation(conv.id, newTitle.trim());
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      );
      onEditConversation?.(updated);
    } catch (error) {
      setToast({ message: 'Error editing conversation: ' + error.message, severity: 'error' });
    }
  };

  const handleDeleteConversation = async (conv) => {
    if (
      !window.confirm(
        `Are you sure you want to delete the conversation "${conv.title}"?`
      )
    )
      return;
    try {
      await deleteConversation(conv.id);
      setConversations((prev) => prev.filter((c) => c.id !== conv.id));
      onDeleteConversation?.(conv);
      setToast({ message: 'Conversa apagada.', severity: 'success' });
    } catch (error) {
      setToast({ message: 'Erro ao apagar conversa: ' + error.message, severity: 'error' });
    }
  };

  const handleTabChange = (_event, newValue) => {
    setTabValue(newValue);
  };

  const isGenerating = (convId) => aiGeneratingConversations.has(convId);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        bgcolor: 'background.default',
      }}
    >
      {/* ── Header ── */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 2,
          py: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          gap: 1,
        }}
      >
        <IconButton onClick={onClose} size="small">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </Typography>
      </Box>

      {/* ── Tabs ── */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tabValue} onChange={handleTabChange}>
          <Tab label="Settings" />
          <Tab label="Conversations" />
          <Tab label="Extra Files" />
        </Tabs>
      </Box>

      {/* ── Content ── */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 3, pt: 2 }}>
        {/* ── TAB 0: Settings ── */}
        <TabPanel value={tabValue} index={0}>
          <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>
            Editar Projecto
          </Typography>

          <TextField
            label="Nome do Projecto"
            fullWidth
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            sx={{ mb: 2 }}
          />

          <TextField
            label="Pasta Associada"
            fullWidth
            value={projectFolderPath}
            onChange={(e) => setProjectFolderPath(e.target.value)}
            placeholder="/caminho/absoluto/para/a/pasta"
            helperText="Cole o caminho absoluto da pasta associada ao projecto"
            sx={{ mb: 2 }}
          />

          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSaveSettings}
            disabled={saving || !projectName.trim()}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>

          <MuiDivider sx={{ my: 4 }} />

          <Typography variant="subtitle1" color="error.main" sx={{ mb: 1, fontWeight: 600 }}>
            Danger Zone
          </Typography>
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={handleDeleteProject}
            disabled={deleting}
          >
            {deleting ? 'Deleting...' : 'Delete Project'}
          </Button>
        </TabPanel>

        {/* ── TAB 1: Conversations ── */}
        <TabPanel value={tabValue} index={1}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Conversations
            </Typography>
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={handleAddConversation}
            >
              New Conversation
            </Button>
          </Box>

          {loadingConvs ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : conversations.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
              Nenhuma conversa. Crie a primeira!
            </Typography>
          ) : (
            <List>
              {conversations.map((conv) => (
                <ListItem
                  key={conv.id}
                  button
                  onClick={() => onSelectConversation(conv)}
                  selected={conv.id === selectedConversationId}
                  sx={{
                    borderRadius: 1,
                    mb: 0.5,
                    border: '1px solid',
                    borderColor: 'divider',
                    '&.Mui-selected': {
                      bgcolor: 'rgba(10, 31, 68, 0.08)',
                      borderColor: '#0a1f44',
                    },
                    '&:hover': { bgcolor: 'rgba(0, 0, 0, 0.04)' },
                  }}
                  secondaryAction={
                    conv.conversation_type === 'project' ? undefined : (
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditConversation(conv);
                        }}
                      >
                        <span style={{ fontSize: 16 }}>✏️</span>
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteConversation(conv);
                        }}
                      >
                        <span style={{ fontSize: 16 }}>🗑️</span>
                      </IconButton>
                    </Box>
                    )
                  }
                >
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    {isGenerating(conv.id) ? (
                      <CircularProgress size={18} />
                    ) : conv.conversation_type === 'project' ? (
                      <PsychologyIcon fontSize="small" color="secondary" />
                    ) : (
                      <ChatIcon fontSize="small" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={conv.title}
                    primaryTypographyProps={{
                      noWrap: true,
                      title: conv.title,
                    }}
                  />
                </ListItem>
              ))}
            </List>
           )}
         </TabPanel>

         {/* ── TAB 2: Extra Files ── */}
         <TabPanel value={tabValue} index={2}>
           <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>
             Extra Files
           </Typography>

           <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
             Search by file name. Results exclude files already in git.
           </Typography>

           <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
             <TextField
               label="Procurar ficheiros"
               value={extraSearchTerm}
               onChange={(e) => setExtraSearchTerm(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') handleExtraSearch(); }}
               fullWidth
             />
             <Button
               variant="contained"
               onClick={handleExtraSearch}
               disabled={loadingExtraSearch || !extraSearchTerm.trim()}
             >
               {loadingExtraSearch ? 'A procurar...' : 'Procurar'}
             </Button>
           </Box>

           {extraSearchResults.length > 0 && (
             <>
               <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
                 Resultados da pesquisa
               </Typography>
               <List dense>
                 {extraSearchResults.map((file) => (
                   <ListItem
                     key={file}
                     button
                     onClick={() => {
                       setSelectedExtraFiles((prev) =>
                         prev.includes(file)
                           ? prev.filter((f) => f !== file)
                           : [...prev, file]
                       );
                     }}
                   >
                     <Checkbox
                       edge="start"
                       checked={selectedExtraFiles.includes(file)}
                       tabIndex={-1}
                       disableRipple
                     />
                     <ListItemText primary={file} />
                   </ListItem>
                 ))}
               </List>
             </>
           )}

           <Typography variant="body2" sx={{ mt: 3, mb: 1, fontWeight: 600 }}>
             Ficheiros selecionados ({selectedExtraFiles.length})
           </Typography>

           {selectedExtraFiles.length === 0 ? (
             <Typography variant="body2" color="text.secondary">
               Nenhum ficheiro selecionado.
             </Typography>
           ) : (
             <List dense>
               {selectedExtraFiles.map((file) => (
                 <ListItem key={file}>
                   <ListItemText primary={file} />
                   <IconButton
                     size="small"
                     onClick={() =>
                       setSelectedExtraFiles((prev) => prev.filter((f) => f !== file))
                     }
                   >
                     ✕
                   </IconButton>
                 </ListItem>
               ))}
             </List>
           )}

           <Button
             variant="contained"
             sx={{ mt: 2 }}
             onClick={handleSaveExtraFiles}
             disabled={selectedExtraFiles.length === 0}
           >
             Save Selection
           </Button>
         </TabPanel>
       </Box>

      {/* ── Toast ── */}
      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)}>
            {toast.message}
          </Alert>
        ) : null}
      </Snackbar>
    </Box>
  );
}
