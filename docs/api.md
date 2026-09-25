# API Documentation

This document describes the REST endpoints and real-time communication interfaces exposed by MiniBoss.

## Base URL

All REST endpoints are served under:

```
http://<host>:<port>/api
```

The default server port is `3001` and the default bind host is `127.0.0.1`. These can be changed with `PORT` and `HOST` environment variables.

## Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Returns server health status |

## Real-Time Communication

The server uses Socket.IO for live events. The Socket.IO endpoint path is:

```
/api/socket.io
```

Client-side socket usage is defined in `web/src/socketService.js`.

## REST Endpoints

### Projects API

Base path: `/api/projects`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List projects |
| GET | `/:id` | Get a project |
| POST | `/` | Create a project |
| PUT | `/:id` | Update a project |
| DELETE | `/:id` | Delete a project |
| GET | `/:id/extra-files/search` | Search extra files by name |
| GET | `/:id/extra-files/selected` | Get selected extra files |
| PUT | `/:id/extra-files/selected` | Set selected extra files |
| GET | `/:projectId/conversations` | List project conversations |
| POST | `/:projectId/conversations` | Create a project conversation |

### Conversations API

Base path: `/api/conversations`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:id` | Get a conversation |
| PUT | `/:id` | Update conversation title |
| PUT | `/:id/model` | Update conversation model/provider |
| DELETE | `/:id` | Delete a conversation |
| GET | `/:id/context` | Get conversation context metadata |
| GET | `/:id/parent` | Get parent conversation |
| GET | `/:id/sub-conversations` | List sub-conversations |
| GET | `/:id/focus-conversations` | List focus conversations |
| GET | `/:id/focus-tree` | Get focus tree |
| POST | `/:id/cancel` | Cancel active operation |
| POST | `/:id/clear` | Clear messages |
| GET | `/:id/git` | Get git state |
| GET | `/:id/git/diff` | Get git diff |
| POST | `/:id/git/commit` | Commit changes |
| POST | `/:id/git/merge` | Merge branch |
| POST | `/:id/git/reset` | Reset worktree |
| POST | `/:id/index` | Index project and worktree |
| POST | `/:id/reindex` | Re-index changed files |
| GET | `/:id/index-status` | Get indexing status |
| GET | `/:id/tasks` | Get task tree |
| GET | `/:id/plan` | Get conversation plan |
| PUT | `/:id/plan` | Update conversation plan |
| POST | `/:id/execute-plan` | Execute a conversation plan |
| PUT | `/:id/mode` | Update conversation mode |

### Messages API

Base path: `/api/messages`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations/:conversationId/messages` | List messages |
| DELETE | `/:id` | Delete a message |

### Providers API

Base path: `/api/providers`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List providers |
| GET | `/active` | Get active provider |
| GET | `/:id` | Get a provider |
| POST | `/` | Create a provider |
| PUT | `/:id` | Update a provider |
| DELETE | `/:id` | Delete a provider |
| POST | `/:id/activate` | Set active provider |

### AI API

Base path: `/api/ai`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models/:providerId` | Fetch models from provider |
| POST | `/search/index-project` | Index project files |
| POST | `/search/index-worktree` | Index worktree files |
| POST | `/search` | Semantic search |
| GET | `/search/status` | Get index status |

### Settings API

Base path: `/api/settings`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:key` | Get a setting |
| POST | `/` | Create or update a setting |

### Search API

Base path: `/api/search`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status` | Get indexing status |
| POST | `/index-project` | Index project |
| POST | `/index-worktree` | Index worktree |
| POST | `/` | Semantic search |

### Sandbox API

Base path: `/api/sandbox`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/paths` | List sandbox paths |
| POST | `/paths` | Add sandbox path |
| PUT | `/paths/:id` | Update sandbox path |
| DELETE | `/paths/:id` | Remove sandbox path |
| GET | `/browse` | Browse directory entries |
