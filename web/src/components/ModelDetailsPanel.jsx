import React from 'react';
import { Box, Typography, Chip } from '@mui/material';
import { formatTokens, formatPricePer1M, humanizeEffort } from '../utils/modelFormat';

function DetailRow({ label, value }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 150 }}>
        {label}
      </Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );
}

/**
 * Panel with the details of a selected model (prices, context, reasoning).
 * Usado no modal de modelo da conversa e na tab Models das Settings.
 */
export default function ModelDetailsPanel({ model }) {
  if (!model || typeof model !== 'object') return null;

  const pricing = model.pricing || {};
  const reasoning = model.reasoning || {};
  const efforts = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [];
  const thinkingModes = Array.isArray(model.thinkingModes) ? model.thinkingModes : [];

  return (
    <Box sx={{ mt: 1.5, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Detalhes do modelo
      </Typography>
      <DetailRow label="Janela de contexto" value={formatTokens(model.contextWindow)} />
      <DetailRow label="Prompt price" value={`${formatPricePer1M(pricing.prompt)} / 1M`} />
      <DetailRow label="Completion price" value={`${formatPricePer1M(pricing.completion)} / 1M`} />

      {efforts.length > 0 && (
        <DetailRow
          label="Efforts suportados"
          value={efforts.map((e) => humanizeEffort(e) || e).join(', ')}
        />
      )}

      {thinkingModes.length > 1 && (
        <DetailRow
          label="Thinking modes"
          value={thinkingModes.map((m) => m.label).join(', ')}
        />
      )}

      {(model.supportsReasoning || thinkingModes.length > 1) && (
        <Box sx={{ mt: 0.5, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          {reasoning.mandatory && <Chip label="Mandatory reasoning" size="small" color="warning" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />}
          {model.hasInternalReasoning && <Chip label="Reasoning interno" size="small" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />}
          {reasoning.defaultEnabled && <Chip label="Default reasoning" size="small" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />}
        </Box>
      )}
    </Box>
  );
}
