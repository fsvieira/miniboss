import React from 'react';
import { Box, Typography, LinearProgress, Chip, Button, Tooltip } from '@mui/material';
import { Delete } from '@mui/icons-material';
import { thinkingModeLabel } from '../utils/modelFormat';

function formatTokens(num) {
  if (num == null) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return num.toString();
}

function formatCost(cost, partial = false) {
  if (cost == null) return '—';
  const prefix = partial ? '≈ ' : '';
  if (cost >= 0.01) return prefix + '$' + cost.toFixed(2);
  if (cost >= 0.0001) return prefix + '$' + cost.toFixed(4);
  return prefix + '$' + cost.toFixed(6);
}

function formatModelCost(cost) {
  if (cost == null) return '—';
  if (cost >= 0.01) return '$' + cost.toFixed(2);
  if (cost >= 0.0001) return '$' + cost.toFixed(4);
  return '$' + cost.toFixed(6);
}

export default function ContextIndicator({
  contextInfo,
  onClear,
  busy = false,
  conversation,
  onModelChange,
  hideClear = false
}) {
  if (!contextInfo) return null;

  const { input_tokens, token_limit, percentage = 0, model, provider_name, compressed_tokens, total_tokens, total_cost, models, question_count, subbot_count, focus_level, thinking_mode, models_breakdown, cost_coverage, unpriced_calls, cost_partial } = contextInfo;

  const getColor = (pct) => {
    if (pct >= 90) return 'error';
    if (pct >= 70) return 'warning';
    return 'success';
  };

  const isPartial = cost_partial === true || (cost_coverage != null && cost_coverage < 1);
  // A null cost means "unknown", not "free": it is only rendered when there is
  // actually something to report (a partial total or a priced call).
  const showCost = total_cost != null || isPartial;
  const costText = showCost ? formatCost(total_cost, isPartial) : null;
  const thinkingLabel = thinking_mode ? thinkingModeLabel(thinking_mode) : null;
  const modelLabel = thinkingLabel
    ? (provider_name ? `${provider_name}: ${model}` : model) + ` · ${thinkingLabel}`
    : (provider_name ? `${provider_name}: ${model}` : model);
  const modelTooltip = [
    provider_name ? `Provider: ${provider_name}` : null,
    model ? `Modelo: ${model}` : null,
    thinkingLabel ? `Thinking: ${thinkingLabel}` : null,
  ].filter(Boolean).join(' • ');
  const breakdown = Array.isArray(models_breakdown) ? models_breakdown : [];
  const breakdownLines = breakdown.map(entry => {
    const unpriced = entry.unpriced_calls > 0 ? ` (${entry.unpriced_calls} sem preço)` : '';
    return `${entry.model}: ${formatModelCost(entry.cost_usd)}${unpriced} · ${entry.calls} chamada(s)`;
  });
  const metricsTooltip = [
    models && models.length ? `Modelos: ${models.join(', ')}` : null,
    question_count != null ? `Perguntas: ${question_count}` : null,
    subbot_count != null ? `Sub-investigações: ${subbot_count}` : null,
    focus_level != null && focus_level > 0 ? `Focus level: ${focus_level}` : null,
    isPartial && unpriced_calls ? `${unpriced_calls} chamada(s) sem preço — total parcial` : null,
    breakdownLines.length ? '' : null,
    ...breakdownLines,
  ].filter(Boolean).join(' • ');

  return (
    <Box sx={{
      px: 1.5,
      py: 0.75,
      borderBottom: '1px solid',
      borderColor: 'divider',
      bgcolor: 'background.paper'
    }}>
      {/* Line 1: Info + Actions */}
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        mb: 0.5
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
            {formatTokens(compressed_tokens ?? input_tokens)} / {formatTokens(token_limit)} ({percentage}%)
          </Typography>
          {total_tokens != null && (
            <Tooltip title={metricsTooltip || 'Conversation token usage (includes sub-investigations)'}>
              <Chip
                label={`Total: ${formatTokens(total_tokens)}${costText ? ` · ${costText}` : ''}`}
                size="x-small"
                variant="outlined"
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            </Tooltip>
          )}
          {model && (
            <Tooltip title={modelTooltip}>
              <span>
                <Chip
                  label={modelLabel}
                  size="x-small"
                  variant="outlined"
                  onClick={busy ? undefined : onModelChange}
                  clickable={Boolean(onModelChange) && !busy}
                  sx={{ height: 20, fontSize: '0.7rem' }}
                />
              </span>
            </Tooltip>
          )}
        </Box>

        {/* Actions */}
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {!hideClear && (
          <Tooltip title="Limpar conversa">
            <Button
              size="small"
              variant="outlined"
              startIcon={<Delete sx={{ fontSize: 14 }} />}
              onClick={onClear}
              disabled={busy}
              sx={{ fontSize: '0.7rem', py: 0.3, px: 1, minWidth: 0 }}
            >
              Limpar
            </Button>
          </Tooltip>
          )}

        </Box>
      </Box>

      {/* Linha 2 - Progresso */}
      <LinearProgress
        variant="determinate"
        value={Math.min(percentage, 100)}
        color={getColor(percentage)}
        sx={{ height: '0.3em', borderRadius: '2px' }}
      />
    </Box>
  );
}
