import React, { useState, useEffect } from 'react';
import {
  Drawer,
  Box,
  Typography,
  Tabs,
  Tab,
  TextField,
  Button,
  IconButton,
  Divider,
  List,
  ListItem,
  ListItemText,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Divider as MuiDivider,
  Tooltip,
  LinearProgress,
} from '@mui/material';
import { Close, Delete, ExpandMore, ContentCopy, Check, OpenInNew } from '@mui/icons-material';
import {
  updateConversation,
  deleteConversation,
  getConversationGitState,
  getConversationGitDiff,
  commitConversationChanges,
  mergeConversationChanges,
  resetConversationChanges
, openConversationFolder
} from '../api/conversations';
import { indexProject, indexWorktree, searchSemantic, getIndexStatus } from '../api/search';
import { indexConversation } from '../api/indexing';

function getStatusLabel(status) {
  switch (status) {
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    default:
      return 'Modified';
  }
}

function getStatusColor(status) {
  switch (status) {
    case 'A':
      return 'success';
    case 'D':
      return 'error';
    case 'R':
      return 'warning';
    case 'C':
      return 'info';
    default:
      return 'default';
  }
}

function DiffLine({ line }) {
  let bgcolor = 'transparent';
  let color = 'text.primary';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    bgcolor = 'rgba(46, 125, 50, 0.12)';
    color = '#1b5e20';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    bgcolor = 'rgba(211, 47, 47, 0.12)';
    color = '#b71c1c';
  } else if (line.startsWith('@@')) {
    bgcolor = 'rgba(2, 136, 209, 0.10)';
    color = '#01579b';
  } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    bgcolor = 'rgba(0, 0, 0, 0.04)';
    color = 'text.secondary';
  }

  return (
    <Box
      sx={{
        px: 1,
        py: 0.15,
        bgcolor,
        color,
        fontFamily: 'monospace',
        fontSize: '0.78rem',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere'
      }}
    >
      {line || ' '}
    </Box>
  );
}

function DiffPatch({ patch }) {
  if (!patch) {
    return (
      <Typography variant="body2" color="text.secondary">
        No patch available.
      </Typography>
    );
  }

  return (
    <Box sx={{ borderRadius: 1, overflow: 'hidden', border: '1px solid', borderColor: 'divider' }}>
      {patch.split('\n').map((line, index) => (
        <DiffLine key={`${index}-${line}`} line={line} />
      ))}
    </Box>
  );
}

function DiffSection({ title, summary, files }) {
  return (
    <Box sx={{ mt: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Typography variant="caption" color="text.secondary">
          {summary.filesChanged} ficheiros, +{summary.additions}, -{summary.deletions}
        </Typography>
      </Box>

      {files.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No changes in this section.
        </Typography>
      ) : (
        files.map((file) => (
          <Accordion key={`${title}-${file.status}-${file.oldPath || file.path}-${file.path}`} disableGutters sx={{ mb: 1 }}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box sx={{ width: '100%' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Chip label={getStatusLabel(file.status)} size="small" color={getStatusColor(file.status)} />
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {file.path}
                  </Typography>
                </Box>
                {file.oldPath && file.oldPath !== file.path && (
                  <Typography variant="caption" color="text.secondary">
                    from {file.oldPath}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" display="block">
                  +{file.additions ?? 0} / -{file.deletions ?? 0}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <DiffPatch patch={file.patch} />
            </AccordionDetails>
          </Accordion>
        ))
      )}
    </Box>
  );
}

export default function ConversationSettingsPanel({
  open,
  onClose,
  conversation,
  onConversationUpdated,
  onConversationDeleted
}) {
  const [tabValue, setTabValue] = useState(0);
  const [conversationTitle, setConversationTitle] = useState(conversation?.title || '');
  const [loading, setLoading] = useState(false);
  const [gitState, setGitState] = useState(null);
  const [gitDiff, setGitDiff] = useState(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [copiedPath, setCopiedPath] = useState(false);

  // Search tab state
  const [searchTabValue, setSearchTabValue] = useState(0);
  const [indexingLoading, setIndexingLoading] = useState(false);
  const [indexingStatus, setIndexingStatus] = useState('');
  const [indexProgress, setIndexProgress] = useState(null); // { source, file, indexableCount, totalChunks, chunksIndexed, percent }
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    if (!conversation?.title && conversation?.title !== '') {
      return;
    }

    setConversationTitle(conversation?.title || '');
  }, [conversation?.title]);

  // Reset all volatile fields when conversation changes
  useEffect(() => {
    if (!conversation?.id) return;

    setTabValue(0);
    setGitState(null);
    setGitDiff(null);
    setCommitMessage('');
    setIndexProgress(null);
    setIndexingStatus('');
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
  }, [conversation?.id]);

  useEffect(() => {
    if (!open || !conversation?.id || tabValue !== 1) {
      setGitState(null);
      setGitDiff(null);
      return;
    }

    loadGitState();
  }, [open, conversation?.id, tabValue]);

  useEffect(() => {
    if (!open || !conversation?.id || tabValue !== 2) {
      setIndexProgress(null);
      setIndexingStatus('');
      return;
    }

    loadIndexStatus();
  }, [open, conversation?.id, tabValue]);

  const handleTabChange = (event, newValue) => {
    setTabValue(newValue);
  };

  const handleTitleChange = (event) => {
    setConversationTitle(event.target.value);
  };

  const handleSaveTitle = async () => {
    if (!conversation || !conversationTitle.trim() || conversationTitle === conversation.title) {
      return;
    }

    setLoading(true);
    try {
      const updated = await updateConversation(conversation.id, conversationTitle.trim());
      onConversationUpdated(updated);
      onClose();
    } catch (error) {
      console.error('Error updating conversation:', error);
      alert('Erro ao atualizar conversa: ' + error.message);
    }
    setLoading(false);
  };

  const handleDeleteConversation = async () => {
    if (!conversation) return;

    let mergeGitState = gitState;
    if (!mergeGitState) {
      try {
        mergeGitState = await getConversationGitState(conversation.id);
        setGitState(mergeGitState);
      } catch (error) {
        console.error('Error loading git state for delete confirmation:', error);
        mergeGitState = null;
      }
    }

    const hasUnmergedWork = Boolean(mergeGitState?.hasCommitsToMerge) || Number(mergeGitState?.ahead || 0) > 0 || Boolean(mergeGitState?.hasUncommittedChanges);
    const safeLabel = hasUnmergedWork ? 'Unsafe' : 'Safe';
    const warning = hasUnmergedWork
      ? 'There is still unmerged work; deleting may cause these changes to be lost.'
      : 'Changes have already been merged; deletion should not cause data loss.';
    const confirmed = window.confirm(`Are you sure you want to delete the conversation "${conversation.title}"?\nStatus: ${safeLabel}\n${warning}\n\nThis action cannot be undone.`);
    if (!confirmed) return;

    setLoading(true);
    try {
      await deleteConversation(conversation.id);
      onConversationDeleted(conversation);
      onClose();
    } catch (error) {
      console.error('Error deleting conversation:', error);
      alert('Error deleting conversation: ' + error.message);
    }
    setLoading(false);
  };

  const loadGitState = async () => {
    if (!conversation?.id) return;

    setGitLoading(true);
    try {
      const state = await getConversationGitState(conversation.id);
      setGitState(state);
      if (!commitMessage) {
        setCommitMessage(conversation.title);
      }
    } catch (error) {
      console.error('Error loading git state:', error);
      alert('Erro ao carregar estado Git: ' + error.message);
    }

    try {
      const diff = await getConversationGitDiff(conversation.id);
      setGitDiff(diff);
    } catch (error) {
      console.error('Error loading git diff:', error);
      setGitDiff(null);
    }
    setGitLoading(false);
  };

  const loadIndexStatus = async () => {
    if (!conversation?.id) return;

    try {
      const status = await getIndexStatus(conversation.id);
      if (status.indexed) {
        setIndexingStatus(`Indexed: ${status.chunkCount} chunks (${status.lastIndexed ? new Date(status.lastIndexed).toLocaleString() : 'unknown time'})`);
      } else {
        setIndexingStatus('Not indexed yet');
      }
    } catch (error) {
      console.error('Error loading index status:', error);
      setIndexingStatus('Error loading index status');
    }
  };

  const handleIndexAll = async () => {
    if (!conversation?.id) return;

    setIndexingLoading(true);
    setIndexProgress(null);
    setIndexingStatus('Starting indexing...');

    try {
      await indexConversation(conversation.id, {
        onProgress: (data) => {
          const percent = (data.totalChunks || 0) > 0
            ? Math.round((data.chunksIndexed / data.totalChunks) * 100)
            : 0;
          setIndexProgress({ ...data, percent });
          const fileInfo = data.file ? ` - ${data.file}` : '';
          setIndexingStatus(`${data.source}: ${data.chunksIndexed}/${data.totalChunks} chunks${fileInfo}`);
        },
        onDone: (data) => {
          setIndexProgress(null);
          setIndexingStatus(`Done: ${data.chunkCount} chunks indexed`);
          loadIndexStatus();
        },
        onError: (err) => {
          setIndexProgress(null);
          setIndexingStatus(`Error: ${err.message}`);
        }
      });
    } catch (error) {
      console.error('Error during indexing:', error);
      setIndexProgress(null);
      setIndexingStatus(`Error: ${error.message}`);
    }

    setIndexingLoading(false);
  };

  const handleSearch = async () => {
    if (!conversation?.id || !searchQuery.trim()) return;

    setSearchLoading(true);
    setSearchResults([]);

    try {
      const results = await searchSemantic(searchQuery.trim(), conversation.id);
      setSearchResults(results);
    } catch (error) {
      console.error('Error performing search:', error);
      alert('Search error: ' + error.message);
    }
    setSearchLoading(false);
  };

  const handleCommit = async () => {
    if (!conversation?.id) return;

    setGitLoading(true);
    try {
      await commitConversationChanges(conversation.id, commitMessage.trim());
      await loadGitState();
    } catch (error) {
      console.error('Error committing conversation changes:', error);
      alert('Erro ao fazer commit: ' + error.message);
    }
    setGitLoading(false);
  };

  const handleMerge = async () => {
    if (!conversation?.id) return;

    setGitLoading(true);
    try {
      await mergeConversationChanges(conversation.id);
      await loadGitState();
    } catch (error) {
      console.error('Error merging conversation changes:', error);
      alert('Erro ao fazer merge: ' + error.message);
    }
    setGitLoading(false);
  };

  const handleReset = async () => {
    if (!conversation?.id) return;

    const confirmed = window.confirm('Discard all uncommitted changes from this worktree??');
    if (!confirmed) return;

    setGitLoading(true);
    try {
      await resetConversationChanges(conversation.id);
      await loadGitState();
    } catch (error) {
      console.error('Error resetting conversation changes:', error);
      alert('Erro ao fazer reset: ' + error.message);
    }
    setGitLoading(false);
  };

  const handleCopyPath = async () => {
    const folderPath = gitState?.folderPath;
    if (!folderPath) return;

    try {
      await navigator.clipboard.writeText(folderPath);
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1500);
    } catch (error) {
      console.error('Error copying path:', error);
      alert('Erro ao copiar caminho.');
    }
  };

  const handleOpenFolder = async () => {
    if (!conversation?.id) return;

    try {
      await openConversationFolder(conversation.id);
    } catch (error) {
      console.error('Error opening folder:', error);
      alert('Erro ao abrir pasta: ' + error.message);
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      sx={{
        '& .MuiDrawer-paper': {
          width: 560,
          maxWidth: '100vw',
          p: 2
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6">
          Conversation Settings
        </Typography>
        <IconButton onClick={onClose}>
          <Close />
        </IconButton>
      </Box>

      <Tabs value={tabValue} onChange={handleTabChange} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="Geral" />
        <Tab label="Git" />
        <Tab label="Search" />
      </Tabs>

      <Box sx={{ mt: 2 }}>
        {tabValue === 0 && (
          <Box>
            <Typography variant="subtitle1" sx={{ mb: 2 }}>
              Geral
            </Typography>

            <TextField
              label="Nome da conversa"
              value={conversationTitle}
              onChange={handleTitleChange}
              fullWidth
              margin="normal"
              disabled={loading}
            />

            <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
              <Button
                onClick={handleSaveTitle}
                variant="contained"
                disabled={loading || !conversationTitle.trim() || conversationTitle === conversation?.title}
                fullWidth
              >
                Salvar Nome
              </Button>
            </Box>

            <Divider sx={{ my: 3 }} />

            <Typography variant="subtitle1" sx={{ mb: 2, color: 'error.main' }}>
              Zona de Perigo
            </Typography>

            <Button
              onClick={handleDeleteConversation}
              variant="outlined"
              color="error"
              startIcon={<Delete />}
              disabled={loading}
              fullWidth
            >
              Apagar Conversa
            </Button>
          </Box>
        )}

        {tabValue === 1 && (
          <Box>
            <Typography variant="subtitle1" sx={{ mb: 2 }}>
              Git da Conversa
            </Typography>

            {gitState && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                <Chip label={`Branch: ${gitState.branch}`} size="small" />
                <Chip label={`Base: ${gitState.baseBranch}`} size="small" variant="outlined" />
                <Chip label={`Ahead: ${gitState.ahead}`} size="small" color={gitState.ahead > 0 ? 'primary' : 'default'} />
                <Chip label={`Behind: ${gitState.behind}`} size="small" color={gitState.behind > 0 ? 'warning' : 'default'} />
              </Box>
            )}

            <TextField
              label="Mensagem de commit"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              fullWidth
              margin="normal"
              disabled={gitLoading}
            />

            <Box sx={{ display: 'flex', gap: 1, mt: 2, mb: 2 }}>
              <Button
                onClick={handleCommit}
                variant="contained"
                disabled={gitLoading || !commitMessage.trim() || !gitState?.hasUncommittedChanges}
                fullWidth
              >
                Commit
              </Button>
              <Button
                onClick={handleMerge}
                variant="outlined"
                disabled={gitLoading || gitState?.hasUncommittedChanges || !gitState?.hasCommitsToMerge}
                fullWidth
              >
                Merge
              </Button>
              <Button
                onClick={handleReset}
                variant="outlined"
                color="warning"
                disabled={gitLoading || !gitState?.hasUncommittedChanges}
                fullWidth
              >
                Reset
              </Button>
            </Box>

            <Button onClick={loadGitState} variant="text" disabled={gitLoading} sx={{ mb: 2 }}>
              {gitLoading ? 'A atualizar...' : 'Atualizar estado Git'}
            </Button>

            {gitState?.isProjectMemory && (
              <Typography variant="body2" color="warning.main" sx={{ mb: 1 }}>
                Main Project Repository (read-only).
              </Typography>
            )}

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
              >
                {gitState?.isProjectMemory ? 'Repository' : 'Worktree'}: {gitState?.folderPath || 'N/A'}
              </Typography>
              <Tooltip title={copiedPath ? 'Copiado' : 'Copiar caminho'}>
                <span>
                  <IconButton
                    size="small"
                    onClick={handleCopyPath}
                    disabled={!gitState?.folderPath}
                    aria-label="Copiar caminho"
                  >
                    {copiedPath ? <Check fontSize="small" /> : <ContentCopy fontSize="small" />}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Abrir pasta">
                <span>
                  <IconButton
                    size="small"
                    onClick={handleOpenFolder}
                    disabled={!gitState?.folderPath}
                    aria-label="Abrir pasta"
                  >
                    <OpenInNew fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>

            <Typography variant="subtitle2" sx={{ mt: 2 }}>
              Ficheiros alterados
            </Typography>
            <List dense>
              {(gitState?.changedFiles || []).map((file) => (
                <ListItem key={file.raw} disableGutters>
                  <ListItemText
                    primary={file.path}
                    secondary={`${file.staged}${file.unstaged} | Index: ${file.staged} | Working tree: ${file.unstaged}`}
                  />
                </ListItem>
              ))}
              {gitState && gitState.changedFiles.length === 0 && (
                <ListItem disableGutters>
                  <ListItemText primary="No local changes." />
                </ListItem>
              )}
            </List>

            <MuiDivider sx={{ my: 2 }} />

            {gitDiff?.branchReview && (
              <DiffSection
                title="Ready To Merge"
                summary={gitDiff.branchReview.summary}
                files={gitDiff.branchReview.files}
              />
            )}

            {gitDiff?.workingTreeReview && (
              <DiffSection
                title="Local Worktree Changes"
                summary={gitDiff.workingTreeReview.summary}
                files={gitDiff.workingTreeReview.files}
              />
            )}
          </Box>
        )}

        {tabValue === 2 && (
          <Box>
            <Typography variant="subtitle1" sx={{ mb: 2 }}>
              Semantic Search
            </Typography>

            <Tabs value={searchTabValue} onChange={(event, newValue) => setSearchTabValue(newValue)} sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
              <Tab label="Indexing" />
              <Tab label="Search" />
            </Tabs>

            {searchTabValue === 0 && (
              <Box>
                <Typography variant="body2" sx={{ mb: 2 }}>
                  Index project + worktree files for semantic search
                </Typography>
                <Button
                  onClick={handleIndexAll}
                  variant="contained"
                  disabled={indexingLoading}
                  fullWidth
                  sx={{ mb: 2 }}
                >
                  {indexingLoading ? 'Indexing...' : 'Index Project & Worktree'}
                </Button>
                <Button onClick={loadIndexStatus} variant="text" disabled={indexingLoading} sx={{ mb: 1 }}>
                  Refresh Status
                </Button>

                  {indexProgress && (
                  <Box sx={{ mt: 2, mb: 2 }}>
                    <LinearProgress
                      variant="determinate"
                      value={indexProgress.percent}
                      sx={{ height: 8, borderRadius: 1 }}
                    />
                    <Typography variant="caption" sx={{ mt: 0.5, display: 'block', color: 'text.secondary' }}>
                      {indexProgress.source} • {indexProgress.chunksIndexed}/{indexProgress.totalChunks} chunks
                      {indexProgress.file ? ` • ${indexProgress.file}` : ''}
                    </Typography>
                  </Box>
                )}

                {indexingStatus && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {indexingStatus}
                  </Typography>
                )}
              </Box>
            )}

            {searchTabValue === 1 && (
              <Box>
                <TextField
                  label="Search query"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  fullWidth
                  margin="normal"
                  disabled={searchLoading}
                />
                <Button
                  onClick={handleSearch}
                  variant="contained"
                  disabled={searchLoading || !searchQuery.trim()}
                  fullWidth
                >
                  {searchLoading ? 'Searching...' : 'Search'}
                </Button>
                {searchResults.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                      Results:
                    </Typography>
                    {searchResults.map((result, index) => (
                      <Accordion key={index} disableGutters sx={{ mb: 1 }}>
                        <AccordionSummary expandIcon={<ExpandMore />}>
                          <Box sx={{ width: '100%' }}>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {result.file}:{result.startLine}-{result.endLine}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Similarity: {(result.similarity * 100).toFixed(1)}%
                            </Typography>
                          </Box>
                        </AccordionSummary>
                        <AccordionDetails>
                          <Box
                            sx={{
                              fontFamily: 'monospace',
                              fontSize: '0.8rem',
                              bgcolor: 'grey.100',
                              p: 1,
                              borderRadius: 1,
                              whiteSpace: 'pre-wrap'
                            }}
                          >
                            {result.content}
                          </Box>
                        </AccordionDetails>
                      </Accordion>
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Drawer>
  );
}
