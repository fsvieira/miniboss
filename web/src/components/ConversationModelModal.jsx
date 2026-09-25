import React, { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, FormControl, InputLabel, Select, MenuItem, TextField, Typography } from '@mui/material';
import { getProviders, getActiveProvider } from '../api/providers';
import { fetchModels } from '../api/ai';
import { getSetting } from '../api/settings';
import ModelDetailsPanel from './ModelDetailsPanel';
import { findMatchingThinkingValue } from '../utils/modelFormat';

export default function ConversationModelModal({ open, onClose, conversation, onSave }) {
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [thinkingMode, setThinkingMode] = useState('');
  const [noProviderMessage, setNoProviderMessage] = useState('');
  // Raw thinking candidate: conversation value, otherwise global default
  const [thinkingCandidate, setThinkingCandidate] = useState('');

  useEffect(() => {
    if (open) {
      loadProviders();
    }
  }, [open, conversation]);

  // Auto-fetch models when provider changes
  useEffect(() => {
    if (selectedProvider) {
      handleFetchModels();
    }
  }, [selectedProvider]);

  const loadProviders = async () => {
    setNoProviderMessage('');
    try {
      const [providersData, activeProvider, defaultModelValue, defaultThinkingValue] = await Promise.all([
        getProviders(),
        getActiveProvider().catch(() => null),
        getSetting('default_model').catch(() => null),
        getSetting('default_thinking_mode').catch(() => null),
      ]);
      setProviders(providersData);

      let providerId = conversation?.provider_id;
      if (providerId && !providersData.some((p) => String(p.id) === String(providerId))) {
        providerId = null; // conversation provider no longer exists
      }
      if (!providerId && activeProvider) {
        providerId = activeProvider.id;
      }
      if (!providerId && providersData.length > 0) {
        providerId = providersData[0].id;
      }
      if (!providerId) {
        setSelectedProvider('');
        setSelectedModel('');
        setModels([]);
        setNoProviderMessage('Sem provider configurado. Adicione um provider nas Settings.');
        return;
      }
      setSelectedProvider(providerId.toString());

      const effectiveModel = conversation?.model || defaultModelValue || 'gpt-3.5-turbo';
      setSelectedModel(effectiveModel);
      setThinkingCandidate(conversation?.thinking_mode || defaultThinkingValue || '');
    } catch (error) {
      console.error('Error loading providers:', error);
      setNoProviderMessage('Erro ao carregar providers: ' + (error.message || error));
    }
  };

  const handleFetchModels = async () => {
    if (!selectedProvider) return;
    setLoadingModels(true);

    try {
      const modelsData = await fetchModels(selectedProvider);
      setModels(modelsData);
    } catch (error) {
      console.error('Error fetching models:', error);
      setNoProviderMessage('Failed to load models. Check the provider settings.');
    }
    setLoadingModels(false);
  };

  const handleProviderChange = (e) => {
    setSelectedProvider(e.target.value);
    setSelectedModel('');
    setModels([]);
  };

  const handleModelChange = (e) => {
    const nextModel = e.target.value;
    setSelectedModel(nextModel);
  };

  // Display list: ensures the current effective model is always a valid option
  const displayModels = useMemo(() => {
    if (!selectedModel) return models;
    if (models.some((m) => m.id === selectedModel)) return models;
    return [
      ...models,
      { id: selectedModel, name: selectedModel, contextWindow: null, thinkingModes: [], pricing: {} },
    ];
  }, [models, selectedModel]);

  const selectedModelObject = displayModels.find((m) => m.id === selectedModel) || null;
  const thinkingModes = selectedModelObject?.thinkingModes || [];
  const supportsReasoning = thinkingModes.length > 0;

  // Normaliza o thinking seleccionado quando o modelo/lista muda
  useEffect(() => {
    if (!supportsReasoning) {
      setThinkingMode('');
      return;
    }
    const matched = findMatchingThinkingValue(thinkingCandidate, thinkingModes);
    setThinkingMode(matched);
  }, [selectedModel, models, thinkingCandidate]);

  const filteredModels = displayModels.filter((m) =>
    m.id.toLowerCase().includes(modelSearch.toLowerCase())
  );

  const handleSave = async () => {
    try {
      const payload = {
        providerId: selectedProvider ? parseInt(selectedProvider, 10) : null,
        model: selectedModel || null,
        thinkingMode: supportsReasoning && thinkingMode ? thinkingMode : null
      };
      onSave(payload);
      onClose();
    } catch (error) {
      console.error('Error saving conversation model:', error);
      alert('Failed to save: ' + error.message);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Modelo da Conversa</DialogTitle>
      <DialogContent>
        {noProviderMessage && !providers.length && (
          <Typography color="warning.main" sx={{ mt: 1 }}>
            {noProviderMessage}
          </Typography>
        )}

        <FormControl fullWidth margin="normal">
          <InputLabel>Provider</InputLabel>
          <Select
            value={selectedProvider}
            onChange={handleProviderChange}
            label="Provider"
          >
            {providers.map((provider) => (
              <MenuItem key={provider.id} value={provider.id.toString()}>
                {provider.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {loadingModels ? (
          <Typography sx={{ mt: 1 }}>Carregando modelos...</Typography>
        ) : displayModels.length > 0 ? (
          <>
            <TextField
              label="Procurar Modelos"
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              fullWidth
              margin="normal"
              size="small"
            />
            <FormControl fullWidth margin="normal">
              <InputLabel>Modelo</InputLabel>
              <Select
                value={selectedModel}
                onChange={handleModelChange}
                label="Modelo"
              >
                {filteredModels.map((model) => (
                  <MenuItem key={model.id} value={model.id}>
                    {model.id}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {supportsReasoning && thinkingModes.length > 0 && (
              <FormControl fullWidth margin="normal">
                <InputLabel>Thinking Mode</InputLabel>
                <Select
                  value={thinkingMode}
                  onChange={(e) => setThinkingMode(e.target.value)}
                  label="Thinking Mode"
                >
                  {thinkingModes.map((mode) => (
                    <MenuItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {selectedModelObject && <ModelDetailsPanel model={selectedModelObject} />}
          </>
        ) : (
          !loadingModels && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {noProviderMessage || 'No model available for this provider.'}
            </Typography>
          )
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancelar</Button>
        <Button onClick={handleSave} variant="contained" disabled={!selectedModel}>
          Salvar
        </Button>
      </DialogActions>
    </Dialog>
  );
}
