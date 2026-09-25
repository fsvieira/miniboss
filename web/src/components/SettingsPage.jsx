import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Box,
  Typography,
  Tabs,
  Tab,
  TextField,
  Button,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Divider,
  Slider,
  Switch,
  Chip,
  Snackbar,
  Alert,
} from '@mui/material';
import { Edit, Delete, ArrowBack, FolderOpen } from '@mui/icons-material';
import {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  getCurrentProviderId,
  setCurrentProviderId,
} from '../api/providers';
import { fetchModels } from '../api/ai';
import { getSetting, setSetting } from '../api/settings';
import {
  getSandboxPaths,
  createSandboxPath,
  updateSandboxPath,
  deleteSandboxPath,
} from '../api/sandbox';
import FolderBrowserDialog from './FolderBrowserDialog';
import ModelDetailsPanel from './ModelDetailsPanel';
import { findMatchingThinkingValue } from '../utils/modelFormat';

function TabPanel({ value, index, children }) {
  if (value !== index) return null;
  return (
    <Box role="tabpanel" sx={{ py: 2 }}>
      {children}
    </Box>
  );
}

export default function SettingsPage({ onClose }) {
  const [tabValue, setTabValue] = useState(0);
  const [providers, setProviders] = useState([]);
  const [editingProvider, setEditingProvider] = useState(null);
  const [providerForm, setProviderForm] = useState({ name: '', apiKey: '', baseURL: '' });
  const [selectedProviderForModels, setSelectedProviderForModels] = useState('');
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [defaultModel, setDefaultModelState] = useState('');
  const [defaultThinkingMode, setDefaultThinkingMode] = useState('');
  // Candidato cru para o thinking default (valor guardado), preservado entre renders
  const [defaultThinkingCandidate, setDefaultThinkingCandidate] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoSummarizeThreshold, setAutoSummarizeThreshold] = useState(0);
  const [autoSummarizeEnabled, setAutoSummarizeEnabled] = useState(false);
  const [agentSystemPrompt, setAgentSystemPrompt] = useState('');

  // Sandbox state
  const [sandboxPaths, setSandboxPaths] = useState([]);
  const [newPathInput, setNewPathInput] = useState('');
  const [newPathMode, setNewPathMode] = useState('read');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    loadData();
    loadSandboxPaths();
  }, []);

  // Auto-fetch models when provider changes
  useEffect(() => {
    if (selectedProviderForModels) {
      handleFetchModels();
    }
  }, [selectedProviderForModels]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [providersData, currentId, thresholdValue, agentSystemPromptValue] = await Promise.all([
        getProviders(),
        getCurrentProviderId(),
        getSetting('auto_summarize_threshold'),
        getSetting('agent_system_prompt')
      ]);
      const defaultModelValue = (await getSetting('default_model').catch(() => null)) || 'gpt-3.5-turbo';
      const defaultThinkingValue = (await getSetting('default_thinking_mode').catch(() => null)) || '';
      setProviders(providersData);
      setSelectedProviderForModels(currentId);
      setDefaultModelState(defaultModelValue);
      setDefaultThinkingMode(defaultThinkingValue);
      setDefaultThinkingCandidate(defaultThinkingValue);
      const threshold = parseInt(thresholdValue, 10) || 0;
      setAutoSummarizeThreshold(threshold);
      setAutoSummarizeEnabled(threshold > 0);
      setAgentSystemPrompt(typeof agentSystemPromptValue === 'string' ? agentSystemPromptValue : '');
    } catch (error) {
      console.error('Error loading settings:', error);
    }
    setLoading(false);
  };

  const loadSandboxPaths = async () => {
    try {
      const paths = await getSandboxPaths();
      setSandboxPaths(paths || []);
    } catch (error) {
      console.error('Error loading sandbox paths:', error);
      setToast({ message: 'Erro ao carregar paths da sandbox: ' + error.message, severity: 'error' });
    }
  };

  const handleTabChange = (event, newValue) => {
    setTabValue(newValue);
  };

  const handleProviderFormChange = (field) => (e) => {
    setProviderForm(prev => ({ ...prev, [field]: e.target.value }));
  };

  const handleEditProvider = (provider) => {
    setEditingProvider(provider);
    setProviderForm({ name: provider.name, apiKey: '', baseURL: provider.base_url });
  };

  const handleSaveProvider = async () => {
    try {
      if (editingProvider) {
        const updates = { name: providerForm.name, baseURL: providerForm.baseURL };
        if (providerForm.apiKey) {
          updates.apiKey = providerForm.apiKey;
        }
        await updateProvider(editingProvider.id, updates);
      } else {
        await createProvider(providerForm);
      }
      await loadData();
      setProviderForm({ name: '', apiKey: '', baseURL: '' });
      setEditingProvider(null);
      setToast({ message: 'Provider guardado!', severity: 'success' });
    } catch (error) {
      console.error('Error saving provider:', error);
      setToast({ message: 'Falha ao guardar provider: ' + error.message, severity: 'error' });
    }
  };

  const handleDeleteProvider = async (id) => {
    if (confirm('Delete this provider?')) {
      try {
        await deleteProvider(id);
        await loadData();
        setToast({ message: 'Provider deleted.', severity: 'success' });
      } catch (error) {
        console.error('Error deleting provider:', error);
        setToast({ message: 'Failed to delete provider: ' + error.message, severity: 'error' });
      }
    }
  };

  const handleFetchModels = async () => {
    if (!selectedProviderForModels) return;
    const provider = providers.find(p => p.id.toString() === selectedProviderForModels);
    if (!provider) return;
    setLoadingModels(true);
    try {
      const data = await fetchModels(provider.id);
      setModels(data);
    } catch (error) {
      console.error('Error fetching models:', error);
      setToast({ message: 'Failed to fetch models. Check the provider settings.', severity: 'error' });
    }
    setLoadingModels(false);
  };

  const handleSetDefaultModel = async () => {
    try {
      await setSetting('default_model', defaultModel);
      await setSetting('default_thinking_mode', defaultThinkingMode);
      setToast({ message: 'Default model set!', severity: 'success' });
    } catch (error) {
      console.error('Error setting default model:', error);
      setToast({ message: 'Failed to set default model: ' + error.message, severity: 'error' });
    }
  };

  const handleAutoSummarizeThresholdChange = async (event, newValue) => {
    setAutoSummarizeThreshold(newValue);
  };

  const handleAutoSummarizeEnabledChange = async (event) => {
    const enabled = event.target.checked;
    setAutoSummarizeEnabled(enabled);
    if (!enabled) {
      setAutoSummarizeThreshold(0);
      await setSetting('auto_summarize_threshold', '0');
    }
  };

  const handleSaveAutoSummarizeThreshold = async () => {
    try {
      await setSetting('auto_summarize_threshold', autoSummarizeThreshold.toString());
      setToast({ message: 'Threshold guardado!', severity: 'success' });
    } catch (error) {
      console.error('Error saving auto summarize threshold:', error);
      setToast({ message: 'Falha ao guardar threshold: ' + error.message, severity: 'error' });
    }
  };

  const handleSaveAgentSystemPrompt = async () => {
    try {
      await setSetting('agent_system_prompt', agentSystemPrompt);
      setToast({ message: 'Prompt guardado!', severity: 'success' });
    } catch (error) {
      console.error('Error saving agent system prompt:', error);
      setToast({ message: 'Falha ao guardar prompt: ' + error.message, severity: 'error' });
    }
  };

  const handleResetAgentSystemPrompt = async () => {
    setAgentSystemPrompt('');
    try {
      await setSetting('agent_system_prompt', '');
      setToast({ message: 'Prompt reposto.', severity: 'success' });
    } catch (error) {
      console.error('Error resetting agent system prompt:', error);
      setToast({ message: 'Falha ao repor prompt: ' + error.message, severity: 'error' });
    }
  };

  const handleProviderSelectChange = async (e) => {
    const newId = e.target.value;
    setSelectedProviderForModels(newId);
    setModels([]); // Clear models before auto-fetching new ones
    try {
      await setCurrentProviderId(newId);
    } catch (error) {
      console.error('Error setting current provider:', error);
    }
  };

  // ── Sandbox handlers ──
  const handleAddSandboxPath = async () => {
    const trimmed = newPathInput.trim();
    if (!trimmed) return;
    try {
      await createSandboxPath(trimmed, newPathMode);
      setNewPathInput('');
      await loadSandboxPaths();
      setToast({ message: 'Path added to sandbox!', severity: 'success' });
    } catch (error) {
      setToast({ message: error.message, severity: 'error' });
    }
  };

  const handleTogglePathMode = async (pathEntry) => {
    const newMode = pathEntry.access_mode === 'read' ? 'write' : 'read';
    try {
      await updateSandboxPath(pathEntry.id, { access_mode: newMode });
      await loadSandboxPaths();
    } catch (error) {
      setToast({ message: 'Falha ao alterar modo: ' + error.message, severity: 'error' });
    }
  };

  const handleDeleteSandboxPath = async (id) => {
    if (!confirm('Remover este path da sandbox?')) return;
    try {
      await deleteSandboxPath(id);
      await loadSandboxPaths();
      setToast({ message: 'Path removido.', severity: 'success' });
    } catch (error) {
      setToast({ message: 'Falha ao remover path: ' + error.message, severity: 'error' });
    }
  };

  const handleBrowserSelect = (path) => {
    setNewPathInput(path);
  };

  const filteredModels = models.filter(m => m.id.toLowerCase().includes(modelSearch.toLowerCase()));

  // Object of the currently chosen default model (includes virtual entry if not listed)
  const selectedDefaultModel = useMemo(() => {
    if (!defaultModel) return null;
    return models.find(m => m.id === defaultModel)
      || { id: defaultModel, name: defaultModel, contextWindow: null, thinkingModes: [], pricing: {} };
  }, [models, defaultModel]);

  // Dropdown options: filtered models + the saved default model (if it does not appear in the provider list)
  const defaultModelOptions = useMemo(() => {
    if (defaultModel && !filteredModels.some(m => m.id === defaultModel)) {
      return [{ id: defaultModel, name: defaultModel }, ...filteredModels];
    }
    return filteredModels;
  }, [filteredModels, defaultModel]);

  const defaultModelThinkingModes = selectedDefaultModel?.thinkingModes || [];

  // When the default model (or model list) changes without user intervention
  // utilizador, restaura o thinking default a partir do valor guardado (candidate).
  const defaultThinkingTouched = useRef(false);

  useEffect(() => {
    if (defaultThinkingTouched.current) return;
    const matched = findMatchingThinkingValue(defaultThinkingCandidate, defaultModelThinkingModes);
    if (matched !== defaultThinkingMode) {
      setDefaultThinkingMode(matched);
    }
  }, [selectedDefaultModel, defaultModelThinkingModes, defaultThinkingCandidate, defaultThinkingMode]);

  const handleDefaultModelChange = (e) => {
    defaultThinkingTouched.current = true;
    setDefaultModelState(e.target.value);
    setDefaultThinkingMode('');
  };

  const handleDefaultThinkingChange = (e) => {
    defaultThinkingTouched.current = true;
    setDefaultThinkingMode(e.target.value);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', bgcolor: 'background.default' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', gap: 1 }}>
        <IconButton onClick={onClose} size="small">
          <ArrowBack />
        </IconButton>
        <Typography variant="h6">Settings</Typography>
      </Box>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Tabs value={tabValue} onChange={handleTabChange}>
          <Tab label="Providers" />
          <Tab label="Models" />
          <Tab label="Context" />
          <Tab label="Sandbox" />
        </Tabs>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 3, pt: 2 }}>
        {/* ── TAB 0: Providers ── */}
        <TabPanel value={tabValue} index={0}>
          <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>Providers</Typography>
          {loading ? (
            <Typography>Loading...</Typography>
          ) : (
            <List>
              {providers.map((provider) => (
                <ListItem key={provider.id} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 0.5 }}>
                  <ListItemText
                    primary={provider.name}
                    secondary={`${provider.base_url}${provider.is_active ? ' (Active)' : ''}`}
                  />
                  <ListItemSecondaryAction>
                    <IconButton onClick={() => handleEditProvider(provider)}>
                      <Edit />
                    </IconButton>
                    <IconButton onClick={() => handleDeleteProvider(provider.id)}>
                      <Delete />
                    </IconButton>
                  </ListItemSecondaryAction>
                </ListItem>
              ))}
            </List>
          )}
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle1" sx={{ mb: 1 }}>{editingProvider ? 'Edit Provider' : 'Add Provider'}</Typography>
          <TextField
            label="Name"
            value={providerForm.name}
            onChange={handleProviderFormChange('name')}
            fullWidth
            margin="normal"
          />
          <TextField
            label={editingProvider ? "API Key (leave empty to keep current)" : "API Key"}
            value={providerForm.apiKey}
            onChange={handleProviderFormChange('apiKey')}
            fullWidth
            margin="normal"
            type="password"
          />
          <TextField
            label="Base URL"
            value={providerForm.baseURL}
            onChange={handleProviderFormChange('baseURL')}
            fullWidth
            margin="normal"
            placeholder="e.g., https://api.openai.com/v1"
          />
          <Button onClick={handleSaveProvider} variant="contained" sx={{ mt: 1 }}>
            {editingProvider ? 'Update' : 'Add'}
          </Button>
        </TabPanel>

        {/* ── TAB 1: Models ── */}
        <TabPanel value={tabValue} index={1}>
          <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>Models</Typography>
          <FormControl fullWidth margin="normal">
            <InputLabel>Provider</InputLabel>
            <Select
              value={selectedProviderForModels}
              onChange={handleProviderSelectChange}
            >
              {providers.map((provider) => (
                <MenuItem key={provider.id} value={provider.id.toString()}>
                  {provider.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {loadingModels ? (
            <Typography sx={{ mt: 1 }}>Loading models...</Typography>
          ) : models.length > 0 ? (
            <>
              <TextField
                label="Search Models"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                fullWidth
                margin="normal"
              />
              <FormControl fullWidth margin="normal">
                <InputLabel>Default Model</InputLabel>
                <Select value={defaultModel} onChange={handleDefaultModelChange}>
                  {defaultModelOptions.map((model) => (
                    <MenuItem key={model.id} value={model.id}>
                      {model.id}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {defaultModelThinkingModes.length > 0 && (
                <FormControl fullWidth margin="normal">
                  <InputLabel>Default Thinking Mode</InputLabel>
                  <Select
                    value={defaultThinkingMode}
                    onChange={handleDefaultThinkingChange}
                    label="Default Thinking Mode"
                  >
                    {defaultModelThinkingModes.map((mode) => (
                      <MenuItem key={mode.value} value={mode.value}>
                        {mode.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
              {selectedDefaultModel && <ModelDetailsPanel model={selectedDefaultModel} />}
              <Button onClick={handleSetDefaultModel} variant="contained" sx={{ mt: 1 }}>
                Set as Default
              </Button>
            </>
          ) : null}
        </TabPanel>

        {/* ── TAB 2: Context ── */}
        <TabPanel value={tabValue} index={2}>
          <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>Context Settings</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Configure automatic context compression when token limit is reached.
          </Typography>

          <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
            <Typography variant="body2" sx={{ mr: 2 }}>
              Enable Auto-Summarize
            </Typography>
            <Switch
              checked={autoSummarizeEnabled}
              onChange={handleAutoSummarizeEnabledChange}
            />
          </Box>

          {autoSummarizeEnabled && (
            <>
              <Typography variant="body2" gutterBottom>
                Auto-summarize when context reaches: {autoSummarizeThreshold}%
              </Typography>
              <Slider
                value={autoSummarizeThreshold}
                onChange={handleAutoSummarizeThresholdChange}
                valueLabelDisplay="auto"
                step={5}
                marks
                min={50}
                max={95}
                disabled={!autoSummarizeEnabled}
              />
              <Button
                onClick={handleSaveAutoSummarizeThreshold}
                variant="contained"
                sx={{ mt: 1 }}
                disabled={!autoSummarizeEnabled}
              >
                Save Threshold
              </Button>
            </>
          )}

          <Divider sx={{ my: 3 }} />

          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Agent System Prompt
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Optional extra instructions appended to the built-in coding agent prompt. Useful for experimenting with tone, workflow, or response format.
          </Typography>
          <TextField
            label="Custom agent instructions"
            value={agentSystemPrompt}
            onChange={(e) => setAgentSystemPrompt(e.target.value)}
            fullWidth
            multiline
            minRows={10}
            placeholder={'Example:\n- Always explain assumptions briefly.\n- End with a short checklist.\n- Prefer minimal edits over large refactors.'}
          />
          <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
            <Button onClick={handleSaveAgentSystemPrompt} variant="contained">
              Save Prompt
            </Button>
            <Button onClick={handleResetAgentSystemPrompt} variant="outlined">
              Reset to Default
            </Button>
          </Box>
        </TabPanel>

        {/* ── TAB 3: Sandbox ── */}
        <TabPanel value={tabValue} index={3}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>Sandbox Permissions</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Configure additional folders the sandbox can access. Read-only folders are mounted as read-only; write folders allow the sandbox to modify files there.
          </Typography>

          {/* Add path form */}
          <Box sx={{ display: 'flex', gap: 1, mb: 2, alignItems: 'flex-start' }}>
            <TextField
              label="Folder path"
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddSandboxPath(); }}
              placeholder="/home/user/.nvm"
              fullWidth
              size="small"
            />
            <FormControl size="small" sx={{ minWidth: 100 }}>
              <InputLabel>Access</InputLabel>
              <Select
                value={newPathMode}
                onChange={(e) => setNewPathMode(e.target.value)}
                label="Access"
              >
                <MenuItem value="read">Read</MenuItem>
                <MenuItem value="write">Write</MenuItem>
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              onClick={() => setBrowserOpen(true)}
              startIcon={<FolderOpen />}
              sx={{ whiteSpace: 'nowrap' }}
            >
              Browse
            </Button>
            <Button variant="contained" onClick={handleAddSandboxPath} disabled={!newPathInput.trim()}>
              Add
            </Button>
          </Box>

          {/* Paths list */}
          {sandboxPaths.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
              No additional sandbox paths configured.
            </Typography>
          ) : (
            <List>
              {sandboxPaths.map((entry) => (
                <ListItem key={entry.id} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 0.5 }}>
                  <ListItemText
                    primary={entry.path}
                    primaryTypographyProps={{ noWrap: true, title: entry.path, fontSize: '0.9rem' }}
                    secondary={
                      <Chip
                        label={entry.access_mode === 'write' ? 'Write' : 'Read'}
                        size="small"
                        color={entry.access_mode === 'write' ? 'warning' : 'default'}
                        variant="outlined"
                        sx={{ mt: 0.5, fontSize: '0.65rem', height: 20 }}
                      />
                    }
                  />
                  <ListItemSecondaryAction>
                    <Button
                      size="small"
                      onClick={() => handleTogglePathMode(entry)}
                      sx={{ mr: 1 }}
                    >
                      {entry.access_mode === 'read' ? 'Make Write' : 'Make Read'}
                    </Button>
                    <IconButton onClick={() => handleDeleteSandboxPath(entry.id)}>
                      <Delete />
                    </IconButton>
                  </ListItemSecondaryAction>
                </ListItem>
              ))}
            </List>
          )}

          <Divider sx={{ my: 3 }} />

          <Typography variant="subtitle1" sx={{ mb: 1 }}>Tips</Typography>
          <Typography variant="body2" color="text.secondary" component="div">
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>Add <code>~/.nvm</code> (read) to use npm/node installed via nvm inside the sandbox.</li>
              <li>Add <code>~/.npm</code> (write) to allow npm to cache packages.</li>
              <li>Add <code>~/.cache</code> (write) for tools that need a writable cache directory.</li>
              <li>Paths that don't exist are skipped automatically.</li>
            </ul>
          </Typography>
        </TabPanel>
      </Box>

      {/* Folder browser dialog */}
      <FolderBrowserDialog
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={handleBrowserSelect}
      />

      {/* Toast */}
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