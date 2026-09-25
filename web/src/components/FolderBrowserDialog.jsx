import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Box,
  Typography,
  IconButton,
  CircularProgress,
  Breadcrumbs,
  Link,
} from '@mui/material';
import {
  Folder as FolderIcon,
  ArrowUpward as ArrowUpwardIcon,
  Home as HomeIcon,
} from '@mui/icons-material';
import { browseDirectory } from '../api/sandbox';

export default function FolderBrowserDialog({ open, onClose, onSelect }) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDirectory = async (path) => {
    setLoading(true);
    setError('');
    try {
      const data = await browseDirectory(path);
      setCurrentPath(data.currentPath);
      setParentPath(data.parentPath);
      setEntries(data.entries || []);
    } catch (err) {
      setError(err.message);
      setEntries([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      loadDirectory('');
    }
  }, [open]);

  const handleEnterFolder = (entry) => {
    loadDirectory(entry.path);
  };

  const handleGoUp = () => {
    if (parentPath) {
      loadDirectory(parentPath);
    }
  };

  const handleGoHome = () => {
    loadDirectory('');
  };

  const handleSelectCurrent = () => {
    onSelect?.(currentPath);
    onClose();
  };

  // Build breadcrumb segments
  const segments = currentPath.split('/').filter(Boolean);
  const breadcrumbPaths = [];
  let acc = '';
  for (const seg of segments) {
    acc += '/' + seg;
    breadcrumbPaths.push({ name: seg, path: acc });
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Browse Folder</DialogTitle>
      <DialogContent>
        {/* Current path + navigation */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <IconButton size="small" onClick={handleGoHome} title="Home">
            <HomeIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" onClick={handleGoUp} disabled={!parentPath} title="Up">
            <ArrowUpwardIcon fontSize="small" />
          </IconButton>
          <Breadcrumbs maxItems={4} sx={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            {breadcrumbPaths.map((crumb, index) => (
              <Link
                key={crumb.path}
                component="button"
                variant="body2"
                underline={index === breadcrumbPaths.length - 1 ? 'none' : 'hover'}
                color={index === breadcrumbPaths.length - 1 ? 'text.primary' : 'primary'}
                onClick={() => loadDirectory(crumb.path)}
                sx={{ cursor: 'pointer', fontSize: '0.8rem' }}
              >
                {crumb.name}
              </Link>
            ))}
          </Breadcrumbs>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, wordBreak: 'break-all' }}>
          {currentPath}
        </Typography>

        {error && (
          <Typography variant="body2" color="error" sx={{ mb: 1 }}>
            {error}
          </Typography>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <List dense sx={{ maxHeight: 300, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            {entries.length === 0 ? (
              <ListItem>
                <ListItemText primary="No subdirectories" secondary="This folder has no subdirectories" />
              </ListItem>
            ) : (
              entries.map((entry) => (
                <ListItem
                  key={entry.path}
                  button
                  onClick={() => handleEnterFolder(entry)}
                  sx={{ borderRadius: 0.5 }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <FolderIcon fontSize="small" color="primary" />
                  </ListItemIcon>
                  <ListItemText
                    primary={entry.name}
                    primaryTypographyProps={{ noWrap: true, fontSize: '0.9rem' }}
                  />
                </ListItem>
              ))
            )}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSelectCurrent} variant="contained" disabled={!currentPath}>
          Select This Folder
        </Button>
      </DialogActions>
    </Dialog>
  );
}