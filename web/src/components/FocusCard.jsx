import React from 'react';
import { observer } from 'mobx-react-lite';
import { Box, Typography, Chip, Button, CircularProgress } from '@mui/material';
import { OpenInNew, CheckCircle, HourglassEmpty } from '@mui/icons-material';
import chatStore from '../stores/chatStore';

const FocusCard = observer(function FocusCard({ focusId, focusData, onOpen }) {
  const status = focusData?.status || 'running';
  const title = focusData?.title || `Investigation #${focusId}`;
  const goalPreview = focusData?.goal
    ? (focusData.goal.length > 160 ? `${focusData.goal.substring(0, 160)}…` : focusData.goal)
    : '';
  const report = focusData?.report;
  const isRunning = status === 'running';
  const isCompleted = status === 'completed';

  const sections = report?.sections || {};
  const summaryText = sections.summary || (typeof report?.report === 'string' ? report.report : '');
  const workPerformed = sections.workPerformed || '';
  const outstanding = sections.outstanding || '';
  const handoffNotes = sections.handoff || '';

  const truncate = (value, max = 200) => {
    if (!value) return '';
    return value.length > max ? `${value.substring(0, max)}…` : value;
  };

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: isRunning ? 'primary.main' : 'success.main',
        borderRadius: 2,
        p: 2,
        mb: 1.5,
        bgcolor: isRunning ? 'rgba(25, 118, 210, 0.04)' : 'rgba(46, 125, 50, 0.04)',
        transition: 'all 0.2s',
        '&:hover': {
          borderColor: isRunning ? 'primary.dark' : 'success.dark',
          boxShadow: 1
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {isRunning ? (
            <CircularProgress size={18} color="primary" />
          ) : isCompleted ? (
            <CheckCircle color="success" fontSize="small" />
          ) : (
            <HourglassEmpty color="warning" fontSize="small" />
          )}
          <Typography variant="subtitle2" fontWeight={600}>
            {title}
          </Typography>
        </Box>
        <Chip
          label={status}
          size="small"
          color={isRunning ? 'primary' : isCompleted ? 'success' : 'warning'}
          variant="outlined"
          sx={{ textTransform: 'capitalize', fontSize: '0.7rem' }}
        />
      </Box>

      {goalPreview && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: '0.8rem' }}>
          {goalPreview}
        </Typography>
      )}

      {report && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 1 }}>
          {summaryText && (
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '0.65rem', color: 'text.secondary' }}>
                Summary
              </Typography>
              <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>{truncate(summaryText)}</Typography>
            </Box>
          )}
          {workPerformed && (
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '0.65rem', color: 'text.secondary' }}>
                Work Performed
              </Typography>
              <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>{truncate(workPerformed)}</Typography>
            </Box>
          )}
          {outstanding && (
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '0.65rem', color: 'text.secondary' }}>
                Outstanding / Risks
              </Typography>
              <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>{truncate(outstanding)}</Typography>
            </Box>
          )}
          {handoffNotes && (
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '0.65rem', color: 'text.secondary' }}>
                Handoff Notes
              </Typography>
              <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>{truncate(handoffNotes)}</Typography>
            </Box>
          )}
        </Box>
      )}

      <Button
        size="small"
        variant="outlined"
        startIcon={<OpenInNew fontSize="small" />}
        onClick={() => onOpen?.(focusId)}
        sx={{ mt: 0.5, fontSize: '0.75rem' }}
      >
        {isRunning ? 'View Progress' : 'View Report'}
      </Button>
    </Box>
  );
});

export default FocusCard;
