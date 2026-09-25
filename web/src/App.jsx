import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Box, CssBaseline } from '@mui/material';
import Sidebar from './components/Sidebar';
import Chat from './components/Chat';
import ProjectModal from './components/ProjectModal';
import ProjectPage from './components/ProjectPage';
import SettingsPage from './components/SettingsPage';
import { getProjects, createProject, deleteProject, updateProject } from './api/projects';
import { getConversations, createConversation, deleteConversation, updateConversation, getConversation, getConversationGitState } from './api/conversations';
import chatStore from './stores/chatStore';

const App = observer(function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [viewMode, setViewMode] = useState('chat'); // 'chat' | 'project' | 'settings'
  const [viewingProject, setViewingProject] = useState(null);
  const [editingProject, setEditingProject] = useState(null);
  const [newlyCreatedProject, setNewlyCreatedProject] = useState(null);

  // Load projects on mount
  useEffect(() => {
    async function load() {
      const data = await getProjects();
      // Preload conversations for all projects so sidebar counts are accurate from the start
      const projectsWithConvs = await Promise.all(
        (data || []).map(async (p) => {
          try {
            const convs = await getConversations(p.id);
            chatStore.observeConversations(convs);
            return { ...p, conversations: convs };
          } catch (e) {
            console.error('Failed to load conversations for project', p.id, e);
            return { ...p, conversations: [] };
          }
        })
      );
      setProjects(projectsWithConvs);
    }
    load();
  }, []);

  // Connect WebSocket and listen for events
  useEffect(() => {
    chatStore.initialize();
  }, []);

  // Quando mudamos o projeto selecionado, carregar suas conversas
  useEffect(() => {
    if (!selectedProject) return;
    async function loadConv() {
      const convs = await getConversations(selectedProject.id);
      chatStore.observeConversations(convs);
      setProjects((prev) =>
        prev.map((p) => (p.id === selectedProject.id ? { ...p, conversations: convs } : p))
      );
    }
    loadConv();
  }, [selectedProject?.id]);

  const handleToggleSidebar = () => setSidebarExpanded((prev) => !prev);

  // Notify store when active conversation changes (for unread tracking)
  const handleSetSelectedConversation = async (conv) => {
    chatStore.clearFocusView();
    chatStore.setActiveConversation(conv?.id || null);
    setViewMode('chat');
    setViewingProject(null);

    if (conv?.id) {
      try {
        const latest = await getConversation(conv.id);
        setSelectedConversation(latest);
        setProjects((prev) =>
          prev.map((p) => ({
            ...p,
            conversations: (p.conversations || []).map((c) => (c.id === latest.id ? latest : c)),
          }))
        );
      } catch (e) {
        console.error('Failed to reload conversation metadata on switch:', e);
        setSelectedConversation(conv);
      }
    } else {
      setSelectedConversation(conv);
    }
  };


  const handleSelectProject = async (proj) => {
    if (proj === 'add') {
      const newProj = await createProject('New Project', null);
      setProjects((prev) => [newProj, ...prev]);
      setViewMode('project');
      setViewingProject(newProj);
      setSelectedProject(null);
      setSelectedConversation(null);
    } else if (proj === 'settings') {
      setViewMode('settings');
      setViewingProject(null);
      setSelectedProject(null);
      setSelectedConversation(null);
    }
  };

  const handleAddConversation = async (projectId) => {
    const title = prompt('Nome da nova conversa');
    if (!title) return;
    const conv = await createConversation(projectId, title);
    // atualizar estado
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, conversations: [...(p.conversations || []), conv] } : p
      )
    );

    // If on the project page, also update viewingProject so the conversation list updates
    if (viewingProject?.id === projectId) {
      setViewingProject((prev) =>
        prev ? { ...prev, conversations: [...(prev.conversations || []), conv] } : prev
      );
    }
  };

  const handleOpenProject = (project) => {
    openProjectPage(project);
  };

  const handleLoadProjectConversations = async (projectId) => {
    try {
      const convs = await getConversations(projectId);
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId ? { ...p, conversations: convs } : p
        )
      );
    } catch (e) {
      console.error('Failed to load conversations for sidebar', e);
    }
  };

  const openProjectPage = async (project) => {
    setViewMode('project');
    setViewingProject(project);
    setSelectedProject(null);
    setSelectedConversation(null);

    // Ensure project conversations are loaded for the sidebar
    try {
      const convs = await getConversations(project.id);
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? { ...p, conversations: convs } : p
        )
      );
    } catch (e) {
      console.error('Failed to load conversations for sidebar', e);
    }
  };

  const handleDeleteProject = async (project) => {
    if (!confirm(`Delete project "${project.name}" and all its conversations?`)) return;
    await deleteProject(project.id);
    setProjects(prev => prev.filter(p => p.id !== project.id));
    // If the project page was open for this project, return to chat
    if (viewingProject?.id === project.id) {
      setViewingProject(null);
      setViewMode('chat');
    }
    if (selectedProject?.id === project.id) {
      setSelectedProject(null);
      setSelectedConversation(null);
    }
  };

  const handleDeleteConversation = async (conversation) => {
    if (conversation?.conversation_type === 'project') {
      console.warn('Project Memory conversation cannot be deleted');
      return;
    }

    let gitState = null;
    try {
      gitState = await getConversationGitState(conversation.id);
    } catch (error) {
      console.error('Error loading git state for delete confirmation:', error);
    }

    const hasUnmergedWork = Boolean(gitState?.hasCommitsToMerge) || Number(gitState?.ahead || 0) > 0 || Boolean(gitState?.hasUncommittedChanges);
    const safeLabel = hasUnmergedWork ? 'Unsafe' : 'Safe';
    const warning = hasUnmergedWork
      ? 'There is still unmerged work; deleting may cause these changes to be lost.'
      : 'Changes have already been merged; deletion should not cause data loss.';
    const confirmed = window.confirm(`Are you sure you want to delete the conversation "${conversation.title}"?\nStatus: ${safeLabel}\n${warning}\n\nThis action cannot be undone.`);
    if (!confirmed) return;

    await deleteConversation(conversation.id);
    chatStore.clearFocusView();
    chatStore.cleanupConversationState(conversation.id);
    // Remove conversation from ALL projects' conversation lists (works regardless of selectedProject state)
    setProjects(prev =>
      prev.map(p => ({
        ...p,
        conversations: (p.conversations || []).filter(c => c.id !== conversation.id)
      }))
    );
    if (selectedConversation?.id === conversation.id) {
      setSelectedConversation(null);
    }
  };

  const handleEditConversation = async (conversation) => {
    if (conversation?.conversation_type === 'project') {
      console.warn('Project Memory conversation title is fixed');
      return;
    }
    const newTitle = prompt('New title for conversation', conversation.title);
    if (!newTitle || newTitle === conversation.title) return;
    const updated = await updateConversation(conversation.id, newTitle);
    // update state
    if (selectedProject) {
      setProjects(prev =>
        prev.map(p =>
          p.id === selectedProject.id
            ? { ...p, conversations: p.conversations.map(c => c.id === updated.id ? updated : c) }
            : p
        )
      );
    }
    if (selectedConversation?.id === updated.id) {
      setSelectedConversation(updated);
    }
  };

  const handleConversationUpdated = (updatedConversation) => {
    // Update selected conversation
    setSelectedConversation(updatedConversation);
    // Update conversation in projects list
    if (!selectedProject) return;
    setProjects(prev =>
      prev.map(p =>
        p.id === selectedProject.id
          ? { ...p, conversations: p.conversations.map(c => c.id === updatedConversation.id ? updatedConversation : c) }
          : p
      )
    );
  };

  const handleConversationDeleted = (deletedConversation) => {
    chatStore.clearFocusView();
    chatStore.cleanupConversationState(deletedConversation.id);
    // Clear selected conversation if it was the deleted one
    if (selectedConversation?.id === deletedConversation.id) {
      setSelectedConversation(null);
    }
    // Remove conversation from ALL projects' conversation lists (works regardless of selectedProject state)
    setProjects(prev =>
      prev.map(p => ({
        ...p,
        conversations: (p.conversations || []).filter(c => c.id !== deletedConversation.id)
      }))
    );
  };

  const handleConversationsChanged = async (projectId) => {
    const pid = projectId || selectedProject?.id || selectedConversation?.project_id;
    if (!pid) return;
    try {
      const convs = await getConversations(pid);
      chatStore.observeConversations(convs);
      setProjects(prev =>
        prev.map(p => (p.id === pid ? { ...p, conversations: convs } : p))
      );
      if (viewingProject?.id === pid) {
        setViewingProject(prev => (prev ? { ...prev, conversations: convs } : prev));
      }
    } catch (e) {
      console.error('Failed to reload conversations after change', e);
    }
  };

  const handleProjectSaved = async (name, folderPath) => {
    if (editingProject) {
      // editing
      const updated = await updateProject(editingProject.id, name, folderPath);
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      // actualizar o projecto em editing
      if (viewingProject?.id === updated.id) setViewingProject(updated);
      if (selectedProject?.id === updated.id) setSelectedProject(updated);
    } else {
      // creation
      const newProj = await createProject(name, folderPath);
      setProjects((prev) => [newProj, ...prev]);
      // open the settings page of the new project directly
      setNewlyCreatedProject(newProj);
      setViewMode('project');
      setViewingProject(newProj);
      setSelectedProject(null);
      setSelectedConversation(null);
    }
    setShowProjectModal(false);
    setEditingProject(null);
  };

  return (
    <>
      <CssBaseline />
      <Box sx={{ display: 'flex', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <Sidebar
          projects={projects}
          expanded={sidebarExpanded}
          onToggleExpanded={handleToggleSidebar}
          onSelectProject={handleSelectProject}
          onAddConversation={handleAddConversation}
          onOpenProject={handleOpenProject}
          onLoadProjectConversations={handleLoadProjectConversations}
          onEditConversation={handleEditConversation}
          onDeleteConversation={handleDeleteConversation}
          onSelectConversation={handleSetSelectedConversation}
          selectedConversationId={selectedConversation?.id}
          aiGeneratingConversations={chatStore.aiGeneratingConversationIds}
          unreadConversationIds={chatStore.unreadConversationIds}
          pendingApprovalConversationIds={chatStore.pendingApprovalConversationIds}
          conversationStatuses={chatStore.conversationStatusById}
        />
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'background.default',
            overflow: 'hidden',
          }}
        >
          {viewMode === 'settings' ? (
            <SettingsPage
              onClose={() => {
                setViewMode('chat');
              }}
            />
          ) : viewMode === 'project' && viewingProject ? (
            <ProjectPage
              project={viewingProject}
              onClose={() => {
                setViewMode('chat');
                setViewingProject(null);
              }}
              onDeleteProject={handleDeleteProject}
              onProjectUpdated={(updated) => {
                setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
                setViewingProject(updated);
                if (selectedProject?.id === updated.id) setSelectedProject(updated);
              }}
              onAddConversation={handleAddConversation}
              onEditConversation={handleEditConversation}
              onDeleteConversation={handleDeleteConversation}
              onSelectConversation={async (conv) => {
                // when clicking a conversation inside the project page,
                // voltamos ao modo chat e recarregamos metadados da conversa
                chatStore.clearFocusView();
                chatStore.setActiveConversation(conv?.id || null);
                setViewMode('chat');
                setViewingProject(null);

                if (conv?.id) {
                  try {
                    const latest = await getConversation(conv.id);
                    setSelectedConversation(latest);
                    setProjects((prev) =>
                      prev.map((p) => ({
                        ...p,
                        conversations: (p.conversations || []).map((c) => (c.id === latest.id ? latest : c)),
                      }))
                    );
                  } catch (e) {
                    console.error('Failed to reload conversation metadata from project page:', e);
                    setSelectedConversation(conv);
                  }
                } else {
                  setSelectedConversation(conv);
                }
              }}
              selectedConversationId={selectedConversation?.id}
              aiGeneratingConversations={chatStore.aiGeneratingConversationIds}
            />
          ) : (
            <Chat
              project={selectedProject}
              conversation={selectedConversation}
              onSelectConversation={setSelectedConversation}
              onConversationUpdated={handleConversationUpdated}
              onConversationDeleted={handleConversationDeleted}
              onToggleSidebar={handleToggleSidebar}
              onOpenConversation={handleSetSelectedConversation}
              onConversationsChanged={handleConversationsChanged}
            />
          )}
        </Box>
      </Box>
      {showProjectModal && (
        <ProjectModal
          open={showProjectModal}
          onClose={() => {
            setShowProjectModal(false);
            setEditingProject(null);
          }}
          onSave={handleProjectSaved}
          project={editingProject}
        />
      )}
    </>
  );
});

export default App;
