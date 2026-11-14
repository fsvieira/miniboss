import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  CircularProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Breadcrumbs,
  Link,
  IconButton,
  Divider,
  Alert,
  Button,
  Chip,
} from '@mui/material';
import {
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Description as DescriptionIcon,
  Search as SearchIcon,
  Home as HomeIcon,
  ArrowUpward as ArrowUpwardIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Close as CloseIcon,
  NoteAdd as NoteAddIcon,
} from '@mui/icons-material';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  getCodeTree,
  getCodeFile,
  searchCode,
  getCodeAnnotations,
  createCodeAnnotation,
  updateCodeAnnotation,
  deleteCodeAnnotation,
} from '../api/code';

const LANGUAGE_BY_EXT = {
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  xml: 'xml',
  vue: 'vue',
  svg: 'xml',
  graphql: 'graphql',
  proto: 'protobuf',
};

function languageForPath(relpath) {
  const ext = relpath.split('.').pop().toLowerCase();
  return LANGUAGE_BY_EXT[ext] || 'text';
}

// Build a nested folder/file tree from a flat list of relpaths.
function buildTree(files) {
  const root = { name: '', path: '', type: 'dir', children: [] };
  const dirMap = { '': root };

  for (const file of files) {
    const parts = file.split('/');
    let parent = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (!dirMap[acc]) {
        const node = { name: parts[i], path: acc, type: 'dir', children: [] };
        dirMap[acc] = node;
        parent.children.push(node);
      }
      parent = dirMap[acc];
    }
    parent.children.push({ name: parts[parts.length - 1], path: file, type: 'file' });
  }

  const sortNodes = (nodes) =>
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const sortRecursive = (nodes) => {
    sortNodes(nodes);
    nodes.forEach((n) => n.children && sortRecursive(n.children));
  };
  sortRecursive(root.children);
  return root;
}

function ancestors(path) {
  const parts = (path || '').split('/').filter(Boolean);
  const out = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

function TreeNode({ node, expanded, onToggle, onOpen, depth = 0 }) {
  const isDir = node.type === 'dir';
  return (
    <>
      <ListItem
        button
        dense
        sx={{ pl: 1 + depth * 2, py: 0, minHeight: 30 }}
        onClick={() => (isDir ? onToggle(node.path) : onOpen(node.path))}
      >
        <ListItemIcon sx={{ minWidth: 30 }}>
          {isDir ? (
            expanded.has(node.path) ? (
              <FolderOpenIcon fontSize="small" color="primary" />
            ) : (
              <FolderIcon fontSize="small" color="primary" />
            )
          ) : (
            <DescriptionIcon fontSize="small" color="action" />
          )}
        </ListItemIcon>
        <ListItemText
          primary={node.name}
          primaryTypographyProps={{ noWrap: true, fontSize: '0.85rem' }}
        />
      </ListItem>
      {isDir && expanded.has(node.path) && node.children
        ? node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
              depth={depth + 1}
            />
          ))
        : null}
    </>
  );
}

export default function CodeNavigator({ project }) {
  const [tree, setTree] = useState({ name: '', path: '', type: 'dir', children: [] });
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState('');

  const [expanded, setExpanded] = useState(() => new Set());
  const [selectedFile, setSelectedFile] = useState('');
  const [fileMeta, setFileMeta] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');

  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState([]);
  const [nameResults, setNameResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [mode, setMode] = useState('browse');

  const [pendingTargetLine, setPendingTargetLine] = useState(null);
  const codeContainerRef = useRef(null);

  const [annotations, setAnnotations] = useState([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [annotationsError, setAnnotationsError] = useState('');
  const [annotateMode, setAnnotateMode] = useState(false);
  const [selStart, setSelStart] = useState(null);
  const [selEnd, setSelEnd] = useState(null);
  const [composer, setComposer] = useState(null); // { mode: 'new' | 'edit', id?, note }
  const [composerTags, setComposerTags] = useState([]);
  const [composerTagsInput, setComposerTagsInput] = useState('');
  const [expandedCards, setExpandedCards] = useState(() => new Set());
  const [annotationResults, setAnnotationResults] = useState([]);

  const resetAnnotationState = useCallback(() => {
    setAnnotateMode(false);
    setSelStart(null);
    setSelEnd(null);
    setComposer(null);
    setComposerTags([]);
    setComposerTagsInput('');
    setExpandedCards(new Set());
  }, []);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError('');
    try {
      const data = await getCodeTree(project.id);
      setTree(buildTree(data.files || []));
      setExpanded(new Set());
      setSelectedFile('');
      setFileContent('');
      setFileMeta(null);
      setFileError('');
    } catch (err) {
      setTreeError(err.message);
    }
    setTreeLoading(false);
  }, [project.id]);

  useEffect(() => {
    if (project?.id) {
      loadTree();
    }
  }, [project?.id, loadTree]);

  const expandToPath = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      ancestors(path).forEach((p) => next.add(p));
      return next;
    });
  }, []);

  const openFile = useCallback(async (path) => {
    setSelectedFile(path);
    setFileLoading(true);
    setFileError('');
    setFileMeta(null);
    setFileContent('');
    resetAnnotationState();
    expandToPath(path);
    try {
      const data = await getCodeFile(project.id, path);
      setFileMeta(data);
      setFileContent(data.content);
      setAnnotationsLoading(true);
      setAnnotationsError('');
      try {
        const ann = await getCodeAnnotations(project.id, path);
        setAnnotations(ann.annotations || []);
      } catch (annErr) {
        setAnnotationsError(annErr.message);
      }
      setAnnotationsLoading(false);
    } catch (err) {
      setFileError(err.message);
    }
    setFileLoading(false);
  }, [project.id, expandToPath, resetAnnotationState]);

  // Scroll to the pending target line once a file finishes rendering.
  useEffect(() => {
    if (pendingTargetLine === null || !fileMeta || !codeContainerRef.current) return;
    const el = codeContainerRef.current;
    const height = el.scrollHeight / (fileMeta.lineCount || 1);
    el.scrollTop = Math.max(0, (pendingTargetLine - 1) * height);
    setPendingTargetLine(null);
  }, [pendingTargetLine, fileContent, fileMeta]);

  // Debounced search over content + names.
  useEffect(() => {
    if (mode !== 'search') return;
    const q = searchTerm.trim();
    if (!q) {
      setResults([]);
      setNameResults([]);
      setAnnotationResults([]);
      setSearchError('');
      return;
    }
    setSearching(true);
    setSearchError('');
    const timer = setTimeout(async () => {
      try {
        const data = await searchCode(project.id, q);
        setResults(data.results || []);
        setNameResults(data.nameResults || []);
        setAnnotationResults(data.annotationResults || []);
      } catch (err) {
        setSearchError(err.message);
        setResults([]);
        setNameResults([]);
        setAnnotationResults([]);
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm, mode, project.id]);

  const openContentHit = async (file, line) => {
    setMode('browse');
    await openFile(file);
    setPendingTargetLine(line);
  };

  const refreshAnnotations = useCallback(async (path) => {
    if (!path) return;
    try {
      const ann = await getCodeAnnotations(project.id, path);
      setAnnotations(ann.annotations || []);
      setAnnotationsError('');
    } catch (err) {
      setAnnotationsError(err.message);
    }
  }, [project.id]);

  // Toggle mode: clicking a line sets start, the next sets end (swapping if
  // clicked earlier); further clicks are ignored until cancelled.
  const handleLineClick = useCallback((line) => {
    if (!annotateMode) return;
    if (selStart === null) {
      setSelStart(line);
      setSelEnd(null);
      return;
    }
    if (selEnd === null) {
      setSelEnd(line);
      setComposer({ mode: 'new', note: '' });
      return;
    }
    // Both start and end are already set — ignore further clicks.
  }, [annotateMode, selStart, selEnd]);

  // Subtle background tint for existing annotated ranges and the in-progress
  // selection. Selection highlight takes precedence over annotation tint.
  const backgroundForLine = useCallback(
    (line) => {
      if (selStart !== null) {
        const lo = selEnd === null ? selStart : Math.min(selStart, selEnd);
        const hi = selEnd === null ? selStart : Math.max(selStart, selEnd);
        if (line >= lo && line <= hi) return 'rgba(64, 132, 255, 0.18)';
      }
      if (annotations.some((a) => line >= a.line_start && line <= a.line_end)) {
        return 'rgba(255, 198, 80, 0.12)';
      }
      return undefined;
    },
    [selStart, selEnd, annotations]
  );

  const addComposerTag = () => {
    const t = composerTagsInput.trim();
    if (!t) return;
    setComposerTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
    setComposerTagsInput('');
  };

  const removeComposerTag = (tag) => {
    setComposerTags((prev) => prev.filter((t) => t !== tag));
  };

  const saveComposer = async () => {
    const note = (composer?.note || '').trim();
    if (!note) return;
    setAnnotationsLoading(true);
    setAnnotationsError('');
    try {
      if (composer.mode === 'edit') {
        await updateCodeAnnotation(project.id, composer.id, { note, tags: composerTags });
      } else {
        await createCodeAnnotation(project.id, {
          file: selectedFile,
          line_start: Math.min(selStart, selEnd),
          line_end: Math.max(selStart, selEnd),
          note,
          tags: composerTags,
        });
      }
      await refreshAnnotations(selectedFile);
      resetAnnotationState();
    } catch (err) {
      setAnnotationsError(err.message);
    }
    setAnnotationsLoading(false);
  };

  const openAnnotation = async (annotation) => {
    setMode('browse');
    await openFile(annotation.file_path);
    setPendingTargetLine(annotation.line_start);
    setExpandedCards((prev) => new Set(prev).add(annotation.id));
  };

  const startEdit = (annotation) => {
    setComposer({
      mode: 'edit',
      id: annotation.id,
      note: annotation.note,
      rangeStart: annotation.line_start,
      rangeEnd: annotation.line_end,
    });
    setComposerTags(annotation.tags || []);
    setComposerTagsInput('');
  };

  const removeAnnotation = async (annotation) => {
    setAnnotationsLoading(true);
    setAnnotationsError('');
    try {
      await deleteCodeAnnotation(project.id, annotation.id);
      await refreshAnnotations(selectedFile);
    } catch (err) {
      setAnnotationsError(err.message);
    }
    setAnnotationsLoading(false);
  };

  // Escape cancels annotate mode and clears the in-progress selection.
  useEffect(() => {
    if (!annotateMode) return;
    const onKey = (e) => {
      if (e.key === 'Escape') resetAnnotationState();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [annotateMode, resetAnnotationState]);

  const crumbs = useMemo(() => {
    const dir = selectedFile.includes('/') ? selectedFile.slice(0, selectedFile.lastIndexOf('/')) : '';
    return ancestors(dir);
  }, [selectedFile]);

  const handleCrumb = (p) => {
    expandToPath(p);
  };

  const toggleFolder = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const showTree = mode === 'browse';
  const noFolder = !project.folder_path;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {/* Toolbar */}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search code or file names…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onFocus={() => setMode('search')}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Button
          size="small"
          variant={showTree ? 'contained' : 'outlined'}
          onClick={() => setMode('browse')}
        >
          Tree
        </Button>
        <Button
          size="small"
          variant={!showTree ? 'contained' : 'outlined'}
          onClick={() => setMode('search')}
          disabled={!searchTerm.trim()}
        >
          Results
        </Button>
      </Box>

      {noFolder ? (
        <Alert severity="warning">
          This project has no associated git repository folder. Set one in Settings to browse code.
        </Alert>
      ) : treeError ? (
        <Alert severity="error">{treeError}</Alert>
      ) : (
        <Box sx={{ display: 'flex', gap: 2, height: '65vh', minHeight: 400 }}>
          {/* Left: tree */}
          <Box
            sx={{
              width: { xs: 240, md: 300 },
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                px: 1,
                py: 0.5,
                borderBottom: '1px solid',
                borderColor: 'divider',
                gap: 0.5,
              }}
            >
              <IconButton size="small" onClick={() => { setExpanded(new Set()); setSelectedFile(''); }}>
                <HomeIcon fontSize="small" />
              </IconButton>
              <Breadcrumbs maxItems={4} sx={{ flex: 1, minWidth: 0 }}>
                {crumbs.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">/</Typography>
                ) : (
                  crumbs.map((crumb, i) => (
                    <Link
                      key={crumb}
                      component="button"
                      variant="body2"
                      underline={i === crumbs.length - 1 ? 'none' : 'hover'}
                      color={i === crumbs.length - 1 ? 'text.primary' : 'primary'}
                      onClick={() => handleCrumb(crumb)}
                      sx={{ cursor: 'pointer', fontSize: '0.78rem', textTransform: 'none' }}
                    >
                      {crumb.split('/').pop()}
                    </Link>
                  ))
                )}
              </Breadcrumbs>
            </Box>
            {treeLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={28} />
              </Box>
            ) : tree.children.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No tracked files in this repository.
              </Typography>
            ) : (
              <List dense disablePadding>
                {tree.children.map((node) => (
                  <TreeNode
                    key={node.path}
                    node={node}
                    expanded={expanded}
                    onToggle={toggleFolder}
                    onOpen={openFile}
                  />
                ))}
              </List>
            )}
          </Box>

          {/* Right: file view */}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {!selectedFile ? (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Select a file to preview.
                </Typography>
              </Box>
            ) : fileLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
                <CircularProgress size={28} />
              </Box>
            ) : fileError ? (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, p: 2 }}>
                <Alert severity="warning">{fileError}</Alert>
              </Box>
            ) : (
              <>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    px: 1.5,
                    py: 0.75,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'action.selected',
                    gap: 1,
                  }}
                >
                  <DescriptionIcon fontSize="small" color="action" />
                  <Typography
                    variant="body2"
                    sx={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={selectedFile}
                  >
                    {selectedFile}
                  </Typography>
                  {fileMeta?.lineCount != null && (
                    <Chip size="small" label={`${fileMeta.lineCount} lines`} variant="outlined" />
                  )}
                  <Button
                    size="small"
                    variant={annotateMode ? 'contained' : 'outlined'}
                    color={annotateMode ? 'primary' : 'inherit'}
                    onClick={() => (annotateMode ? resetAnnotationState() : setAnnotateMode(true))}
                    startIcon={<NoteAddIcon fontSize="small" />}
                  >
                    {annotateMode ? 'Cancel' : 'Annotate'}
                  </Button>
                </Box>
                <Box ref={codeContainerRef} sx={{ flex: 1, overflow: 'auto', cursor: annotateMode ? 'pointer' : 'auto' }}>
                  <SyntaxHighlighter
                    style={vscDarkPlus}
                    language={languageForPath(selectedFile)}
                    showLineNumbers
                    wrapLines
                    lineProps={(line) => ({
                      'data-line': line,
                      onClick: annotateMode ? () => handleLineClick(line) : undefined,
                      style: { background: backgroundForLine(line) },
                    })}
                    lineNumberStyle={{ minWidth: '3.5em', userSelect: 'none' }}
                    customStyle={{ margin: 0, fontSize: '0.82rem', borderRadius: 0 }}
                  >
                    {fileContent}
                  </SyntaxHighlighter>
                </Box>
              </>
            )}
          </Box>

          {/* Right sidebar: annotations (only in browse mode with a file previewed) */}
          {mode === 'browse' && selectedFile && !fileLoading && !fileError && (
            <Box
              sx={{
                width: 320,
                flexShrink: 0,
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  px: 1.5,
                  py: 0.75,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'action.selected',
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
                  Annotations
                </Typography>
                <Chip size="small" label={`${annotations.length}`} variant="outlined" />
              </Box>
              <Box sx={{ flex: 1, overflow: 'auto', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                {annotationsError && <Alert severity="warning" sx={{ py: 0.5 }}>{annotationsError}</Alert>}

                {/* Composer (new selection or editing an existing annotation) */}
                {composer && (
                  <Box sx={{ border: '1px solid', borderColor: 'primary.main', borderRadius: 1, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <Typography variant="caption" color="primary" sx={{ fontWeight: 600 }}>
                      {composer.mode === 'edit'
                        ? `Edit annotation L${composer.rangeStart}-L${composer.rangeEnd}`
                        : selStart !== null && selEnd !== null
                          ? `New annotation L${Math.min(selStart, selEnd)}-L${Math.max(selStart, selEnd)}`
                          : 'Select a line range in the code'}
                    </Typography>
                    <TextField
                      size="small"
                      fullWidth
                      multiline
                      minRows={2}
                      placeholder="Note…"
                      value={composer.note || ''}
                      onChange={(e) => setComposer({ ...composer, note: e.target.value })}
                    />
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                      {composerTags.map((tag) => (
                        <Chip
                          key={tag}
                          size="small"
                          label={tag}
                          onDelete={() => removeComposerTag(tag)}
                        />
                      ))}
                    </Box>
                    <TextField
                      size="small"
                      fullWidth
                      placeholder="Add tag… (Enter or , to add)"
                      value={composerTagsInput}
                      onChange={(e) => setComposerTagsInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          addComposerTag();
                        }
                      }}
                    />
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Button
                        size="small"
                        variant="contained"
                        onClick={saveComposer}
                        disabled={annotationsLoading || !(composer?.note || '').trim()}
                      >
                        Save
                      </Button>
                      <Button
                        size="small"
                        onClick={() => resetAnnotationState()}
                        disabled={annotationsLoading}
                      >
                        Cancel
                      </Button>
                    </Box>
                  </Box>
                )}

                {annotationsLoading ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress size={24} />
                  </Box>
                ) : annotations.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No annotations yet. Click <strong>Annotate</strong> and select a line range.
                  </Typography>
                ) : (
                  annotations.map((annotation) => {
                    const expanded = expandedCards.has(annotation.id);
                    return (
                      <Box
                        key={annotation.id}
                        sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}
                      >
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            px: 1,
                            py: 0.5,
                            bgcolor: 'action.hover',
                            gap: 0.5,
                          }}
                        >
                          <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 600, flex: 1 }}>
                            L{annotation.line_start}-L{annotation.line_end}
                          </Typography>
                          <IconButton size="small" onClick={() => startEdit(annotation)} title="Edit">
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" onClick={() => removeAnnotation(annotation)} title="Delete">
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            onClick={() =>
                              setExpandedCards((prev) => {
                                const next = new Set(prev);
                                if (next.has(annotation.id)) next.delete(annotation.id);
                                else next.add(annotation.id);
                                return next;
                              })
                            }
                            title={expanded ? 'Collapse' : 'Expand'}
                          >
                            {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                          </IconButton>
                        </Box>
                        <Box sx={{ px: 1.25, py: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                          <Typography
                            variant="body2"
                            sx={{
                              whiteSpace: expanded ? 'pre-wrap' : 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              fontSize: '0.82rem',
                            }}
                          >
                            {annotation.note}
                          </Typography>
                          {(annotation.tags || []).length > 0 && (
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                              {(annotation.tags || []).map((tag) => (
                                <Chip key={tag} size="small" label={tag} variant="outlined" />
                              ))}
                            </Box>
                          )}
                        </Box>
                      </Box>
                    );
                  })
                )}
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* Search results (shown instead of the two-panel layout when searching) */}
      {!noFolder && mode === 'search' && (
        <Box sx={{ height: '65vh', minHeight: 400, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
          {searchError ? (
            <Alert severity="error">{searchError}</Alert>
          ) : searching ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={28} />
            </Box>
          ) : !searchTerm.trim() ? (
            <Typography variant="body2" color="text.secondary">
              Type a term above to search file contents and names.
            </Typography>
          ) : results.length === 0 && nameResults.length === 0 && annotationResults.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No matches for “{searchTerm.trim()}”.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {nameResults.length > 0 && (
                <Box>
                  <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600 }}>
                    Files ({nameResults.length})
                  </Typography>
                  <List dense disablePadding>
                    {nameResults.map((file) => (
                      <ListItem
                        key={file}
                        button
                        dense
                        onClick={() => openFile(file)}
                        sx={{ borderRadius: 0.5 }}
                      >
                        <ListItemIcon sx={{ minWidth: 30 }}>
                          <DescriptionIcon fontSize="small" color="action" />
                        </ListItemIcon>
                        <ListItemText primary={file} primaryTypographyProps={{ noWrap: true, fontSize: '0.85rem', fontFamily: 'monospace' }} />
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
              {results.length > 0 && (
                <Box>
                  <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600 }}>
                    Content ({results.length})
                  </Typography>
                  <List dense disablePadding>
                    {results.map((hit, idx) => (
                      <ListItem
                        key={`${hit.file}:${hit.line}:${idx}`}
                        button
                        dense
                        onClick={() => openContentHit(hit.file, hit.line)}
                        sx={{ borderRadius: 0.5, alignItems: 'flex-start', py: 0.5 }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'primary.main', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {hit.file}:{hit.line}
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {hit.text}
                          </Typography>
                        </Box>
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
              {annotationResults.length > 0 && (
                <Box>
                  <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600 }}>
                    Annotations ({annotationResults.length})
                  </Typography>
                  <List dense disablePadding>
                    {annotationResults.map((annotation) => (
                      <ListItem
                        key={annotation.id}
                        button
                        dense
                        onClick={() => openAnnotation(annotation)}
                        sx={{ borderRadius: 0.5, alignItems: 'flex-start', py: 0.5 }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'primary.main', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {annotation.file_path}:L{annotation.line_start}-L{annotation.line_end}
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {annotation.note}
                          </Typography>
                        </Box>
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
